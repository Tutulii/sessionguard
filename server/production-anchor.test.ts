import { describe, expect, it } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { ProductionMarketService } from "./production-market.js";
import { anchorCloseForCapture, previousAnchorSessionDate } from "./production-session.js";

function response(data: unknown) {
  return new Response(JSON.stringify({ code: "00000", msg: "success", data }), { status: 200 });
}

describe("cash-session anchor capture contract", () => {
  it("keeps the previous completed session until close plus two minutes", () => {
    expect(anchorCloseForCapture(new Date("2026-09-14T20:01:59.999Z")).toISOString()).toBe("2026-09-11T20:00:00.000Z");
    expect(previousAnchorSessionDate(new Date("2026-09-14T20:01:59.999Z"))).toBe("2026-09-11");
    expect(anchorCloseForCapture(new Date("2026-09-14T20:02:00.000Z")).toISOString()).toBe("2026-09-14T20:00:00.000Z");
  });

  it("marks a candle up to 30 minutes before close degraded and rejects older candles", async () => {
    const now = new Date("2026-09-14T22:00:00.000Z");
    const close = new Date("2026-09-14T20:00:00.000Z").getTime();
    const degradedRepository = new SqlitePlatformRepository(); await degradedRepository.init();
    const degraded = new ProductionMarketService(degradedRepository, new MemoryCoordinator(),
      (async () => response([[String(close - 16 * 60_000), "100", "101", "99", "100"]])) as typeof fetch,
      "https://bitget.test");
    await expect(degraded.captureAnchor("RNVDAUSDT", now)).resolves.toMatchObject({ quality: "DEGRADED" });
    await degradedRepository.close();

    const missingRepository = new SqlitePlatformRepository(); await missingRepository.init();
    const missing = new ProductionMarketService(missingRepository, new MemoryCoordinator(),
      (async () => response([[String(close - 32 * 60_000), "100", "101", "99", "100"]])) as typeof fetch,
      "https://bitget.test");
    await expect(missing.captureAnchor("RNVDAUSDT", now)).rejects.toThrow("ANCHOR_MISSING");
    await missingRepository.close();
  });

  it("rejects invalid or materially future-dated Bitget ticker timestamps", async () => {
    const repository = new SqlitePlatformRepository(); await repository.init();
    const now = new Date("2026-09-14T22:00:00.000Z");
    const service = new ProductionMarketService(repository, new MemoryCoordinator(), (async () => response([{
      symbol: "RNVDAUSDT", ts: String(now.getTime() + 6_000), lastPrice: "102", bid1Price: "101.9", ask1Price: "102",
    }])) as typeof fetch, "https://bitget.test");
    await expect(service.snapshot("RNVDAUSDT", { now })).rejects.toThrow("INVALID_BITGET_TIMESTAMP");
    await repository.close();
  });
});
