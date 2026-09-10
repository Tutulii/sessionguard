import { afterEach, describe, expect, it, vi } from "vitest";
import { getLiveSnapshot } from "./market.js";

function envelope(data: unknown) {
  return new Response(JSON.stringify({ code: "00000", msg: "success", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Bitget rToken market adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calculates a cash-aligned basis and spread from Bitget responses", async () => {
    const now = new Date("2026-09-13T18:42:00.000Z");
    const quoteTime = new Date(now.getTime() - 30_000).getTime();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/tickers")) return envelope([{ symbol: "RORCLUSDT", ts: String(quoteTime), lastPrice: "303", bid1Price: "302.9", ask1Price: "303.1" }]);
      if (url.includes("interval=5m")) return envelope([
        [String(new Date("2026-09-11T19:55:00Z").getTime()), "299", "301", "299", "300"],
        [String(new Date("2026-09-11T20:00:00Z").getTime()), "300", "311", "300", "310"],
        [String(new Date("2026-09-11T20:05:00Z").getTime()), "310", "321", "310", "320"],
      ]);
      return envelope([
        [String(now.getTime() - 30 * 60_000), "300", "301", "299", "300"],
        [String(now.getTime()), "302", "304", "301", "303"],
      ]);
    }));
    const snapshot = await getLiveSnapshot("RORCLUSDT", now);
    expect(snapshot.session).toBe("WEEKEND_HOLIDAY");
    expect(snapshot.alignedReference).toBe(300);
    expect(snapshot.referenceTime).toBe("2026-09-11T19:55:00.000Z");
    expect(snapshot.basisBps).toBe(100);
    expect(snapshot.spreadBps).toBeCloseTo(6.6, 1);
    expect(snapshot.flags).toEqual([]);
  });

  it("marks stale quotes and missing references so policy can fail closed", async () => {
    const now = new Date("2026-09-15T15:00:00.000Z");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/tickers")) return envelope([{ symbol: "RTSLAUSDT", ts: String(now.getTime() - 180_000), lastPrice: "410", bid1Price: "409", ask1Price: "411" }]);
      return envelope([]);
    }));
    const snapshot = await getLiveSnapshot("RTSLAUSDT", now);
    expect(snapshot.flags).toContain("STALE_QUOTE");
    expect(snapshot.flags).toContain("REFERENCE_UNAVAILABLE");
    expect(snapshot.basisBps).toBeNull();
  });

  it("surfaces upstream errors instead of silently relabeling replay data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(getLiveSnapshot("RNVDAUSDT", new Date("2026-09-16T15:00:00Z"))).rejects.toThrow("Bitget market request failed");
  });
});
