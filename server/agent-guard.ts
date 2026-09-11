import {
  agentPolicy,
  type AgentAssessmentV1,
  type AgentAuthorizationV1,
  type AgentContextV1,
  type AgentGrantV1,
  type AgentRiskSizingV1,
  type AgentSettingsV1,
  type OfficialEventV1,
} from "../shared/agent-types.js";
import type { PortfolioSnapshot, ProductionMarketSnapshot, UserPolicy } from "../shared/production-types.js";
import type { AgentAutomaticUsage } from "./agent-repository.js";
import type { DailyOrderUsage } from "./platform-repository.js";
import { evaluateProductionGuard } from "./production-rules.js";

export type AgentKillSwitches = { global: boolean; user: boolean; symbol: boolean; runtime: boolean; model: boolean; provider: boolean };

export type AgentGuardInput = {
  userId: string;
  assessment: AgentAssessmentV1;
  context: AgentContextV1;
  settings: AgentSettingsV1;
  grant: AgentGrantV1 | null;
  event: OfficialEventV1 | null;
  market: ProductionMarketSnapshot;
  portfolio: PortfolioSnapshot;
  userPolicy: UserPolicy;
  userPolicyVersion: string;
  platformUsage: DailyOrderUsage;
  automaticUsage: AgentAutomaticUsage;
  dailyBaselineEquityCents: number;
  outstandingSameSymbolOrder: boolean;
  eventAlreadyActioned: boolean;
  symbolCooldownActive: boolean;
  eligibleForPaperAuto: boolean;
  killSwitches: AgentKillSwitches;
  now?: Date;
};

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const nonnegativeFloor = (value: number) => Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));

function confidenceMultiplierBps(action: AgentAssessmentV1["action"], confidence: number) {
  const minimum = action === "REDUCE" ? agentPolicy.minimumReduceConfidence : agentPolicy.minimumBuyConfidence;
  if (confidence < minimum) return 0;
  return Math.round(5_000 + 5_000 * clamp((confidence - minimum) / Math.max(0.01, 1 - minimum), 0, 1));
}

function liquidityMultiplierBps(input: AgentGuardInput) {
  const tolerance = input.market.session === "CASH_OPEN"
    ? input.userPolicy.maxCashSpreadBps
    : input.userPolicy.maxExtendedSpreadBps;
  return Math.round(10_000 - 5_000 * clamp(input.market.spreadBps / Math.max(1, tolerance), 0, 1));
}

function eventMultiplierBps(input: AgentGuardInput) {
  if (input.assessment.action === "REDUCE") return 10_000;
  let multiplier = input.event?.formType === "10-Q" || input.event?.formType === "10-K" ? 5_000
    : input.event?.formType === "IR_RELEASE" ? 7_000
      : input.event?.formType === "8-K" || input.event?.formType === "6-K" ? 8_000 : 6_500;
  if (input.event?.cautionFlags.includes("LATE_DETECTION")) multiplier = Math.min(multiplier, 6_000);
  if (input.event?.cautionFlags.includes("CORRECTION")) multiplier = Math.min(multiplier, 4_000);
  if (input.event?.cautionFlags.includes("POSSIBLE_SUSPENSION_LANGUAGE")) multiplier = Math.min(multiplier, 2_500);
  return multiplier;
}

