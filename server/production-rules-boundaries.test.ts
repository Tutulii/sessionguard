import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuardEvaluationInput, PortfolioSnapshot, ProductionMarketSnapshot } from "../shared/production-types.js";
import { defaultUserPolicy } from "../shared/production-types.js";
import { MemoryCoordinator } from "./coordinator.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { replayPortfolio } from "./production-bitget.js";
import { ProductionMarketService } from "./production-market.js";
import { evaluateProductionGuard } from "./production-rules.js";

const userId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-09T15:00:00.000Z");
let repository: SqlitePlatformRepository;
let market: ProductionMarketService;

function evaluate(snapshot: ProductionMarketSnapshot, portfolio: PortfolioSnapshot, input: GuardEvaluationInput,
  dailyUsage = { count: 0, grossNewNotionalCents: 0 }) {
  return evaluateProductionGuard({ userId, snapshot, portfolio, input, policy: defaultUserPolicy,
    policyVersion: "default", dailyUsage, now });
}

describe("production fail-closed rule boundaries", () => {
  beforeAll(async () => {
    repository = new SqlitePlatformRepository();
    await repository.init();
    market = new ProductionMarketService(repository, new MemoryCoordinator());
  });
  afterAll(async () => { await repository.close(); });

  it("blocks unavailable, stale, and anchorless live inputs with stable reason codes", async () => {
    const cash = await market.snapshot("RNVDAUSDT", { mode: "REPLAY", replayId: "cash-nvidia", now });
    const snapshot: ProductionMarketSnapshot = {
      ...cash,
      dataMode: "LIVE_BITGET",
      sourceLabel: "LIVE BITGET",
      session: "MARKET_UNAVAILABLE",
      quoteAgeMs: 10_001,
      referenceQuality: "MISSING",
      anchorPriceMicros: null,
      offHoursMoveBps: null,
    };
    const portfolio = { ...replayPortfolio(userId), positions: [], capturedAt: now.toISOString() };
    const decision = evaluate(snapshot, portfolio, {
      symbol: "RNVDAUSDT", side: "buy", notionalCents: 5_000, maxSlippageBps: 50,
      dataMode: "LIVE_BITGET", earningsWindow: false,
    });
    expect(decision.permission).toBe("BLOCK");
    expect(decision.reasonCodes).toEqual(expect.arrayContaining(["MARKET_UNAVAILABLE", "STALE_QUOTE", "ANCHOR_MISSING"]));
    expect(decision.decisionToken).toBeUndefined();
  });

  it("blocks a stale portfolio even when every market input passes", async () => {
    const snapshot = await market.snapshot("RNVDAUSDT", { mode: "REPLAY", replayId: "cash-nvidia", now });
    const portfolio = { ...replayPortfolio(userId), positions: [], capturedAt: new Date(now.getTime() - 15_001).toISOString() };
    const decision = evaluate(snapshot, portfolio, {
      symbol: "RNVDAUSDT", side: "buy", notionalCents: 5_000, maxSlippageBps: 50,
      dataMode: "REPLAY", replayId: "cash-nvidia", earningsWindow: false,
    });
    expect(decision.permission).toBe("BLOCK");
    expect(decision.reasonCodes).toContain("STALE_PORTFOLIO");
  });

  it("allows only a bounded, fresh position reduction while the cash market is dark", async () => {
    const snapshot = await market.snapshot("RORCLUSDT", { mode: "REPLAY", replayId: "sunday-oracle", now });
    const portfolio = { ...replayPortfolio(userId), capturedAt: now.toISOString() };
    const reduction = evaluate(snapshot, portfolio, {
      symbol: "RORCLUSDT", side: "sell", notionalCents: 10_000, maxSlippageBps: 50,
      dataMode: "REPLAY", replayId: "sunday-oracle", earningsWindow: false,
    });
    expect(reduction).toMatchObject({ permission: "TRADE", allowedNotionalCents: 10_000 });

    const oversized = evaluate(snapshot, portfolio, {
      symbol: "RORCLUSDT", side: "sell", notionalCents: 25_000, maxSlippageBps: 50,
      dataMode: "REPLAY", replayId: "sunday-oracle", earningsWindow: false,
    });
    expect(oversized.reasonCodes).not.toContain("NOT_REDUCE_ONLY");
    const beyondPosition = evaluate(snapshot, { ...portfolio, positions: [{ ...portfolio.positions[0], marketValueCents: 5_000 }] }, {
      symbol: "RORCLUSDT", side: "sell", notionalCents: 10_000, maxSlippageBps: 50,
      dataMode: "REPLAY", replayId: "sunday-oracle", earningsWindow: false,
    });
    expect(beyondPosition.reasonCodes).toContain("NOT_REDUCE_ONLY");

    const staleReduction = evaluate({ ...snapshot, dataMode: "LIVE_BITGET", sourceLabel: "LIVE BITGET", quoteAgeMs: 10_001 }, portfolio, {
      symbol: "RORCLUSDT", side: "sell", notionalCents: 10_000, maxSlippageBps: 50,
      dataMode: "LIVE_BITGET", earningsWindow: false,
    });
    expect(staleReduction.permission).toBe("BLOCK");
    expect(staleReduction.reasonCodes).toContain("STALE_QUOTE");
  });

  it("applies extended and earnings caps cumulatively", async () => {
    const replay = await market.snapshot("RTSLAUSDT", { mode: "REPLAY", replayId: "extended-tesla", now });
    const snapshot = { ...replay, spreadBps: 10, offHoursMoveBps: 0 };
    const portfolio = { ...replayPortfolio(userId), positions: [], capturedAt: now.toISOString() };
    const decision = evaluate(snapshot, portfolio, {
      symbol: "RTSLAUSDT", side: "buy", notionalCents: 25_000, maxSlippageBps: 50,
      dataMode: "REPLAY", replayId: "extended-tesla", earningsWindow: true,
    });
    expect(decision).toMatchObject({ permission: "TRADE", allowedNotionalCents: 2_500 });
    expect(decision.reasonCodes).toEqual(expect.arrayContaining(["EXTENDED_SIZE_CAP", "EARNINGS_SIZE_CAP"]));
  });

  it("blocks collateral stress and both daily operational limits", async () => {
    const snapshot = await market.snapshot("RORCLUSDT", { mode: "REPLAY", replayId: "sunday-oracle", now });
    const portfolio = { ...replayPortfolio(userId), collateralBufferPct: 16, capturedAt: now.toISOString() };
    const input: GuardEvaluationInput = {
      symbol: "RORCLUSDT", side: "buy", notionalCents: 25_000, maxSlippageBps: 50,
      dataMode: "REPLAY", replayId: "sunday-oracle", earningsWindow: false,
    };
    const cashSnapshot = { ...snapshot, session: "CASH_OPEN" as const, offHoursMoveBps: 0 };
    expect(evaluate(cashSnapshot, portfolio, input).reasonCodes).toContain("COLLATERAL_STRESS");
    expect(evaluate(cashSnapshot, { ...portfolio, collateralBufferPct: 100 }, input,
      { count: 20, grossNewNotionalCents: 0 }).reasonCodes).toContain("DAILY_ORDER_LIMIT");
    expect(evaluate(cashSnapshot, { ...portfolio, collateralBufferPct: 100 }, input,
      { count: 0, grossNewNotionalCents: 100_000 }).reasonCodes).toContain("DAILY_NOTIONAL_LIMIT");
  });
});
