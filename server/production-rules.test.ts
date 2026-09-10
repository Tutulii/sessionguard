import { describe, expect, it } from "vitest";
import { defaultUserPolicy, UserPolicySchema } from "../shared/production-types.js";
import { replayPortfolio } from "./production-bitget.js";
import { ProductionMarketService } from "./production-market.js";
import { MemoryCoordinator } from "./coordinator.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { evaluateProductionGuard } from "./production-rules.js";

describe("production deterministic guard", () => {
  it("blocks weekend exposure increases and produces the three gap cards", async () => {
    const repository = new SqlitePlatformRepository();
    await repository.init();
    const now = new Date();
    const market = await new ProductionMarketService(repository, new MemoryCoordinator()).snapshot("RORCLUSDT", { mode: "REPLAY", replayId: "sunday-oracle", now });
    const decision = evaluateProductionGuard({
      userId: "11111111-1111-4111-8111-111111111111",
      input: { symbol: "RORCLUSDT", side: "buy", notionalCents: 25_000, maxSlippageBps: 50, dataMode: "REPLAY", replayId: "sunday-oracle", earningsWindow: false },
      snapshot: market,
      portfolio: replayPortfolio("11111111-1111-4111-8111-111111111111"),
      policy: defaultUserPolicy,
      policyVersion: "default",
      dailyUsage: { count: 0, grossNewNotionalCents: 0 },
      now,
    });
    expect(decision.permission).toBe("BLOCK");
    expect(decision.reasonCodes).toContain("CASH_MARKET_DARK");
    expect(decision.gapScenarios.map((item) => item.gapPct)).toEqual([-3, -8, -12]);
    await repository.close();
  });

  it("allows a fresh cash-session replay and caps earnings to ten percent", async () => {
    const repository = new SqlitePlatformRepository();
    await repository.init();
    const now = new Date();
    const market = await new ProductionMarketService(repository, new MemoryCoordinator()).snapshot("RNVDAUSDT", { mode: "REPLAY", replayId: "cash-nvidia", now });
    const portfolio = { ...replayPortfolio("11111111-1111-4111-8111-111111111111"), capturedAt: now.toISOString(), positions: [] };
    const decision = evaluateProductionGuard({
      userId: portfolio.userId,
      input: { symbol: "RNVDAUSDT", side: "buy", notionalCents: 15_000, maxSlippageBps: 50, dataMode: "REPLAY", earningsWindow: true },
      snapshot: market, portfolio, policy: defaultUserPolicy, policyVersion: "default",
      dailyUsage: { count: 0, grossNewNotionalCents: 0 }, now,
    });
    expect(decision.permission).toBe("TRADE");
    expect(decision.allowedNotionalCents).toBe(2_500);
    expect(decision.reasonCodes).toContain("EARNINGS_SIZE_CAP");
    await repository.close();
  });

  it("rejects stale portfolios and policy values cannot loosen hard limits", () => {
    expect(UserPolicySchema.safeParse({ ...defaultUserPolicy, maxPaperOrderCents: 25_001 }).success).toBe(false);
  });
});
