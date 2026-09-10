import { describe, expect, it } from "vitest";
import { evaluateAgentGuard } from "./agent-guard.js";
import { baseGuardInput, cashTime, testAssessment, testContext, testEvent, testGrant, testMarket, testPortfolio, testSettings } from "./agent-test-fixtures.js";

describe("deterministic agent authorization", () => {
  it("caps a valid cash-open 8-K BUY proposal from $150 to $100", () => {
    const result = evaluateAgentGuard(baseGuardInput());
    expect(result).toMatchObject({ permission: "TRADE", requestedNotionalCents: 15_000, allowedNotionalCents: 10_000, side: "buy" });
    expect(result.reasonCodes).toEqual(["AGENT_POLICY_PASS"]);
  });

  it("never increases Qwen size and respects a tighter user/grant cap", () => {
    const result = evaluateAgentGuard(baseGuardInput({ assessment: testAssessment({ proposedNotionalCents: 7_500 }),
      settings: testSettings("PAPER_AUTO", { automaticOrderLimitCents: 6_000 }), grant: testGrant({ automaticOrderLimitCents: 5_000 }) }));
    expect(result.allowedNotionalCents).toBe(5_000);
    expect(result.allowedNotionalCents).toBeLessThanOrEqual(result.requestedNotionalCents);
  });

  it("turns base-policy caution into ALERT_ONLY, not a false hard block", () => {
    const market = testMarket({ spreadBps: 40 });
    const result = evaluateAgentGuard(baseGuardInput({ market, context: testContext({ market: (({ chart: _chart, ...rest }) => rest)(market) }) }));
    expect(result.permission).toBe("ALERT_ONLY");
    expect(result.reasonCodes).toContain("SPREAD_LIMIT");
  });

  it("keeps shadow structurally non-executing while exposing the capped policy result", () => {
    const result = evaluateAgentGuard(baseGuardInput({ settings: testSettings("SHADOW"), grant: null, eligibleForPaperAuto: false }));
    expect(result).toMatchObject({ permission: "TRADE", allowedNotionalCents: 10_000 });
    expect(result.reasonCodes).toEqual(["SHADOW_POLICY_PASS"]);
  });

  it("keeps alert-only non-executing even when every deterministic gate passes", () => {
    const result = evaluateAgentGuard(baseGuardInput({ settings: testSettings("ALERT_ONLY"), grant: null }));
    expect(result).toMatchObject({ permission: "ALERT_ONLY", allowedNotionalCents: 0 });
  });

  it.each([
    ["HOLD", "BLOCK", "AGENT_HOLD"], ["WAIT", "BLOCK", "AGENT_WAIT"], ["ADD_COLLATERAL", "ALERT_ONLY", "HUMAN_COLLATERAL_ACTION"],
  ])("maps Qwen %s without inventing a trade", (action, permission, code) => {
    const result = evaluateAgentGuard(baseGuardInput({ assessment: testAssessment({ action, proposedNotionalCents: 0 }) }));
    expect(result).toMatchObject({ permission, allowedNotionalCents: 0, side: null });
    expect(result.reasonCodes).toContain(code);
  });

  it("blocks every off-hours PAPER_AUTO order, including reductions", () => {
    const market = testMarket({ session: "WEEKEND", receivedTimestamp: "2026-09-13T15:00:00.000Z", providerTimestamp: "2026-09-13T15:00:00.000Z" });
    const buy = evaluateAgentGuard(baseGuardInput({ market, now: new Date("2026-09-13T15:00:00.000Z") }));
    expect(buy.reasonCodes).toContain("CASH_OPEN_REQUIRED");
    const sell = evaluateAgentGuard(baseGuardInput({ market, now: new Date("2026-09-13T15:00:00.000Z"),
      assessment: testAssessment({ action: "REDUCE", proposedNotionalCents: 5_000 }) }));
    expect(sell.reasonCodes).toContain("CASH_OPEN_REQUIRED");
  });

  it.each([
    ["low buy confidence", { assessment: testAssessment({ confidence: 0.79 }) }, "MODEL_CONFIDENCE_LOW"],
    ["weak relevance", { assessment: testAssessment({ relevance: "MEDIUM" }) }, "BUY_EVIDENCE_GATE"],
    ["stale novelty", { assessment: testAssessment({ novelty: "STALE" }) }, "BUY_EVIDENCE_GATE"],
    ["missing event", { event: null }, "EVENT_MISSING"],
    ["old event", { event: testEvent({ effectiveAt: "2026-09-14T14:59:59.000Z" }) }, "EVENT_TOO_OLD"],
    ["future event", { event: testEvent({ effectiveAt: "2026-09-15T15:00:01.000Z" }) }, "EVENT_TIME_INVALID"],
    ["superseded event", { event: testEvent({ supersededByEventId: "99999999-9999-4999-8999-999999999999" }) }, "EVENT_SUPERSEDED"],
    ["changed event", { event: testEvent({ versionId: "99999999-9999-4999-8999-999999999999" }) }, "EVENT_CHANGED"],
    ["missing grant", { grant: null }, "GRANT_REQUIRED"],
    ["expired grant", { grant: testGrant({ expiresAt: "2026-09-15T14:59:59.000Z" }) }, "GRANT_EXPIRED"],
    ["grant scope", { grant: testGrant({ symbols: ["RTSLAUSDT"] }) }, "GRANT_SCOPE_MISMATCH"],
    ["eligibility", { eligibleForPaperAuto: false }, "SHADOW_ELIGIBILITY_REQUIRED"],
    ["pending order", { outstandingSameSymbolOrder: true }, "OUTSTANDING_ORDER"],
    ["event used", { eventAlreadyActioned: true }, "EVENT_ALREADY_ACTIONED"],
    ["cooldown", { symbolCooldownActive: true }, "SYMBOL_COOLDOWN"],
    ["daily count", { automaticUsage: { count: 5, grossNewNotionalCents: 0 } }, "AGENT_DAILY_ORDER_LIMIT"],
    ["daily notional", { automaticUsage: { count: 1, grossNewNotionalCents: 45_000 } }, "AGENT_DAILY_NOTIONAL_LIMIT"],
  ])("fails closed for %s", (_name, overrides, code) => {
    const result = evaluateAgentGuard(baseGuardInput(overrides));
    expect(result.permission).toBe("BLOCK"); expect(result.allowedNotionalCents).toBe(0); expect(result.reasonCodes).toContain(code);
  });

  it.each(["global", "user", "symbol", "runtime", "model", "provider"] as const)("prioritizes the %s kill switch", (key) => {
    const killSwitches = { global: false, user: false, symbol: false, runtime: false, model: false, provider: false, [key]: true };
    expect(evaluateAgentGuard(baseGuardInput({ killSwitches })).reasonCodes).toContain("AGENT_RUNTIME_KILLED");
  });

  it("enforces single-name, aggregate, correlated stress, and UTC-day drawdown breakers", () => {
    const single = evaluateAgentGuard(baseGuardInput({ portfolio: testPortfolio({ positions: [{ symbol: "RNVDAUSDT", quantityMicros: 1, marketValueCents: 95_000, usedAsCollateral: true }] }) }));
    expect(single.reasonCodes).toContain("SINGLE_NAME_CONCENTRATION");
    const aggregate = evaluateAgentGuard(baseGuardInput({ portfolio: testPortfolio({ positions: [
      { symbol: "RNVDAUSDT", quantityMicros: 1, marketValueCents: 50_000, usedAsCollateral: true },
      { symbol: "RTSLAUSDT", quantityMicros: 1, marketValueCents: 145_000, usedAsCollateral: true },
    ] }) }));
    expect(aggregate.reasonCodes).toContain("AGGREGATE_CONCENTRATION");
    const stress = evaluateAgentGuard(baseGuardInput({ portfolio: testPortfolio({ collateralBufferPct: 17, positions: [
      { symbol: "RNVDAUSDT", quantityMicros: 1, marketValueCents: 50_000, usedAsCollateral: true },
      { symbol: "RTSLAUSDT", quantityMicros: 1, marketValueCents: 100_000, usedAsCollateral: true },
    ] }) }));
    expect(stress.reasonCodes).toContain("CORRELATED_STRESS");
    const drawdown = evaluateAgentGuard(baseGuardInput({ portfolio: testPortfolio({ accountEquityCents: 484_000 }), dailyBaselineEquityCents: 500_000 }));
    expect(drawdown.reasonCodes).toContain("DAILY_DRAWDOWN_BREAKER");
  });

  it("allows only reduce-only sells and applies the 0.65 confidence floor", () => {
    const tooLarge = evaluateAgentGuard(baseGuardInput({ assessment: testAssessment({ action: "REDUCE", proposedNotionalCents: 15_000 }),
      portfolio: testPortfolio({ positions: [{ symbol: "RNVDAUSDT", quantityMicros: 1, marketValueCents: 5_000, usedAsCollateral: true }] }) }));
    expect(tooLarge.reasonCodes).toContain("NOT_REDUCE_ONLY");
    const low = evaluateAgentGuard(baseGuardInput({ assessment: testAssessment({ action: "REDUCE", proposedNotionalCents: 5_000, confidence: 0.64 }) }));
    expect(low.reasonCodes).toContain("MODEL_CONFIDENCE_LOW");
    const okay = evaluateAgentGuard(baseGuardInput({ assessment: testAssessment({ action: "REDUCE", proposedNotionalCents: 5_000, confidence: 0.65 }) }));
    expect(okay).toMatchObject({ permission: "TRADE", side: "sell", allowedNotionalCents: 5_000 });
  });
});
