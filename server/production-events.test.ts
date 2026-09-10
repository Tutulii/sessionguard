import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteAgentRepository } from "./agent-repository.js";
import { canonicalSourceUrl, evidenceSegments, fetchAllowlistedHttps, isPublicAddress, normalizeOfficialDocument, ProductionOfficialEventWatcher } from "./production-events.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
function response(body: string, init: ResponseInit = {}) { return new Response(body, { status: 200, headers: { "content-type": "application/json", ...init.headers }, ...init }); }

describe("official SEC and allow-listed IR ingestion", () => {
  afterEach(() => { delete process.env.IR_FEED_NVDA; delete process.env.IR_ALLOWED_HOSTS_NVDA; vi.restoreAllMocks(); });

  it("canonicalizes HTTPS sources and rejects credentials, custom ports, foreign hosts, and tracking", () => {
    expect(canonicalSourceUrl("https://www.sec.gov/a?utm_source=x&id=7#frag", new Set(["www.sec.gov"]))).toBe("https://www.sec.gov/a?id=7");
    expect(() => canonicalSourceUrl("http://www.sec.gov/a", new Set(["www.sec.gov"]))).toThrow("URL_REJECTED");
    expect(() => canonicalSourceUrl("https://u:p@www.sec.gov/a", new Set(["www.sec.gov"]))).toThrow("URL_REJECTED");
    expect(() => canonicalSourceUrl("https://www.sec.gov:8443/a", new Set(["www.sec.gov"]))).toThrow("URL_REJECTED");
    expect(() => canonicalSourceUrl("https://evil.test/a", new Set(["www.sec.gov"]))).toThrow("HOST_REJECTED");
  });

  it.each(["127.0.0.1", "10.1.2.3", "169.254.1.1", "172.16.1.1", "192.168.1.1", "100.64.1.1", "192.0.2.1", "198.51.100.4", "203.0.113.4", "::1", "fe80::1", "fc00::1", "2001:db8::1", "ff02::1"])("rejects non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("checks DNS for every redirect and keeps redirects inside the allow-list", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://ir.example.test/final" } }))
      .mockResolvedValueOnce(response("ok", { headers: { "content-type": "text/plain" } }));
    const result = await fetchAllowlistedHttps("https://ir.example.test/feed", new Set(["ir.example.test"]), { fetcher, lookup: publicLookup });
    expect(result.text).toBe("ok"); expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(fetchAllowlistedHttps("https://ir.example.test/feed", new Set(["ir.example.test"]), {
      fetcher: async () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }), lookup: publicLookup,
    })).rejects.toThrow("HOST_REJECTED");
    await expect(fetchAllowlistedHttps("https://ir.example.test/feed", new Set(["ir.example.test"]), {
      fetcher: async () => response("x", { headers: { "content-type": "text/plain" } }),
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    })).rejects.toThrow("PRIVATE_ADDRESS_REJECTED");
  });

  it("enforces two redirects, a streaming two-megabyte ceiling, and textual content types", async () => {
    const looping = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/again" } }));
    await expect(fetchAllowlistedHttps("https://ir.example.test/feed", new Set(["ir.example.test"]), { fetcher: looping, lookup: publicLookup })).rejects.toThrow("TOO_MANY_REDIRECTS");
    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(fetchAllowlistedHttps("https://ir.example.test/feed", new Set(["ir.example.test"]), { fetcher: async () => response(oversized, { headers: { "content-type": "text/plain" } }), lookup: publicLookup })).rejects.toThrow("TOO_LARGE");
    await expect(fetchAllowlistedHttps("https://ir.example.test/feed", new Set(["ir.example.test"]), { fetcher: async () => response("bin", { headers: { "content-type": "application/octet-stream" } }), lookup: publicLookup })).rejects.toThrow("CONTENT_TYPE_REJECTED");
  });

  it("strips active/hidden markup, caps text, and creates deterministic hashed evidence segments", () => {
    const normalized = normalizeOfficialDocument(`<h1>Result &amp; update</h1><script>steal()</script><style>.x{}</style><form>secret</form><div hidden>ignore</div><p>Visible text</p>${"z".repeat(70_000)}`);
    expect(normalized).toContain("Result & update"); expect(normalized).toContain("Visible text");
    expect(normalized).not.toMatch(/steal|secret|ignore|<script/i); expect(normalized.length).toBeLessThanOrEqual(64_000);
    const first = evidenceSegments(normalized); const second = evidenceSegments(normalized);
    expect(first).toEqual(second); expect(first.length).toBeGreaterThan(0); expect(first.every((item) => item.text.length <= 1_800 && item.hash.length === 64)).toBe(true);
  });

  it("polls only tracked SEC forms, sends the SEC contact header, dedupes, and preserves changed versions", async () => {
    const repository = new SqliteAgentRepository(); await repository.init();
    let document = "Initial material agreement"; const headers: unknown[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); headers.push(init?.headers ?? {});
      if (url.includes("submissions")) {
        const cik = url.match(/CIK(\d+)/)?.[1];
        return response(JSON.stringify(cik === "0001045810" ? { filings: { recent: {
          form: ["8-K", "S-1"], accessionNumber: ["0001045810-26-000001", "skip"], primaryDocument: ["filing.htm", "s1.htm"],
          filingDate: ["2026-09-15", "2026-09-15"], acceptanceDateTime: ["2026-09-15T14:45:00Z", "2026-09-15T14:45:00Z"], primaryDocDescription: ["Agreement", "Registration"],
        } } } : { filings: { recent: { form: [] } } }), { headers: { "content-type": "application/json", etag: `sub-${document}` } });
      }
      return response(`<article>${document}</article>`, { headers: { "content-type": "text/html", etag: `doc-${document}` } });
    });
    const watcher = new ProductionOfficialEventWatcher(repository, { fetcher: fetcher as typeof fetch, lookup: publicLookup, now: () => new Date("2026-09-15T14:46:00Z") });
    const first = await watcher.poll(); expect(first).toHaveLength(1); expect(first[0]).toMatchObject({ sourceType: "SEC_EDGAR", formType: "8-K", symbol: "RNVDAUSDT" });
    expect(JSON.stringify(headers)).toContain("security@sessionguard.local");
    const duplicate = await watcher.poll(); expect(duplicate).toHaveLength(0);
    document = "Corrected material agreement"; const changed = await watcher.poll(); expect(changed).toHaveLength(1);
    expect(changed[0].id).toBe(first[0].id); expect(changed[0].versionId).not.toBe(first[0].versionId); expect(changed[0].cautionFlags).toContain("CORRECTION");
    await repository.close();
  });

  it("persists but does not emit historical filings into the live trigger queue", async () => {
    const repository = new SqliteAgentRepository(); await repository.init();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("submissions")) {
        const cik = url.match(/CIK(\d+)/)?.[1];
        return response(JSON.stringify(cik === "0001045810" ? { filings: { recent: {
          form: ["8-K"], accessionNumber: ["0001045810-23-000001"], primaryDocument: ["old.htm"],
          filingDate: ["2023-08-23"], acceptanceDateTime: ["2023-08-23T20:21:42Z"], primaryDocDescription: ["Historical filing"],
        } } } : { filings: { recent: { form: [] } } }));
      }
      return response("<article>Historical source evidence</article>", { headers: { "content-type": "text/html" } });
    });
    const watcher = new ProductionOfficialEventWatcher(repository, { fetcher: fetcher as typeof fetch, lookup: publicLookup,
      now: () => new Date("2026-09-15T14:46:00Z") });
    expect(await watcher.poll()).toEqual([]);
    await repository.close();
  });

  it("uses bounded backoff after source failures instead of hammering upstream", async () => {
    const repository = new SqliteAgentRepository(); await repository.init(); let now = new Date("2026-09-15T14:46:00Z");
    const fetcher = vi.fn(async () => { throw new Error("upstream down"); });
    const watcher = new ProductionOfficialEventWatcher(repository, { fetcher: fetcher as typeof fetch, lookup: publicLookup, now: () => now });
    expect(await watcher.poll()).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(3); expect(watcher.health().status).toBe("DEGRADED");
    await watcher.poll(); expect(fetcher).toHaveBeenCalledTimes(3); expect(watcher.health().errors).toContain("OFFICIAL_SOURCE_BACKOFF_ACTIVE");
    now = new Date(now.getTime() + 31 * 60_000); await watcher.poll(); expect(fetcher).toHaveBeenCalledTimes(6);
    await repository.close();
  });
});
