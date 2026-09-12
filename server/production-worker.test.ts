import { describe, expect, it, vi } from "vitest";
import type { PersistentDemoConnectInput, PortfolioSnapshot } from "../shared/production-types.js";
import { MemoryCoordinator } from "./coordinator.js";
import { LocalDataKeyManager } from "./envelope-vault.js";
import type { NotificationSender } from "./notifications.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import type { DemoTradingAdapter, PortfolioPrices } from "./production-bitget.js";
import { createProductionWorker } from "./production-worker.js";

function response(data: unknown) {
  return new Response(JSON.stringify({ code: "00000", msg: "success", data }), { status: 200 });
}

describe("production worker process", () => {
  it("completes market, delivery, reconciliation, and health/metrics work in one tick", async () => {
    const now = new Date("2026-09-14T22:00:00.000Z");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/tickers")) return response([{
        symbol: url.searchParams.get("symbol"), ts: String(now.getTime()), lastPrice: "100", bid1Price: "99.99", ask1Price: "100.01",
      }]);
      const end = Number(url.searchParams.get("endTime"));
      if (url.searchParams.get("interval") === "1m") return response([[String(end - 120_000), "99", "101", "98", "100"]]);
      return response([[String(now.getTime() - 60_000), "99", "101", "98", "100"], [String(now.getTime()), "99", "101", "98", "100"]]);
    }) as typeof fetch;
    const adapter: DemoTradingAdapter = {
      validate: vi.fn(async () => ({ executionEnabled: true })),
      portfolio: vi.fn(async (userId: string, _credentials: PersistentDemoConnectInput, _prices: PortfolioPrices): Promise<PortfolioSnapshot> => ({
        userId, accountEquityCents: 100_000, availableBalanceCents: 100_000, collateralBufferPct: 100,
        positions: [], openOrderCount: 0, source: "BITGET_DEMO", capturedAt: new Date().toISOString(),
      })),
      placeOrder: vi.fn(async () => ({ orderId: "unused", raw: {} })), reconcile: vi.fn(async () => null),
    };
    const sender: NotificationSender = { send: vi.fn(async () => "unused") };
    const worker = await createProductionWorker({ repository: new SqlitePlatformRepository(), coordinator: new MemoryCoordinator(),
      keyManager: new LocalDataKeyManager("worker-test-local-key-longer-than-32-characters"), tradingAdapter: adapter,
      notificationSender: sender, fetcher, allowLocal: true });
    expect((await worker.health()).ok).toBe(false);
    await worker.tick(now);
    expect(await worker.health()).toMatchObject({ ok: true, database: true, redis: true, recent: true });
    expect(await worker.metrics()).toContain("sessionguard_worker_last_success_unixtime");
    expect(fetcher).toHaveBeenCalled();
    await worker.stop();
  });

  it("reports a healthy heartbeat while a bounded initial scan is running", async () => {
    const providerAt = new Date();
    let releaseTicker!: () => void;
    const tickerGate = new Promise<void>((resolve) => { releaseTicker = resolve; });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/tickers")) {
        await tickerGate;
        return response([{
          symbol: url.searchParams.get("symbol"), ts: String(providerAt.getTime()), lastPrice: "100",
          bid1Price: "99.99", ask1Price: "100.01",
        }]);
      }
      const end = Number(url.searchParams.get("endTime"));
      return response([[String(end - 120_000), "99", "101", "98", "100"]]);
    }) as typeof fetch;
    const worker = await createProductionWorker({
      repository: new SqlitePlatformRepository(), coordinator: new MemoryCoordinator(),
      keyManager: new LocalDataKeyManager("worker-heartbeat-test-key-longer-than-32-characters"),
      notificationSender: { send: vi.fn(async () => "unused") }, fetcher, allowLocal: true, runtimeEnabled: false,
    });

    const running = worker.run();
    await vi.waitFor(async () => expect(await worker.health()).toMatchObject({ ok: true, heartbeatRecent: true, tickStalled: false }));
    releaseTicker();
    await vi.waitFor(async () => expect((await worker.health()).lastSuccessfulTickAt).not.toBeNull());
    await worker.stop();
    await running;
  }, 10_000);
});
