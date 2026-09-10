import { createHash, randomUUID } from "node:crypto";
import type {
  GapScenarioV1,
  GuardDecision,
  GuardEvaluationInput,
  GuardRuleResult,
  PortfolioSnapshot,
  ProductionMarketSnapshot,
  UserPolicy,
} from "../shared/production-types.js";
import { platformPolicy } from "../shared/production-types.js";
import type { DailyOrderUsage } from "./platform-repository.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function productionHash(value: unknown) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function gapScenarios(positionCents: number, portfolio: PortfolioSnapshot): GapScenarioV1[] {
  return [-3, -8, -12].map((gapPct) => {
    const pnlCents = Math.round(positionCents * gapPct / 100);
    const change = Math.abs(pnlCents) / portfolio.accountEquityCents * 100;
    return {
      gapPct,
      pnlCents,
      projectedCollateralBufferPct: Math.max(0, Math.round((portfolio.collateralBufferPct - change) * 10) / 10),
    };
  });
}

export function evaluateProductionGuard(args: {
  userId: string;
  input: GuardEvaluationInput;
  snapshot: ProductionMarketSnapshot;
  portfolio: PortfolioSnapshot;
  policy: UserPolicy;
  policyVersion: string;
  dailyUsage: DailyOrderUsage;
  now?: Date;
}): GuardDecision {
  const now = args.now ?? new Date();
  const { input, snapshot, portfolio, policy, dailyUsage } = args;
  const isIncrease = input.side === "buy";
  const position = portfolio.positions.find((item) => item.symbol === input.symbol);
  const currentPositionCents = position?.marketValueCents ?? 0;
  const projectedPositionCents = isIncrease
    ? currentPositionCents + input.notionalCents
    : Math.max(0, currentPositionCents - input.notionalCents);
  const gaps = gapScenarios(projectedPositionCents, portfolio);
  const ruleResults: GuardRuleResult[] = [];
  let permission: GuardDecision["permission"] = "TRADE";
  let cap = policy.maxPaperOrderCents;

  const addRule = (code: string, message: string, effect: GuardRuleResult["effect"], scope: GuardRuleResult["scope"]) => {
    ruleResults.push({ code, message, effect, scope });
  };
  const block = (code: string, reason: string, scope: GuardRuleResult["scope"]) => {
    permission = "BLOCK";
    addRule(code, reason, "BLOCK", scope);
  };
  const alert = (code: string, reason: string, scope: GuardRuleResult["scope"]) => {
    if (permission !== "BLOCK") permission = "ALERT_ONLY";
    addRule(code, reason, "ALERT", scope);
  };
  const capped = (code: string, reason: string, scope: GuardRuleResult["scope"] = "ORDER") => {
    addRule(code, reason, "CAP", scope);
  };

  if (snapshot.dataMode !== input.dataMode) block("DATA_MODE_MISMATCH", "The requested and evaluated data modes do not match.", "DATA");
  if (snapshot.session === "MARKET_UNAVAILABLE") block("MARKET_UNAVAILABLE", "Bitget market data is unavailable or stale.", "MARKET");
  if (snapshot.dataMode === "LIVE_BITGET" && snapshot.quoteAgeMs > platformPolicy.quoteMaxAgeMs) block("STALE_QUOTE", "The Bitget quote is older than ten seconds.", "DATA");
  if (snapshot.referenceQuality === "MISSING" || snapshot.anchorPriceMicros === null) block("ANCHOR_MISSING", "No Bitget cash-session anchor is available.", "DATA");
  if (now.getTime() - new Date(portfolio.capturedAt).getTime() > platformPolicy.portfolioMaxAgeMs) block("STALE_PORTFOLIO", "The Bitget Demo portfolio is older than fifteen seconds.", "PORTFOLIO");

  if ((snapshot.session === "WEEKEND" || snapshot.session === "HOLIDAY") && isIncrease) {
    block("CASH_MARKET_DARK", "Exposure-increasing orders are disabled on weekends and US cash-market holidays.", "MARKET");
  }
  if (!isIncrease && input.notionalCents > currentPositionCents) {
    block("NOT_REDUCE_ONLY", "The requested sell is larger than the current rToken position.", "ORDER");
  }

  if (snapshot.session === "EXTENDED") {
    if (!policy.allowExtended) block("EXTENDED_DISABLED", "The user disabled extended-session paper orders.", "MARKET");
    cap = Math.min(cap, Math.floor(policy.maxPaperOrderCents * policy.extendedSizePct / 100));
    capped("EXTENDED_SIZE_CAP", `Extended-session notional is capped at $${(cap / 100).toFixed(2)}.`);
    if (snapshot.spreadBps > policy.maxExtendedSpreadBps) alert("EXTENDED_SPREAD", "The Bitget spread exceeds the extended-session tolerance.", "MARKET");
  } else if (snapshot.spreadBps > policy.maxCashSpreadBps) {
    alert("SPREAD_LIMIT", "The Bitget spread exceeds the configured tolerance.", "MARKET");
  }

  if (snapshot.offHoursMoveBps !== null && Math.abs(snapshot.offHoursMoveBps) > policy.maxOffHoursMoveBps) {
    alert("OFF_HOURS_MOVE_LIMIT", "The rToken move from its Bitget cash-session anchor exceeds the configured tolerance.", "MARKET");
  }
  if (input.earningsWindow) {
    cap = Math.min(cap, Math.floor(policy.maxPaperOrderCents * policy.earningsSizePct / 100));
    capped("EARNINGS_SIZE_CAP", `Earnings-window notional is capped at $${(cap / 100).toFixed(2)}.`);
  }

  if (dailyUsage.count >= platformPolicy.dailyOrderCount) block("DAILY_ORDER_LIMIT", "The daily paper-order count limit has been reached.", "OPERATIONS");
  if (isIncrease) {
    const dailyRemaining = platformPolicy.dailyGrossNewNotionalCents - dailyUsage.grossNewNotionalCents;
    cap = Math.min(cap, Math.max(0, dailyRemaining));
    if (dailyRemaining <= 0) block("DAILY_NOTIONAL_LIMIT", "The daily gross new-notional limit has been reached.", "OPERATIONS");

    const spendableBalanceCents = Math.max(0, portfolio.availableBalanceCents);
    const cappedRequestCents = Math.min(input.notionalCents, cap);
    if (spendableBalanceCents <= 0) {
      block("INSUFFICIENT_AVAILABLE_BALANCE", "Bitget Demo reports no spendable USDT or positive UTA effective equity for this order.", "PORTFOLIO");
    } else if (spendableBalanceCents < cappedRequestCents) {
      cap = spendableBalanceCents;
      capped("AVAILABLE_BALANCE_CAP", `Spendable Bitget Demo balance caps this order at USD ${(cap / 100).toFixed(2)}.`, "PORTFOLIO");
    }
  }

  const stressEight = gaps.find((item) => item.gapPct === -8);
  if (isIncrease && position?.usedAsCollateral !== false && stressEight && stressEight.projectedCollateralBufferPct < policy.minCollateralBufferPct) {
    block("COLLATERAL_STRESS", "An 8% downside scenario breaches the required collateral buffer.", "PORTFOLIO");
  }
  if (cap <= 0) block("ZERO_SIZE_CAP", "The active policy permits no additional notional.", "ORDER");

  if (!ruleResults.length) {
    addRule("POLICY_PASS", "Session, Bitget anchor, spread, portfolio, stress, and operational checks passed.", "PASS", "ORDER");
  }

  const effectRank: Record<GuardRuleResult["effect"], number> = { BLOCK: 0, ALERT: 1, CAP: 2, PASS: 3 };
  const orderedRules = [...ruleResults].sort((left, right) => effectRank[left.effect] - effectRank[right.effect]);
  const primaryEffect: GuardRuleResult["effect"] = orderedRules.some((rule) => rule.effect === "BLOCK")
    ? "BLOCK"
    : orderedRules.some((rule) => rule.effect === "ALERT") ? "ALERT" : orderedRules[0].effect;
  const primaryRule = orderedRules.find((rule) => rule.effect === primaryEffect) ?? orderedRules[0];
  const reasonCodes = orderedRules.map((rule) => rule.code);
  const reasons = orderedRules.map((rule) => rule.message);

  const marketHash = productionHash(snapshot);
  const portfolioHash = productionHash(portfolio);
  const effectivePolicyVersion = `${platformPolicy.version}:${args.policyVersion}`;
  const inputHash = productionHash({ input, marketHash, portfolioHash, effectivePolicyVersion });
  return {
    id: randomUUID(),
    userId: args.userId,
    createdAt: now.toISOString(),
    permission,
    symbol: input.symbol,
    side: input.side,
    requestedNotionalCents: input.notionalCents,
    allowedNotionalCents: permission === "TRADE" ? Math.min(input.notionalCents, cap) : 0,
    maxSlippageBps: input.maxSlippageBps,
    reasonCodes,
    reasons,
    primaryReasonCode: primaryRule.code,
    primaryReason: primaryRule.message,
    ruleResults: orderedRules,
    gapScenarios: gaps,
    stressExposureCents: projectedPositionCents,
    availableBalanceCents: portfolio.availableBalanceCents,
    startingCollateralBufferPct: portfolio.collateralBufferPct,
    requiredCollateralBufferPct: policy.minCollateralBufferPct,
    policyVersion: effectivePolicyVersion,
    inputHash,
    marketHash,
    portfolioHash,
    snapshot,
    portfolioCapturedAt: portfolio.capturedAt,
    dataMode: input.dataMode,
  };
}
