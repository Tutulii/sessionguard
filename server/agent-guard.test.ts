import { describe, expect, it } from "vitest";
import { calculateAgentRiskSizing, evaluateAgentGuard } from "./agent-guard.js";
import { baseGuardInput, testAssessment, testContext, testEvent, testGrant, testMarket, testPortfolio, testSettings } from "./agent-test-fixtures.js";

const maxSettings = () => testSettings("PAPER_AUTO", { automaticOrderLimitCents: 25_000 });
const maxGrant = () => testGrant({ automaticOrderLimitCents: 25_000 });

describe("deterministic agent authorization", () => {
  it("risk-sizes a valid cash-open 8-K BUY instead of treating the ceiling as the order", () => {
    const result = evaluateAgentGuard(baseGuardInput());
    expect(result).toMatchObject({ permission: "TRADE", requestedNotionalCents: 15_000, allowedNotionalCents: 6_111, side: "buy" });
    expect(result.reasonCodes).toEqual(["AGENT_POLICY_PASS"]);
    expect(result.sizing).toMatchObject({
      configuredCeilingCents: 10_000,
      equityCapCents: 10_000,
      preMultiplierCents: 10_000,
      confidenceMultiplierBps: 7_750,
      liquidityMultiplierBps: 9_857,
      eventMultiplierBps: 8_000,
      riskSizedNotionalCents: 6_111,
    });
  });

  it("never increases Qwen size and respects a tighter user/grant ceiling", () => {
    const result = evaluateAgentGuard(baseGuardInput({
      assessment: testAssessment({ proposedNotionalCents: 7_500 }),
      settings: testSettings("PAPER_AUTO", { automaticOrderLimitCents: 6_000 }),
      grant: testGrant({ automaticOrderLimitCents: 5_000 }),
    }));
    expect(result.allowedNotionalCents).toBe(3_055);
    expect(result.sizing?.configuredCeilingCents).toBe(5_000);
    expect(result.sizing?.limitingFactors).toContain("CONFIGURED_CEILING");
    expect(result.allowedNotionalCents).toBeLessThanOrEqual(result.requestedNotionalCents);
  });

  it("keeps $250 as the absolute automatic ceiling", () => {
    const market = testMarket({ spreadBps: 0 });
    const result = evaluateAgentGuard(baseGuardInput({
      assessment: testAssessment({ action: "REDUCE", proposedNotionalCents: 25_000, confidence: 1 }),
      settings: maxSettings(),
      grant: maxGrant(),
      market,
      context: testContext({ market: (({ chart: _chart, ...rest }) => rest)(market) }),
    }));
    expect(result).toMatchObject({ permission: "TRADE", allowedNotionalCents: 25_000 });
    expect(result.sizing?.configuredCeilingCents).toBe(25_000);
    expect(result.allowedNotionalCents).toBeLessThanOrEqual(25_000);
  });

  it("uses account equity and existing exposure to reduce BUY size", () => {
    const base = calculateAgentRiskSizing(baseGuardInput({ settings: maxSettings(), grant: maxGrant(),
      assessment: testAssessment({ proposedNotionalCents: 25_000, confidence: 1 }), market: testMarket({ spreadBps: 0 }) }));
    const larger = calculateAgentRiskSizing(baseGuardInput({ settings: maxSettings(), grant: maxGrant(),
      assessment: testAssessment({ proposedNotionalCents: 25_000, confidence: 1 }), market: testMarket({ spreadBps: 0 }),
      portfolio: testPortfolio({ accountEquityCents: 1_000_000 }) }));
    const concentrated = evaluateAgentGuard(baseGuardInput({ settings: maxSettings(), grant: maxGrant(),
      assessment: testAssessment({ proposedNotionalCents: 25_000 }),
      portfolio: testPortfolio({ positions: [{ symbol: "RNVDAUSDT", quantityMicros: 1, marketValueCents: 95_000, usedAsCollateral: true }] }) }));
    expect(base.equityCapCents).toBe(10_000);
    expect(base.riskSizedNotionalCents).toBe(8_000);
    expect(larger.equityCapCents).toBe(20_000);
    expect(larger.riskSizedNotionalCents).toBe(16_000);
    expect(concentrated.permission).toBe("TRADE");
    expect(concentrated.sizing?.singleNameHeadroomCents).toBe(5_000);
    expect(concentrated.sizing?.limitingFactors).toContain("SINGLE_NAME_HEADROOM");
    expect(concentrated.allowedNotionalCents).toBe(3_055);
  });

  it("sizes down for remaining aggregate, collateral, spendable, and daily headroom", () => {
    const aggregate = calculateAgentRiskSizing(baseGuardInput({ settings: maxSettings(), grant: maxGrant(),
      assessment: testAssessment({ proposedNotionalCents: 25_000 }),
      portfolio: testPortfolio({ positions: [
        { symbol: "RNVDAUSDT", quantityMicros: 1, marketValueCents: 50_000, usedAsCollateral: true },
        { symbol: "RTSLAUSDT", quantityMicros: 1, marketValueCents: 145_000, usedAsCollateral: true },
      ] }) }));
    const collateral = calculateAgentRiskSizing(baseGuardInput({ settings: maxSettings(), grant: maxGrant(),
      assessment: testAssessment({ proposedNotionalCents: 25_000 }),
      portfolio: testPortfolio({ collateralBufferPct: 15.1, positions: [] }) }));
    const spendable = calculateAgentRiskSizing(baseGuardInput({ settings: maxSettings(), grant: maxGrant(),
      assessment: testAssessment({ proposedNotionalCents: 25_000 }),
      portfolio: testPortfolio({ availableBalanceCents: 2_000 }) }));
    const daily = evaluateAgentGuard(baseGuardInput({ settings: maxSettings(), grant: maxGrant(),
      assessment: testAssessment({ proposedNotionalCents: 25_000 }),
      automaticUsage: { count: 1, grossNewNotionalCents: 45_000 } }));
    expect(aggregate.aggregateHeadroomCents).toBe(5_000);
    expect(aggregate.limitingFactors).toContain("AGGREGATE_HEADROOM");
    expect(collateral.collateralStressHeadroomCents).toBe(4_166);
    expect(collateral.limitingFactors).toContain("COLLATERAL_STRESS_HEADROOM");
    expect(spendable.spendableBalanceCents).toBe(2_000);
    expect(spendable.limitingFactors).toContain("SPENDABLE_BALANCE");
    expect(daily.permission).toBe("TRADE");
    expect(daily.sizing?.dailyHeadroomCents).toBe(5_000);
    expect(daily.sizing?.limitingFactors).toContain("DAILY_HEADROOM");
    expect(daily.allowedNotionalCents).toBe(3_055);
  });

  it("scales deterministically for confidence, spread liquidity, form type, and caution flags", () => {
    const sizing = (overrides: Record<string, unknown> = {}) => calculateAgentRiskSizing(baseGuardInput({
      settings: maxSettings(), grant: maxGrant(), assessment: testAssessment({ proposedNotionalCents: 25_000, confidence: 1 }),
      market: testMarket({ spreadBps: 0 }), ...overrides,
    }));
    const lowConfidence = sizing({ assessment: testAssessment({ proposedNotionalCents: 25_000, confidence: 0.81 }) });
    const highConfidence = sizing({ assessment: testAssessment({ proposedNotionalCents: 25_000, confidence: 0.99 }) });
    const tight = sizing();
    const wider = sizing({ market: testMarket({ spreadBps: 30 }) });
    const earnings = sizing({ event: testEvent({ formType: "10-Q" }) });
    const suspension = sizing({ event: testEvent({ cautionFlags: ["POSSIBLE_SUSPENSION_LANGUAGE"] }) });
    expect(lowConfidence.riskSizedNotionalCents).toBeLessThan(highConfidence.riskSizedNotionalCents);
    expect(wider.riskSizedNotionalCents).toBeLessThan(tight.riskSizedNotionalCents);
    expect(tight.eventMultiplierBps).toBe(8_000);
    expect(earnings.eventMultiplierBps).toBe(5_000);
    expect(suspension.eventMultiplierBps).toBe(2_500);
    expect(suspension.riskSizedNotionalCents).toBeLessThan(earnings.riskSizedNotionalCents);
  });

  it("turns base-policy caution into ALERT_ONLY, not a false hard block", () => {
    const market = testMarket({ spreadBps: 40 });
    const result = evaluateAgentGuard(baseGuardInput({ market, context: testContext({ market: (({ chart: _chart, ...rest }) => rest)(market) }) }));
    expect(result.permission).toBe("ALERT_ONLY");
    expect(result.reasonCodes).toContain("SPREAD_LIMIT");
  });

  it("keeps shadow structurally non-executing while exposing the risk-sized policy result", () => {
    const result = evaluateAgentGuard(baseGuardInput({ settings: testSettings("SHADOW"), grant: null, eligibleForPaperAuto: false }));
    expect(result).toMatchObject({ permission: "TRADE", allowedNotionalCents: 6_111 });
    expect(result.reasonCodes).toEqual(["SHADOW_POLICY_PASS"]);
  });

  it("keeps alert-only non-executing even when every deterministic gate passes", () => {
    const result = evaluateAgentGuard(baseGuardInput({ settings: testSettings("ALERT_ONLY"), grant: null }));
    expect(result).toMatchObject({ permission: "ALERT_ONLY", allowedNotionalCents: 0 });
    expect(result.sizing?.riskSizedNotionalCents).toBe(6_111);
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
    ["daily notional exhausted", { automaticUsage: { count: 1, grossNewNotionalCents: 50_000 } }, "AGENT_DAILY_NOTIONAL_LIMIT"],
  ])("fails closed for %s", (_name, overrides, code) => {
    const result = evaluateAgentGuard(baseGuardInput(overrides));
    expect(result.permission).toBe("BLOCK");
    expect(result.allowedNotionalCents).toBe(0);
    expect(result.reasonCodes).toContain(code);
  });

  it.each(["global", "user", "symbol", "runtime", "model", "provider"] as const)("prioritizes the %s kill switch", (key) => {
    const killSwitches = { global: false, user: false, symbol: false, runtime: false, model: false, provider: false, [key]: true };
    expect(evaluateAgentGuard(baseGuardInput({ killSwitches })).reasonCodes).toContain("AGENT_RUNTIME_KILLED");
  });

  it("blocks only when concentration or stress has no remaining capacity, and keeps the drawdown breaker", () => {
    const single = evaluateAgentGuard(baseGuardInput({ portfolio: testPortfolio({ positions: [
      { symbol: "RNVDAUSDT", quantityMicros: 1, marketValueCents: 100_000, usedAsCollateral: true },
    ] }) }));
    expect(single.reasonCodes).toContain("SINGLE_NAME_CONCENTRATION");
    const aggregate = evaluateAgentGuard(baseGuardInput({ portfolio: testPortfolio({ positions: [
      { symbol: "RNVDAUSDT", quantityMicros: 1, marketValueCents: 50_000, usedAsCollateral: true },
      { symbol: "RTSLAUSDT", quantityMicros: 1, marketValueCents: 150_000, usedAsCollateral: true },
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

  it("allows only reduce-only sells and sizes them by confidence and liquidity", () => {
    const tooLarge = evaluateAgentGuard(baseGuardInput({
      assessment: testAssessment({ action: "REDUCE", proposedNotionalCents: 15_000 }),
      portfolio: testPortfolio({ positions: [{ symbol: "RNVDAUSDT", quantityMicros: 1, marketValueCents: 5_000, usedAsCollateral: true }] }),
    }));
    expect(tooLarge.reasonCodes).toContain("NOT_REDUCE_ONLY");
    const low = evaluateAgentGuard(baseGuardInput({ assessment: testAssessment({ action: "REDUCE", proposedNotionalCents: 5_000, confidence: 0.64 }) }));
    expect(low.reasonCodes).toContain("MODEL_CONFIDENCE_LOW");
    const okay = evaluateAgentGuard(baseGuardInput({ assessment: testAssessment({ action: "REDUCE", proposedNotionalCents: 5_000, confidence: 0.65 }) }));
    expect(okay).toMatchObject({ permission: "TRADE", side: "sell", allowedNotionalCents: 2_464 });
  });
});
