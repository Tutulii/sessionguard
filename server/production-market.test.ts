import { describe, expect, it } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { ProductionMarketService } from "./production-market.js";
import { classifyProductionSession } from "./production-session.js";

function response(data: unknown) {
  return new Response(JSON.stringify({ code: "00000", msg: "success", data }), { status: 200 });
}

describe("Bitget-only production market service", () => {
  it("distinguishes weekends, holidays, early close, and DST cash sessions", () => {
    expect(classifyProductionSession(new Date("2026-09-13T18:00:00Z"))).toBe("WEEKEND");
    expect(classifyProductionSession(new Date("2026-12-25T16:00:00Z"))).toBe("HOLIDAY");
    expect(classifyProductionSession(new Date("2026-07-02T15:00:00Z"))).toBe("CASH_OPEN");
    expect(classifyProductionSession(new Date("2026-11-27T19:00:00Z"))).toBe("EXTENDED");
    expect(classifyProductionSession(new Date(), false)).toBe("MARKET_UNAVAILABLE");
  });

  it("captures and labels only a Bitget cash-session anchor", async () => {
    const repository = new SqlitePlatformRepository();
    const coordinator = new MemoryCoordinator();
    await repository.init();
    const now = new Date("2026-09-14T22:00:00Z");
    const close = new Date("2026-09-14T20:00:00Z").getTime();
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("tickers")) return response([{ symbol: "RNVDAUSDT", ts: String(now.getTime() + 250), lastPrice: "102", bid1Price: "101.9", ask1Price: "102" }]);
      if (url.includes("interval=1m")) return response([[String(close - 60_000), "100", "101", "99", "100"]]);
      return response([[String(now.getTime() - 60_000), "101", "102", "100", "101"], [String(now.getTime()), "101", "102", "100", "102"]]);
    };
    const service = new ProductionMarketService(repository, coordinator, fetcher as typeof fetch, "https://bitget.test");
    const snapshot = await service.snapshot("RNVDAUSDT", { now });
    expect(snapshot).toMatchObject({
      source: "BITGET",
      sourceLabel: "LIVE BITGET",
      referenceKind: "BITGET_CASH_SESSION_ANCHOR",
      referenceQuality: "OBSERVED",
      anchorPriceMicros: 100_000_000,
      offHoursMoveBps: 200,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/nasdaq|official stock|underlying close/i);
    expect(new Date(snapshot.receivedTimestamp).getTime())
      .toBeGreaterThanOrEqual(new Date(snapshot.providerTimestamp).getTime());
    await repository.close();
  });

  it("makes replay explicit and never labels it live", async () => {
    const repository = new SqlitePlatformRepository();
    await repository.init();
    const service = new ProductionMarketService(repository, new MemoryCoordinator(), fetch);
    const snapshot = await service.snapshot("RORCLUSDT", { mode: "REPLAY", replayId: "sunday-oracle" });
    expect(snapshot).toMatchObject({ dataMode: "REPLAY", sourceLabel: "REPLAY", session: "WEEKEND", quoteAgeMs: 0 });
    await repository.close();
  });
});
