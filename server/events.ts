import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import {
  MarketEventSchema,
  type MarketEvent,
  type SupportedSymbol,
} from "../shared/types.js";
import { DecisionStore } from "./store.js";

const ISSUERS: Array<{
  symbol: SupportedSymbol;
  cik: string;
  name: string;
  irFeed?: string;
}> = [
  { symbol: "RNVDAUSDT", cik: "0001045810", name: "NVIDIA", irFeed: process.env.IR_FEED_NVDA },
  { symbol: "RTSLAUSDT", cik: "0001318605", name: "Tesla", irFeed: process.env.IR_FEED_TSLA },
  { symbol: "RORCLUSDT", cik: "0001341439", name: "Oracle", irFeed: process.env.IR_FEED_ORCL },
];

const TRACKED_FORMS = new Set(["8-K", "10-Q", "10-K", "6-K"]);

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function safeWebUrl(value: unknown, fallback: string): string {
  try {
    const parsed = new URL(String(value ?? fallback));
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString();
  } catch {
    // Fall through to the known configured feed URL.
  }
  return new URL(fallback).toString();
}

export function normalizeSecTimestamp(accepted: string | undefined, filingDate: string): string {
  const fallback = new Date(`${filingDate}T12:00:00Z`);
  const raw = accepted?.trim();
  if (raw) {
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    const parsed = new Date(hasZone ? raw : `${raw}Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback.toISOString();
}

export class OfficialEventService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly store: DecisionStore) {}

  async refresh(): Promise<MarketEvent[]> {
    const settled = await Promise.allSettled(
      ISSUERS.flatMap((issuer) => [
        this.fetchSec(issuer),
        ...(issuer.irFeed ? [this.fetchIr(issuer, issuer.irFeed)] : []),
      ]),
    );
    const normalized = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const events = [...new Map(normalized.map((event) => [event.id, event])).values()];
    for (const event of events) this.store.saveEvent(event);
    return events;
  }

  start(intervalMs = 2 * 60_000) {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async fetchSec(issuer: (typeof ISSUERS)[number]): Promise<MarketEvent[]> {
    const response = await fetch(`https://data.sec.gov/submissions/CIK${issuer.cik}.json`, {
      headers: {
        accept: "application/json",
        "user-agent": process.env.SEC_USER_AGENT ?? "SessionGuard/0.1 team@example.com",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`SEC request failed (${response.status})`);
    const payload = (await response.json()) as {
      filings?: {
        recent?: Record<string, Array<string>>;
      };
    };
    const recent = payload.filings?.recent;
    if (!recent) return [];
    const forms = recent.form ?? [];
    const cutoff = Date.now() - 45 * 24 * 60 * 60_000;
    const events: MarketEvent[] = [];
    for (let index = 0; index < forms.length; index += 1) {
      const formType = forms[index];
      if (!TRACKED_FORMS.has(formType)) continue;
      const filingDate = recent.filingDate?.[index];
      if (!filingDate || new Date(`${filingDate}T00:00:00Z`).getTime() < cutoff) continue;
      const accession = recent.accessionNumber?.[index];
      const primaryDocument = recent.primaryDocument?.[index];
      if (!accession || !primaryDocument) continue;
      const accessionPlain = accession.replace(/-/g, "");
      const cikPlain = String(Number(issuer.cik));
      const sourceUrl = `https://www.sec.gov/Archives/edgar/data/${cikPlain}/${accessionPlain}/${encodeURIComponent(primaryDocument)}`;
      const description = recent.primaryDocDescription?.[index] || `${formType} filing`;
      const candidate = MarketEventSchema.safeParse({
        id: `sec-${accession}`,
        symbol: issuer.symbol,
        source: "SEC",
        sourceName: "SEC EDGAR",
        sourceUrl,
        headline: `${issuer.name} files ${formType}: ${description}`,
        summary: `Official ${formType} filing published through SEC EDGAR.`,
        publishedAt: normalizeSecTimestamp(recent.acceptanceDateTime?.[index], filingDate),
        detectedAt: new Date().toISOString(),
        contentHash: hash(`${accession}:${description}`),
        isOfficial: true,
        formType,
      });
      if (candidate.success) events.push(candidate.data);
    }
    return events.slice(0, 8);
  }

  private async fetchIr(
    issuer: (typeof ISSUERS)[number],
    feedUrl: string,
  ): Promise<MarketEvent[]> {
    const response = await fetch(feedUrl, {
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`IR feed request failed (${response.status})`);
    const xml = await response.text();
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as Record<string, any>;
    const items = [
      ...asArray(parsed.rss?.channel?.item),
      ...asArray(parsed.feed?.entry),
    ];
    return items.slice(0, 8).flatMap((item: any) => {
      const headline = String(item.title?.["#text"] ?? item.title ?? "").trim();
      const rawDate = item.pubDate ?? item.published ?? item.updated;
      const published = rawDate ? new Date(rawDate) : new Date();
      if (!headline || Number.isNaN(published.getTime())) return [];
      const contentHash = hash(`${issuer.symbol}:${headline}:${published.toISOString()}`);
      const candidate = MarketEventSchema.safeParse({
        id: `ir-${contentHash.slice(0, 20)}`,
        symbol: issuer.symbol,
        source: "IR",
        sourceName: `${issuer.name} Investor Relations`,
        sourceUrl: safeWebUrl(item.link?.["@_href"] ?? item.link ?? item.guid, feedUrl),
        headline,
        summary: "Official issuer investor-relations update.",
        publishedAt: published.toISOString(),
        detectedAt: new Date().toISOString(),
        contentHash,
        isOfficial: true,
      });
      return candidate.success ? [candidate.data] : [];
    });
  }
}