export function calculateAgentRiskSizing(input: AgentGuardInput): AgentRiskSizingV1 {
  const action = input.assessment.action;
  const requested = input.assessment.proposedNotionalCents;
  const configuredCeilingCents = Math.min(
    agentPolicy.maxAutomaticOrderCents,
    input.context.platformMaximumNotionalCents,
    input.userPolicy.maxPaperOrderCents,
    input.settings.automaticOrderLimitCents,
    input.grant?.automaticOrderLimitCents ?? agentPolicy.maxAutomaticOrderCents,
  );
  const equity = Math.max(1, input.portfolio.accountEquityCents);
  const current = input.portfolio.positions.find((position) => position.symbol === input.assessment.symbol)?.marketValueCents ?? 0;
  const aggregate = input.portfolio.positions.reduce((sum, position) => sum + position.marketValueCents, 0);
  const dailyGross = Math.min(
    input.settings.automaticGrossNewNotionalCents,
    input.grant?.automaticGrossNewNotionalCents ?? agentPolicy.maxAutomaticGrossNewNotionalCents,
  );
  const requiredBuffer = Math.max(input.userPolicy.minCollateralBufferPct, input.settings.minCollateralBufferPct);
  const stressCapacity = (input.portfolio.collateralBufferPct - requiredBuffer) / 12 * equity;
  const increasing = action === "BUY";
  const equityCapCents = increasing
    ? nonnegativeFloor(equity * agentPolicy.maxAutomaticOrderEquityPct / 100)
    : configuredCeilingCents;
  const singleNameHeadroomCents = increasing
    ? nonnegativeFloor(equity * agentPolicy.maximumSingleNameExposurePct / 100 - current)
    : current;
  const aggregateHeadroomCents = increasing
    ? nonnegativeFloor(equity * agentPolicy.maximumAggregateExposurePct / 100 - aggregate)
    : current;
  const collateralStressHeadroomCents = increasing
    ? nonnegativeFloor(stressCapacity - aggregate)
    : current;
  const spendableBalanceCents = increasing ? nonnegativeFloor(input.portfolio.availableBalanceCents) : current;
  const dailyHeadroomCents = increasing
    ? nonnegativeFloor(dailyGross - input.automaticUsage.grossNewNotionalCents)
    : configuredCeilingCents;
  const preMultiplierCents = Math.min(
    requested,
    configuredCeilingCents,
    equityCapCents,
    singleNameHeadroomCents,
    aggregateHeadroomCents,
    collateralStressHeadroomCents,
    spendableBalanceCents,
    dailyHeadroomCents,
  );
  const confidenceBps = confidenceMultiplierBps(action, input.assessment.confidence);
  const liquidityBps = liquidityMultiplierBps(input);
  const eventBps = eventMultiplierBps(input);
  const riskSizedNotionalCents = nonnegativeFloor(
    preMultiplierCents * confidenceBps / 10_000 * liquidityBps / 10_000 * eventBps / 10_000,
  );
  const limitingFactors: AgentRiskSizingV1["limitingFactors"] = [];
  const add = (factor: AgentRiskSizingV1["limitingFactors"][number]) => {
    if (!limitingFactors.includes(factor)) limitingFactors.push(factor);
  };
  const requestedOrCeiling = Math.min(requested, configuredCeilingCents);
  if (configuredCeilingCents <= requested) add("CONFIGURED_CEILING");
  if (equityCapCents <= requestedOrCeiling) add("EQUITY_BUDGET");
  if (singleNameHeadroomCents <= requestedOrCeiling) add("SINGLE_NAME_HEADROOM");
  if (aggregateHeadroomCents <= requestedOrCeiling) add("AGGREGATE_HEADROOM");
  if (collateralStressHeadroomCents <= requestedOrCeiling) add("COLLATERAL_STRESS_HEADROOM");
  if (spendableBalanceCents <= requestedOrCeiling) add("SPENDABLE_BALANCE");
  if (dailyHeadroomCents <= requestedOrCeiling) add("DAILY_HEADROOM");
  if (confidenceBps < 10_000) add("CONFIDENCE_SCALE");
  if (liquidityBps < 10_000) add("LIQUIDITY_SCALE");
  if (eventBps < 10_000) add("EVENT_RISK_SCALE");
  return {
    configuredCeilingCents,
    requestedNotionalCents: requested,
    equityCapCents,
    singleNameHeadroomCents,
    aggregateHeadroomCents,
    collateralStressHeadroomCents,
    spendableBalanceCents,
    dailyHeadroomCents,
    confidenceMultiplierBps: confidenceBps,
    liquidityMultiplierBps: liquidityBps,
    eventMultiplierBps: eventBps,
    preMultiplierCents,
    riskSizedNotionalCents,
    limitingFactors,
  };
}

