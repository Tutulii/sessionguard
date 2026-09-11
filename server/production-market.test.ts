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

  it("recovers the first completed Bitget minute at or shortly after the target without interpolation", async () => {
    const repository = new SqlitePlatformRepository(); await repository.init();
    const target = new Date("2026-09-14T13:30:15.000Z");
    const expectedStart = new Date("2026-09-14T13:31:00.000Z").getTime();
    let requested = "";
    const service = new ProductionMarketService(repository, new MemoryCoordinator(), (async (input) => {
      requested = String(input);
      return response([[String(expectedStart + 60_000), "101.25", "102", "100", "101.75"]]);
    }) as typeof fetch, "https://bitget.test");
    await expect(service.completedObservationCandle("RNVDAUSDT", target, new Date("2026-09-14T13:33:00.000Z"))).resolves.toEqual({
      priceMicros: 101_250_000, observedAt: "2026-09-14T13:32:00.000Z", completedAt: "2026-09-14T13:33:00.000Z",
      source: "BITGET_COMPLETED_1M_CANDLE",
    });
    const query = new URL(requested).searchParams;
    expect(query.get("startTime")).toBe(String(expectedStart));
    expect(query.get("interval")).toBe("1m");
    await repository.close();
  });

  it("never substitutes an incomplete or out-of-window candle", async () => {
    const repository = new SqlitePlatformRepository(); await repository.init();
    const target = new Date("2026-09-14T13:30:15.000Z");
    const expectedStart = new Date("2026-09-14T13:31:00.000Z").getTime();
    let calls = 0;
    const service = new ProductionMarketService(repository, new MemoryCoordinator(), (async () => {
      calls += 1; return response([[String(expectedStart + 6 * 60_000), "101", "102", "100", "101.5"]]);
    }) as typeof fetch, "https://bitget.test");
    await expect(service.completedObservationCandle("RNVDAUSDT", target, new Date("2026-09-14T13:31:59.999Z")))
      .rejects.toThrow("OUTCOME_OBSERVATION_CANDLE_NOT_COMPLETE");
    expect(calls).toBe(0);
    await expect(service.completedObservationCandle("RNVDAUSDT", target, new Date("2026-09-14T13:33:00.000Z")))
      .rejects.toThrow("OUTCOME_BOUNDED_BITGET_CANDLE_MISSING");
    await repository.close();
  });
});
