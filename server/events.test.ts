import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionStore } from "./store.js";
import { normalizeSecTimestamp, OfficialEventService } from "./events.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("official event normalization", () => {
  it("accepts SEC timestamps with or without a timezone and avoids a doubled Z", () => {
    expect(normalizeSecTimestamp("2026-09-08T16:07:41.000Z", "2026-09-08")).toBe("2026-09-08T16:07:41.000Z");
    expect(normalizeSecTimestamp("2026-09-08T16:07:41.000", "2026-09-08")).toBe("2026-09-08T16:07:41.000Z");
  });

  it("uses a deterministic filing-date fallback for an invalid acceptance time", () => {
    expect(normalizeSecTimestamp("not-a-date", "2026-09-08")).toBe("2026-09-08T12:00:00.000Z");
  });

  it("normalizes and deduplicates repeated SEC refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const cik = String(input).match(/CIK(\d+)\.json/)?.[1] ?? "unknown";
      return new Response(JSON.stringify({
        filings: {
          recent: {
            form: ["8-K"],
            filingDate: ["2026-09-08"],
            accessionNumber: [`${cik}-26-000001`],
            primaryDocument: ["report.htm"],
            acceptanceDateTime: ["2026-09-08T16:07:41.000Z"],
            primaryDocDescription: ["Material event"],
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const store = new DecisionStore(":memory:");
    const service = new OfficialEventService(store);
    await service.refresh();
    await service.refresh();
    expect(store.listEvents()).toHaveLength(3);
    expect(store.listEvents().every((event) => event.isOfficial && event.source === "SEC")).toBe(true);
    store.close();
  });
});
