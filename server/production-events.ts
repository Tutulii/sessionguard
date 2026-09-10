import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { XMLParser } from "fast-xml-parser";
import {
  OfficialEventV1Schema,
  type EvidenceSegment,
  type OfficialEventV1,
} from "../shared/agent-types.js";
import type { ProductionSymbol } from "../shared/production-types.js";
import type { AgentRepository } from "./agent-repository.js";

export const officialIssuers: ReadonlyArray<{
  symbol: ProductionSymbol;
  cik: string;
  name: string;
  irFeedEnv: string;
  irAllowlistEnv: string;
}> = Object.freeze([
  { symbol: "RNVDAUSDT", cik: "0001045810", name: "NVIDIA", irFeedEnv: "IR_FEED_NVDA", irAllowlistEnv: "IR_ALLOWED_HOSTS_NVDA" },
  { symbol: "RTSLAUSDT", cik: "0001318605", name: "Tesla", irFeedEnv: "IR_FEED_TSLA", irAllowlistEnv: "IR_ALLOWED_HOSTS_TSLA" },
  { symbol: "RORCLUSDT", cik: "0001341439", name: "Oracle", irFeedEnv: "IR_FEED_ORCL", irAllowlistEnv: "IR_ALLOWED_HOSTS_ORCL" },
]);

const trackedForms = new Set(["8-K", "10-Q", "10-K", "6-K"]);
const maxDocumentBytes = 2 * 1024 * 1024;
const maxStoredCharacters = 64_000;

export type OfficialSourceHealth = { status: "HEALTHY" | "DEGRADED"; checkedAt: string | null; errors: string[] };
type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

function sha(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }

export function deterministicUuid(value: string) {
  const hex = sha(value).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = (["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4]);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function decodeEntities(value: string) {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&#(x?[0-9a-f]+);|&([a-z]+);/gi, (_match, numeric: string, named: string) => {
    if (numeric) {
      const code = Number.parseInt(numeric.replace(/^x/i, ""), /^x/i.test(numeric) ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    }
    return entities[named.toLowerCase()] ?? " ";
  });
}

export function normalizeOfficialDocument(input: string) {
  const withoutActive = input
    .replace(/<(script|style|form|noscript|svg|canvas|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+(?:hidden|aria-hidden\s*=\s*["']?true|display\s*:\s*none)[^>]*>[\s\S]*?<\/[^>]+>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<\/?(?:p|div|section|article|h[1-6]|li|tr|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutActive).replace(/\r/g, "").replace(/[\t ]+/g, " ")
    .replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxStoredCharacters);
}

export function evidenceSegments(text: string): EvidenceSegment[] {
  const segments: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)) {
    for (let offset = 0; offset < paragraph.length; offset += 1_800) {
      const chunk = paragraph.slice(offset, offset + 1_800);
      if (current && current.length + chunk.length + 2 > 1_800) { segments.push(current); current = ""; }
      current = current ? `${current}\n\n${chunk}` : chunk;
    }
  }
  if (current) segments.push(current);
  return segments.slice(0, 40).map((segment, index) => ({ id: `seg-${index + 1}-${sha(segment).slice(0, 12)}`, index,
    hash: sha(segment), text: segment }));
}

export function canonicalSourceUrl(raw: string, allowedHosts?: Set<string>) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("OFFICIAL_SOURCE_URL_REJECTED");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (allowedHosts && !allowedHosts.has(host)) throw new Error("OFFICIAL_SOURCE_HOST_REJECTED");
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_|trk$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

export function isPublicAddress(address: string) {
  if (!isIP(address)) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8:")) return false;
  if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
  if (normalized.includes(":")) return true;
  const parts = normalized.split(".").map(Number);
  return !(parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 192 && (parts[1] === 0 || parts[1] === 168)) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100))) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113));
}

