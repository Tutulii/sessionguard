import { createHash, randomUUID } from "node:crypto";
import type {
  GapScenarioV1,
  GuardDecision,
  GuardEvaluationInput,
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
  const reasonCodes: string[] = [];
  const reasons: string[] = [];
  let permission: GuardDecision["permission"] = "TRADE";
  let cap = policy.maxPaperOrderCents;

  const block = (code: string, reason: string) => {
    permission = "BLOCK";
    reasonCodes.push(code);
    reasons.push(reason);
  };
  const alert = (code: string, reason: string) => {
    if (permission !== "BLOCK") permission = "ALERT_ONLY";
    reasonCodes.push(code);
    reasons.push(reason);
  };

  if (snapshot.dataMode !== input.dataMode) block("DATA_MODE_MISMATCH", "The requested and evaluated data modes do not match.");
  if (snapshot.session === "MARKET_UNAVAILABLE") block("MARKET_UNAVAILABLE", "Bitget market data is unavailable or stale.");
  if (snapshot.dataMode === "LIVE_BITGET" && snapshot.quoteAgeMs > platformPolicy.quoteMaxAgeMs) block("STALE_QUOTE", "The Bitget quote is older than ten seconds.");
  if (snapshot.referenceQuality === "MISSING" || snapshot.anchorPriceMicros === null) block("ANCHOR_MISSING", "No Bitget cash-session anchor is available.");
  if (now.getTime() - new Date(portfolio.capturedAt).getTime() > platformPolicy.portfolioMaxAgeMs) block("STALE_PORTFOLIO", "The Bitget Demo portfolio is older than fifteen seconds.");

  if ((snapshot.session === "WEEKEND" || snapshot.session === "HOLIDAY") && isIncrease) {
    block("CASH_MARKET_DARK", "Exposure-increasing orders are disabled on weekends and US cash-market holidays.");
  }
  if (!isIncrease && input.notionalCents > currentPositionCents) {
    block("NOT_REDUCE_ONLY", "The requested sell is larger than the current rToken position.");
  }

  if (snapshot.session === "EXTENDED") {
    if (!policy.allowExtended) block("EXTENDED_DISABLED", "The user disabled extended-session paper orders.");
    cap = Math.min(cap, Math.floor(policy.maxPaperOrderCents * policy.extendedSizePct / 100));
    reasonCodes.push("EXTENDED_SIZE_CAP");
    reasons.push(`Extended-session notional is capped at $${(cap / 100).toFixed(2)}.`);
    if (snapshot.spreadBps > policy.maxExtendedSpreadBps) alert("EXTENDED_SPREAD", "The Bitget spread exceeds the extended-session tolerance.");
  } else if (snapshot.spreadBps > policy.maxCashSpreadBps) {
    alert("SPREAD_LIMIT", "The Bitget spread exceeds the configured tolerance.");
  }

  if (snapshot.offHoursMoveBps !== null && Math.abs(snapshot.offHoursMoveBps) > policy.maxOffHoursMoveBps) {
    alert("OFF_HOURS_MOVE_LIMIT", "The rToken move from its Bitget cash-session anchor exceeds the configured tolerance.");
  }
  if (input.earningsWindow) {
    cap = Math.min(cap, Math.floor(policy.maxPaperOrderCents * policy.earningsSizePct / 100));
    reasonCodes.push("EARNINGS_SIZE_CAP");
    reasons.push(`Earnings-window notional is capped at $${(cap / 100).toFixed(2)}.`);
  }

  if (dailyUsage.count >= platformPolicy.dailyOrderCount) block("DAILY_ORDER_LIMIT", "The daily paper-order count limit has been reached.");
  if (isIncrease) {
    const dailyRemaining = platformPolicy.dailyGrossNewNotionalCents - dailyUsage.grossNewNotionalCents;
    cap = Math.min(cap, Math.max(0, dailyRemaining));
    if (dailyRemaining <= 0) block("DAILY_NOTIONAL_LIMIT", "The daily gross new-notional limit has been reached.");
  }

  const stressEight = gaps.find((item) => item.gapPct === -8);
  if (isIncrease && position?.usedAsCollateral !== false && stressEight && stressEight.projectedCollateralBufferPct < policy.minCollateralBufferPct) {
    block("COLLATERAL_STRESS", "An 8% downside scenario breaches the required collateral buffer.");
  }
  if (cap <= 0) block("ZERO_SIZE_CAP", "The active policy permits no additional notional.");

  if (!reasonCodes.length) {
    reasonCodes.push("POLICY_PASS");
    reasons.push("Session, Bitget anchor, spread, portfolio, stress, and operational checks passed.");
  }

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
    gapScenarios: gaps,
    policyVersion: effectivePolicyVersion,
    inputHash,
    marketHash,
    portfolioHash,
    snapshot,
    portfolioCapturedAt: portfolio.capturedAt,
    dataMode: input.dataMode,
  };
}