function reason(code: string) {
  const text: Record<string, string> = {
    AGENT_HOLD: "Qwen proposed no trade.", AGENT_WAIT: "Qwen proposed waiting for safer or fresher conditions.",
    HUMAN_COLLATERAL_ACTION: "Adding collateral requires a human; SessionGuard cannot move funds.",
    AGENT_RUNTIME_KILLED: "An agent execution kill switch is active.", AGENT_MODE_NO_EXECUTION: "This mode can observe and alert but cannot execute.",
    LOCAL_REPLAY_ONLY: "Replay decisions are local simulations and can never reach Bitget.", CASH_OPEN_REQUIRED: "Automatic Demo orders require the US cash session to be open.",
    MODEL_CONFIDENCE_LOW: "Qwen confidence is below the autonomous threshold.", BUY_EVIDENCE_GATE: "An autonomous buy requires a new or updated, highly relevant official event.",
    EVENT_MISSING: "An autonomous buy requires a bound official event.", EVENT_TOO_OLD: "The official event is older than 24 hours.",
    EVENT_SUPERSEDED: "The official event has been corrected or superseded.", EVENT_CHANGED: "The official event version changed after context assembly.", EVENT_TIME_INVALID: "The official event effective time is not valid yet.", GRANT_REQUIRED: "A current seven-day background-execution grant is required.",
    GRANT_EXPIRED: "The background-execution grant expired.", GRANT_SCOPE_MISMATCH: "The proposed order is outside the signed grant scope.",
    SHADOW_ELIGIBILITY_REQUIRED: "PAPER_AUTO requires 24 hours and 10 qualifying live shadow runs.",
    OUTSTANDING_ORDER: "An unresolved Demo order exists for this symbol.", EVENT_ALREADY_ACTIONED: "This official event already produced an automatic action.",
    SYMBOL_COOLDOWN: "The symbol is inside its 60-minute automatic-order cooldown.", AGENT_DAILY_ORDER_LIMIT: "The signed automatic daily order limit is reached.",
    AGENT_DAILY_NOTIONAL_LIMIT: "The signed automatic daily new-notional limit is reached.", SINGLE_NAME_CONCENTRATION: "Projected single-name exposure exceeds 20% of Demo equity.",
    AGGREGATE_CONCENTRATION: "Projected supported-rToken exposure exceeds 40% of Demo equity.", CORRELATED_STRESS: "A correlated 12% rToken shock breaches the required collateral buffer.",
    DAILY_DRAWDOWN_BREAKER: "Demo equity is down at least 3% from the first valid UTC-day snapshot.",
    NOT_REDUCE_ONLY: "The requested reduction is larger than the current rToken position.",
    RISK_SIZE_ZERO: "Portfolio, exposure, liquidity, event, confidence, or daily risk capacity permits no automatic order.",
  };
  return text[code] ?? code;
}