async function defaultLookup(hostname: string) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function assertPublicHost(hostname: string, lookup: Lookup) {
  const addresses = await lookup(hostname);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("OFFICIAL_SOURCE_PRIVATE_ADDRESS_REJECTED");
}

async function boundedText(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxDocumentBytes) throw new Error("OFFICIAL_SOURCE_TOO_LARGE");
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType && !/^(text\/|application\/(?:json|xml|atom\+xml|rss\+xml|xhtml\+xml))/.test(contentType)) {
    throw new Error("OFFICIAL_SOURCE_CONTENT_TYPE_REJECTED");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxDocumentBytes) throw new Error("OFFICIAL_SOURCE_TOO_LARGE");
    return new TextDecoder().decode(bytes);
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > maxDocumentBytes) { await reader.cancel(); throw new Error("OFFICIAL_SOURCE_TOO_LARGE"); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function fetchAllowlistedHttps(input: string, allowedHosts: Set<string>, options: {
  fetcher?: typeof fetch;
  lookup?: Lookup;
  headers?: Record<string, string>;
  etag?: string;
  modified?: string;
} = {}) {
  const fetcher = options.fetcher ?? fetch; const lookup = options.lookup ?? defaultLookup;
  let target = canonicalSourceUrl(input, allowedHosts);
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    const url = new URL(target); await assertPublicHost(url.hostname, lookup);
    const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: {
      accept: "application/rss+xml, application/atom+xml, application/xml, text/html, application/json",
      ...(options.etag ? { "if-none-match": options.etag } : {}),
      ...(options.modified ? { "if-modified-since": options.modified } : {}),
      ...options.headers,
    } });
    if (response.status === 304) return { notModified: true as const, text: "", url: target, etag: options.etag, modified: options.modified };
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 2) throw new Error("OFFICIAL_SOURCE_TOO_MANY_REDIRECTS");
      const location = response.headers.get("location"); if (!location) throw new Error("OFFICIAL_SOURCE_REDIRECT_WITHOUT_LOCATION");
      target = canonicalSourceUrl(new URL(location, target).toString(), allowedHosts); continue;
    }
    if (!response.ok) throw new Error(`OFFICIAL_SOURCE_HTTP_${response.status}`);
    return { notModified: false as const, text: await boundedText(response), url: target,
      etag: response.headers.get("etag") ?? undefined, modified: response.headers.get("last-modified") ?? undefined };
  }
  throw new Error("OFFICIAL_SOURCE_REDIRECT_FAILED");
}

