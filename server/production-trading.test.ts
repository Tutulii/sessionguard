import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  PersistentDemoConnectInput, PortfolioSnapshot, ProductionMarketSnapshot, ProductionSymbol,
} from "../shared/production-types.js";
import { MemoryCoordinator } from "./coordinator.js";
import { EnvelopeVault, LocalDataKeyManager, PersistentCredentialVault } from "./envelope-vault.js";
import { NotificationService } from "./notifications.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import type { DemoTradingAdapter, PortfolioPrices } from "./production-bitget.js";
import { ProductionMarketService } from "./production-market.js";
import { ProductionDecisionTokenService } from "./production-token.js";
import { ProductionTradingService } from "./production-trading.js";

function marketSnapshot(symbol: ProductionSymbol, now = new Date()): ProductionMarketSnapshot {
  const metadata = {
    RNVDAUSDT: ["rNVDA", "NVDA", "NVIDIA"], RTSLAUSDT: ["rTSLA", "TSLA", "Tesla"],
    RORCLUSDT: ["rORCL", "ORCL", "Oracle"],
  }[symbol] as [string, "NVDA" | "TSLA" | "ORCL", string];
  return {
    symbol, displaySymbol: metadata[0], underlyingSymbol: metadata[1], companyName: metadata[2],
    dataMode: "LIVE_BITGET", sourceLabel: "LIVE BITGET", source: "BITGET", session: "CASH_OPEN",
    rTokenPriceMicros: 100_000_000, bidPriceMicros: 99_990_000, askPriceMicros: 100_010_000,
    spreadBps: 2, referenceKind: "BITGET_CASH_SESSION_ANCHOR", referenceQuality: "OBSERVED",
    anchorPriceMicros: 100_000_000, offHoursMoveBps: 0, providerTimestamp: now.toISOString(),
    receivedTimestamp: now.toISOString(), quoteAgeMs: 0, referenceTimestamp: now.toISOString(),
    nextCashOpen: new Date(now.getTime() + 86_400_000).toISOString(), chart: [
      { time: new Date(now.getTime() - 60_000).toISOString(), priceMicros: 100_000_000 },
      { time: now.toISOString(), priceMicros: 100_000_000 },
    ],
  };
}

class FixedMarket extends ProductionMarketService {
  override async snapshot(symbol: ProductionSymbol, options: { now?: Date } = {}) {
    return marketSnapshot(symbol, options.now ?? new Date());
  }
}

class RecoveringAdapter implements DemoTradingAdapter {
  provider: { orderId: string; status: string } | null = null;
  validate = vi.fn(async () => ({ executionEnabled: true }));
  portfolio = vi.fn(async (userId: string, _credentials: PersistentDemoConnectInput, _prices: PortfolioPrices): Promise<PortfolioSnapshot> => ({
    userId, accountEquityCents: 500_000, availableBalanceCents: 400_000, collateralBufferPct: 80,
    positions: [], openOrderCount: 0, source: "BITGET_DEMO", capturedAt: new Date().toISOString(),
  }));
  placeOrder = vi.fn(async () => { throw new Error("socket closed after submit"); });
  reconcile = vi.fn(async () => this.provider);
}

async function fixture() {
  const repository = new SqlitePlatformRepository(); await repository.init();
  const coordinator = new MemoryCoordinator();
  const user = await repository.createOrLoginUser("0x4444444444444444444444444444444444444444", 500);
  const envelope = new EnvelopeVault(new LocalDataKeyManager("trading-test-master-key-longer-than-32-characters"));
  const adapter = new RecoveringAdapter();
  const service = new ProductionTradingService(repository, coordinator,
    new FixedMarket(repository, coordinator), new PersistentCredentialVault(repository, envelope), adapter,
    new ProductionDecisionTokenService("trading-test-decision-key-longer-than-32-characters", coordinator),
    new NotificationService(repository, coordinator, envelope, "https://sessionguard.test"));
  await service.connect(user.id, { apiKey: "demo-key-value", secretKey: "demo-secret-value", passphrase: "demo-passphrase" });
  return { repository, coordinator, user, adapter, service };
}

describe("crash-safe Bitget Demo execution", () => {
  it("reconciles an uncertain provider response by client ID without a blind retry", async () => {
    const { repository, user, adapter, service } = await fixture();
    const sessionId = randomUUID();
    const decision = await service.evaluate(user.id, sessionId, {
      symbol: "RNVDAUSDT", side: "buy", notionalCents: 5_000, maxSlippageBps: 50,
      dataMode: "LIVE_BITGET", earningsWindow: false,
    });
    await expect(service.execute(user.id, sessionId, decision.decisionToken!))
      .rejects.toThrow("BITGET_DEMO_ORDER_RECONCILIATION_PENDING");
    expect(adapter.placeOrder).toHaveBeenCalledOnce();
    const pending = await repository.getOrderByDecision(decision.id, user.id);
    expect(pending).toMatchObject({ status: "RECONCILING", attemptCount: 1, providerOrderId: null });

    adapter.provider = { orderId: "bitget-demo-recovered", status: "filled" };
    const recovered = await service.execute(user.id, sessionId, decision.decisionToken!);
    expect(recovered).toMatchObject({ status: "FILLED", providerOrderId: "bitget-demo-recovered", attemptCount: 1 });
    expect(adapter.placeOrder).toHaveBeenCalledOnce();
    await repository.close();
  });

  it("fails closed under a scoped kill switch before any Demo submission", async () => {
    const { repository, coordinator, user, adapter, service } = await fixture();
    const sessionId = randomUUID();
    const decision = await service.evaluate(user.id, sessionId, {
      symbol: "RNVDAUSDT", side: "buy", notionalCents: 5_000, maxSlippageBps: 50,
      dataMode: "LIVE_BITGET", earningsWindow: false,
    });
    await coordinator.cacheSet("kill:symbol:RNVDAUSDT", true, 60);
    await expect(service.execute(user.id, sessionId, decision.decisionToken!)).rejects.toThrow("PAPER_EXECUTION_KILLED");
    expect(adapter.placeOrder).not.toHaveBeenCalled();
    expect(await repository.getOrderByDecision(decision.id, user.id)).toBeNull();
    await repository.close();
  });
});