export function evaluateAgentGuard(input: AgentGuardInput): AgentAuthorizationV1 {
  const now = input.now ?? new Date(); const action = input.assessment.action;
  if (action === "HOLD" || action === "WAIT" || action === "ADD_COLLATERAL") {
    const code = action === "HOLD" ? "AGENT_HOLD" : action === "WAIT" ? "AGENT_WAIT" : "HUMAN_COLLATERAL_ACTION";
    return { permission: action === "ADD_COLLATERAL" ? "ALERT_ONLY" : "BLOCK", requestedNotionalCents: 0,
      allowedNotionalCents: 0, side: null, reasonCodes: [code], reasons: [reason(code)], guardDecision: null };
  }

  const side = action === "BUY" ? "buy" as const : "sell" as const;
  const requested = input.assessment.proposedNotionalCents;
  const sizing = calculateAgentRiskSizing(input);
  const guardNotional = Math.max(1, sizing.riskSizedNotionalCents);
  const earningsWindow = Boolean(input.event && ["10-Q", "10-K"].includes(input.event.formType));
  const base = evaluateProductionGuard({ userId: input.userId, input: { symbol: input.assessment.symbol, side,
    notionalCents: guardNotional, maxSlippageBps: 35, dataMode: input.market.dataMode,
    replayId: input.context.trigger.replayId ?? undefined, earningsWindow }, snapshot: input.market,
    portfolio: input.portfolio, policy: input.userPolicy, policyVersion: input.userPolicyVersion,
    dailyUsage: input.platformUsage, now });

  const blockCodes: string[] = base.permission === "BLOCK" ? [...base.reasonCodes] : [];
  const blockReasons: string[] = base.permission === "BLOCK" ? [...base.reasons] : [];
  const alertCodes: string[] = base.permission === "ALERT_ONLY" ? [...base.reasonCodes] : [];
  const alertReasons: string[] = base.permission === "ALERT_ONLY" ? [...base.reasons] : [];
  const veto = (code: string) => { if (!blockCodes.includes(code)) { blockCodes.push(code); blockReasons.push(reason(code)); } };
  const isIncrease = side === "buy";

  if (Object.values(input.killSwitches).some(Boolean)) veto("AGENT_RUNTIME_KILLED");
  if (input.settings.mode === "DISABLED") veto("AGENT_MODE_NO_EXECUTION");
  if (input.settings.mode === "PAPER_AUTO" && input.market.session !== "CASH_OPEN") veto("CASH_OPEN_REQUIRED");
  const minimum = isIncrease ? agentPolicy.minimumBuyConfidence : agentPolicy.minimumReduceConfidence;
  if (input.assessment.confidence < minimum) veto("MODEL_CONFIDENCE_LOW");
  if (input.context.event && (!input.event || input.event.versionId !== input.context.event.versionId ||
    input.event.contentHash !== input.context.event.contentHash)) veto("EVENT_CHANGED");

  if (isIncrease) {
    if (!input.event || input.assessment.eventId !== input.event.id || input.context.trigger.type !== "OFFICIAL_EVENT") veto("EVENT_MISSING");
    if (input.assessment.relevance !== "HIGH" || !["NEW", "UPDATE"].includes(input.assessment.novelty)) veto("BUY_EVIDENCE_GATE");
    if (input.event && now.getTime() < new Date(input.event.effectiveAt).getTime()) veto("EVENT_TIME_INVALID");
    if (input.event && now.getTime() - new Date(input.event.effectiveAt).getTime() > agentPolicy.maximumEventAgeMs) veto("EVENT_TOO_OLD");
    if (input.event?.supersededByEventId) veto("EVENT_SUPERSEDED");
  }

  if (input.settings.mode === "PAPER_AUTO") {
    if (!input.eligibleForPaperAuto) veto("SHADOW_ELIGIBILITY_REQUIRED");
    if (!input.grant) veto("GRANT_REQUIRED");
    else {
      if (new Date(input.grant.expiresAt).getTime() <= now.getTime() || input.grant.revokedAt) veto("GRANT_EXPIRED");
      if (!input.grant.symbols.includes(input.assessment.symbol) || !input.grant.actions.includes(action) ||
        input.grant.executionMode !== "BITGET_DEMO" || !input.grant.cashOpenOnly ||
        input.grant.policyVersion !== input.settings.policyVersion || input.grant.settingsVersion !== input.settings.settingsVersion) veto("GRANT_SCOPE_MISMATCH");
    }
  }
  if (input.outstandingSameSymbolOrder) veto("OUTSTANDING_ORDER");
  if (input.eventAlreadyActioned) veto("EVENT_ALREADY_ACTIONED");
  if (input.symbolCooldownActive) veto("SYMBOL_COOLDOWN");
  const dailyCount = Math.min(input.settings.automaticOrdersPerDay, input.grant?.automaticOrdersPerDay ?? agentPolicy.maxAutomaticOrdersPerUtcDay);
  if (input.automaticUsage.count >= dailyCount) veto("AGENT_DAILY_ORDER_LIMIT");
  if (isIncrease && sizing.dailyHeadroomCents <= 0) veto("AGENT_DAILY_NOTIONAL_LIMIT");
  if (sizing.riskSizedNotionalCents <= 0) veto("RISK_SIZE_ZERO");
  if (!isIncrease) {
    const currentPositionCents = input.portfolio.positions.find((position) => position.symbol === input.assessment.symbol)?.marketValueCents ?? 0;
    if (requested > currentPositionCents) veto("NOT_REDUCE_ONLY");
  }

  if (isIncrease) {
    const equity = input.portfolio.accountEquityCents;
    const aggregate = input.portfolio.positions.reduce((sum, position) => sum + position.marketValueCents, 0);
    if (sizing.singleNameHeadroomCents <= 0) veto("SINGLE_NAME_CONCENTRATION");
    if (sizing.aggregateHeadroomCents <= 0) veto("AGGREGATE_CONCENTRATION");
    const correlatedBuffer = input.portfolio.collateralBufferPct - ((aggregate + guardNotional) * 0.12 / equity * 100);
    if (sizing.collateralStressHeadroomCents <= 0 || correlatedBuffer < Math.max(input.userPolicy.minCollateralBufferPct, input.settings.minCollateralBufferPct)) veto("CORRELATED_STRESS");
    const drawdown = (input.dailyBaselineEquityCents - equity) / Math.max(1, input.dailyBaselineEquityCents) * 100;
    if (drawdown >= agentPolicy.maximumDailyDrawdownPct) veto("DAILY_DRAWDOWN_BREAKER");
  }

  if (blockCodes.length) return { permission: "BLOCK", requestedNotionalCents: requested, allowedNotionalCents: 0, side,
    reasonCodes: blockCodes, reasons: blockReasons, guardDecision: base, sizing };
  if (base.permission === "ALERT_ONLY") return { permission: "ALERT_ONLY", requestedNotionalCents: requested,
    allowedNotionalCents: 0, side, reasonCodes: alertCodes, reasons: alertReasons, guardDecision: base, sizing };
  if (input.settings.mode === "ALERT_ONLY") return { permission: "ALERT_ONLY", requestedNotionalCents: requested,
    allowedNotionalCents: 0, side, reasonCodes: ["ALERT_POLICY_PASS"],
    reasons: ["The proposal passed deterministic policy, but alert-only mode cannot execute."], guardDecision: base, sizing };
  const allowed = Math.min(base.allowedNotionalCents, sizing.riskSizedNotionalCents, requested);
  if (input.settings.mode === "SHADOW") return { permission: "TRADE", requestedNotionalCents: requested,
    allowedNotionalCents: allowed, side, reasonCodes: [input.context.trigger.sourceMode === "LOCAL_REPLAY" ? "LOCAL_REPLAY_POLICY_PASS" : "SHADOW_POLICY_PASS"],
    reasons: [input.context.trigger.sourceMode === "LOCAL_REPLAY" ? "The local replay passed deterministic policy; its shadow-only structure cannot issue a capability." : "The proposal passed deterministic policy in shadow mode; no capability or order was created."], guardDecision: base, sizing };
  return { permission: "TRADE", requestedNotionalCents: requested, allowedNotionalCents: allowed, side,
    reasonCodes: ["AGENT_POLICY_PASS"], reasons: ["Qwen evidence, session, grant, portfolio, risk sizing, and all deterministic safety gates passed."], guardDecision: base, sizing };
}