function normalizeSecTimestamp(accepted: string | undefined, filingDate: string) {
  const value = accepted?.trim();
  if (value) {
    const parsed = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(`${filingDate}T12:00:00Z`).toISOString();
}

function asArray<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

function eventFromDocument(input: {
  symbol: ProductionSymbol; sourceType: "SEC_EDGAR" | "ISSUER_IR"; formType: OfficialEventV1["formType"];
  accessionId: string; url: string; title: string; publishedAt: string; detectedAt: string; document: string;
  supersedesEventId?: string | null;
}) {
  const normalizedText = normalizeOfficialDocument(input.document || input.title);
  if (!normalizedText) throw new Error("OFFICIAL_SOURCE_EMPTY_DOCUMENT");
  const documentHash = sha(input.document); const contentHash = sha(`${input.title}\n${normalizedText}`);
  const id = deterministicUuid(`${input.sourceType}:${input.accessionId}`);
  const cautionFlags: OfficialEventV1["cautionFlags"] = [];
  if (/\b(suspend(?:ed|sion)?|trading pause|halt(?:ed)?)\b/i.test(normalizedText)) cautionFlags.push("POSSIBLE_SUSPENSION_LANGUAGE");
  if (/\b(correction|corrected|amendment|amended)\b/i.test(`${input.title} ${normalizedText.slice(0, 2_000)}`)) cautionFlags.push("CORRECTION");
  if (new Date(input.detectedAt).getTime() - new Date(input.publishedAt).getTime() > 5 * 60_000) cautionFlags.push("LATE_DETECTION");
  return OfficialEventV1Schema.parse({ version: 1, id, versionId: deterministicUuid(`${id}:${contentHash}`), symbol: input.symbol,
    sourceType: input.sourceType, formType: input.formType, accessionId: input.accessionId,
    canonicalUrl: input.url, title: input.title, publishedAt: input.publishedAt, effectiveAt: input.publishedAt,
    detectedAt: input.detectedAt, contentHash, documentHash, normalizedText, evidence: evidenceSegments(normalizedText),
    cautionFlags, supersedesEventId: input.supersedesEventId ?? null, supersededByEventId: null });
}

export class ProductionOfficialEventWatcher {
  private readonly validators = new Map<string, { etag?: string; modified?: string }>();
  private readonly failures = new Map<string, number>();
  private readonly retryAfter = new Map<string, number>();
  private sourceHealth: OfficialSourceHealth = { status: "HEALTHY", checkedAt: null, errors: [] };

  constructor(private readonly repository: AgentRepository, private readonly options: { fetcher?: typeof fetch; lookup?: Lookup; now?: () => Date; maxTriggerAgeMs?: number } = {}) {}

  health() { return { ...this.sourceHealth, errors: [...this.sourceHealth.errors] }; }

  async poll() {
    const now = this.options.now?.() ?? new Date(); const detectedAt = now.toISOString();
    const tasks = officialIssuers.flatMap((issuer) => [
      { key: `sec:${issuer.cik}`, run: () => this.pollSec(issuer, detectedAt) },
      ...this.irTask(issuer, detectedAt).map((run, index) => ({ key: `ir:${issuer.symbol}:${index}`, run })),
    ]);
    const results = await Promise.allSettled(tasks.map(({ key, run }) => this.withBackoff(key, now, run)));
    const events = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : "OFFICIAL_SOURCE_FAILED"] : []);
    const saved: OfficialEventV1[] = [];
    for (const event of events) {
      const result = await this.repository.saveOfficialEvent(event);
      const publicationAgeMs = now.getTime() - new Date(result.event.publishedAt).getTime();
      const triggerable = publicationAgeMs >= -5 * 60_000 && publicationAgeMs <= (this.options.maxTriggerAgeMs ?? 24 * 60 * 60_000);
      if ((result.created || result.changed) && triggerable) saved.push(result.event);
    }
    this.sourceHealth = { status: errors.length ? "DEGRADED" : "HEALTHY", checkedAt: detectedAt, errors: errors.slice(0, 10) };
    return saved;
  }

  private async withBackoff(key: string, now: Date, run: () => Promise<OfficialEventV1[]>) {
    const retryAt = this.retryAfter.get(key) ?? 0;
    if (retryAt > now.getTime()) throw new Error("OFFICIAL_SOURCE_BACKOFF_ACTIVE");
    try {
      const result = await run(); this.failures.delete(key); this.retryAfter.delete(key); return result;
    } catch (error) {
      const failures = Math.min(5, (this.failures.get(key) ?? 0) + 1); this.failures.set(key, failures);
      const base = Math.min(30 * 60_000, 2 * 60_000 * 2 ** (failures - 1));
      const jitter = Number.parseInt(sha(`${key}:${failures}`).slice(0, 4), 16) % Math.max(1, Math.floor(base * 0.1));
      this.retryAfter.set(key, now.getTime() + base + jitter); throw error;
    }
  }

  private irTask(issuer: (typeof officialIssuers)[number], detectedAt: string) {
    const feed = process.env[issuer.irFeedEnv]?.trim();
    return feed ? [() => this.pollIr(issuer, feed, detectedAt)] : [];
  }

  private async request(url: string, allowedHosts: Set<string>, headers: Record<string, string> = {}) {
    const state = this.validators.get(url) ?? {};
    const result = await fetchAllowlistedHttps(url, allowedHosts, { fetcher: this.options.fetcher, lookup: this.options.lookup,
      headers, etag: state.etag, modified: state.modified });
    if (!result.notModified) this.validators.set(url, { etag: result.etag, modified: result.modified });
    return result;
  }

  private async pollSec(issuer: (typeof officialIssuers)[number], detectedAt: string) {
    const userAgent = process.env.SEC_USER_AGENT ?? "SessionGuard security contact security@sessionguard.local";
    const host = new Set(["data.sec.gov"]);
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${issuer.cik}.json`;
    const result = await this.request(submissionsUrl, host, { accept: "application/json", "user-agent": userAgent });
    if (result.notModified) return [];
    const payload = JSON.parse(result.text) as { filings?: { recent?: Record<string, string[]> } };
    const recent = payload.filings?.recent; if (!recent) return [];
    const output: OfficialEventV1[] = [];
    for (let index = 0; index < (recent.form ?? []).length && output.length < 8; index += 1) {
      const form = recent.form?.[index]; if (!trackedForms.has(form)) continue;
      const accession = recent.accessionNumber?.[index]; const primaryDocument = recent.primaryDocument?.[index];
      const filingDate = recent.filingDate?.[index]; if (!accession || !primaryDocument || !filingDate) continue;
      const archiveUrl = canonicalSourceUrl(`https://www.sec.gov/Archives/edgar/data/${Number(issuer.cik)}/${accession.replace(/-/g, "")}/${encodeURIComponent(primaryDocument)}`,
        new Set(["www.sec.gov"]));
      const documentResponse = await this.request(archiveUrl, new Set(["www.sec.gov"]), { accept: "text/html, text/plain", "user-agent": userAgent });
      if (documentResponse.notModified) continue;
      const title = `${issuer.name} ${form}: ${recent.primaryDocDescription?.[index] || "official filing"}`;
      output.push(eventFromDocument({ symbol: issuer.symbol, sourceType: "SEC_EDGAR", formType: form as OfficialEventV1["formType"],
        accessionId: accession, url: archiveUrl, title, publishedAt: normalizeSecTimestamp(recent.acceptanceDateTime?.[index], filingDate),
        detectedAt, document: documentResponse.text }));
    }
    return output;
  }

  private async pollIr(issuer: (typeof officialIssuers)[number], feedUrl: string, detectedAt: string) {
    const configured = new URL(feedUrl); const explicit = (process.env[issuer.irAllowlistEnv] ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    const hosts = new Set([configured.hostname.toLowerCase(), ...explicit]);
    const result = await this.request(feedUrl, hosts); if (result.notModified) return [];
    const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false, htmlEntities: false }).parse(result.text) as Record<string, any>;
    const items = [...asArray(parsed.rss?.channel?.item), ...asArray(parsed.feed?.entry)].slice(0, 8);
    return items.flatMap((item: any) => {
      try {
        const title = String(item.title?.["#text"] ?? item.title ?? "").trim(); if (!title) return [];
        const dateValue = item.pubDate ?? item.published ?? item.updated; const date = new Date(dateValue ?? detectedAt);
        if (Number.isNaN(date.getTime())) return [];
        const candidate = String(item.link?.["@_href"] ?? item.link ?? item.guid?.["#text"] ?? item.guid ?? feedUrl);
        const url = canonicalSourceUrl(new URL(candidate, result.url).toString(), hosts);
        const raw = String(item["content:encoded"] ?? item.content?.["#text"] ?? item.content ?? item.description ?? item.summary ?? title);
        const accessionId = String(item.guid?.["#text"] ?? item.guid ?? item.id ?? sha(`${title}:${date.toISOString()}`));
        return [eventFromDocument({ symbol: issuer.symbol, sourceType: "ISSUER_IR", formType: "IR_RELEASE",
          accessionId, url, title, publishedAt: date.toISOString(), detectedAt, document: raw })];
      } catch { return []; }
    });
  }
}
