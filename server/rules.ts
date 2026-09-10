import { randomUUID } from "node:crypto";
import {
  defaultAccount,
  defaultPolicy,
  type AccountContext,
  type AgentAssessment,
  type GapScenario,
  type MarketSnapshot,
  type PermissionDecision,
  type TradeIntent,
  type TradingPolicy,
  type Verdict,
} from "../shared/types.js";

export function calculateGapScenarios(
  positionUsd: number,
  accountEquityUsd: number,
  collateralBufferPct: number,
): GapScenario[] {
  if (!Number.isFinite(accountEquityUsd) || accountEquityUsd <= 0) {
    throw new Error("Account equity must be positive");
  }
  return [-3, -8, -12].map((gapPct) => {
    const pnlUsd = positionUsd * (gapPct / 100);
    const bufferChange = (Math.abs(pnlUsd) / accountEquityUsd) * 100;
    return {
      gapPct,
      pnlUsd: Math.round(pnlUsd * 100) / 100,
      projectedBufferPct: Math.max(0, Math.round((collateralBufferPct - bufferChange) * 10) / 10),
    };
  });
}

type EvaluationArgs = {
  snapshot: MarketSnapshot;
  assessment: AgentAssessment;
  intent: TradeIntent;
  policy?: TradingPolicy;
  account?: AccountContext;
  now?: Date;
};

function evaluateUnchecked(args: EvaluationArgs): PermissionDecision {
  const { snapshot, assessment, intent } = args;
  const policy = args.policy ?? intent.policy ?? defaultPolicy;
  const account = args.account ?? intent.account ?? defaultAccount;
  const isIncrease = intent.side === "buy";
  const projectedPosition = isIncrease
    ? account.currentPositionUsd + intent.notionalUsd
    : Math.max(0, account.currentPositionUsd - intent.notionalUsd);
  const gaps = calculateGapScenarios(projectedPosition, account.accountEquityUsd, account.collateralBufferPct);

  let verdict: Verdict = "TRADE";
  let cap = policy.maxPaperOrderUsd;
  const reasons: string[] = [];
  const ruleCodes: string[] = [];
  const block = (code: string, reason: string) => {
    verdict = "BLOCK";
    ruleCodes.push(code);
    reasons.push(reason);
  };
  const alert = (code: string, reason: string) => {
    if (verdict !== "BLOCK") verdict = "ALERT";
    ruleCodes.push(code);
    reasons.push(reason);
  };

  if (snapshot.flags.includes("HALT")) {
    block("MARKET_HALT", "Trading is halted for this underlying asset.");
  }
  if (snapshot.flags.includes("STALE_QUOTE")) {
    block("STALE_QUOTE", "The rToken quote is too old to authorize an order.");
  }
  if (snapshot.flags.includes("REFERENCE_UNAVAILABLE") || snapshot.alignedReference === null || snapshot.basisBps === null) {
    block("REFERENCE_UNAVAILABLE", "No recent cash-aligned reference is available.");
  }

  if ((snapshot.session === "WEEKEND_HOLIDAY" || snapshot.session === "CLOSED") && isIncrease) {
    block(
      "CASH_MARKET_DARK",
      snapshot.session === "WEEKEND_HOLIDAY"
        ? "New exposure is disabled while the US cash market is closed for a weekend or holiday."
        : "New exposure is disabled during the weekday overnight cash-market closure.",
    );
  }

  if (snapshot.session === "EXTENDED") {
    cap = Math.min(cap, policy.maxPaperOrderUsd * (policy.extendedSizePct / 100));
    ruleCodes.push("EXTENDED_SIZE_CAP");
    reasons.push(`Extended-hours size is capped at $${cap.toFixed(2)}.`);
    if (snapshot.spreadBps > policy.maxExtendedSpreadBps) {
      alert("EXTENDED_SPREAD", "The extended-hours spread exceeds the configured limit.");
    }
  } else if (snapshot.spreadBps > policy.maxCashSpreadBps) {
    alert("SPREAD_LIMIT", "The current spread exceeds the configured limit.");
  }

  if (snapshot.basisBps !== null && Math.abs(snapshot.basisBps) > policy.maxBasisBps) {
    alert("BASIS_LIMIT", "The rToken basis is outside the configured tolerance.");
  }

  if (snapshot.flags.includes("EARNINGS_WINDOW")) {
    cap = Math.min(cap, policy.maxPaperOrderUsd * (policy.earningsSizePct / 100));
    ruleCodes.push("EARNINGS_SIZE_CAP");
    reasons.push(`Earnings-window size is capped at $${cap.toFixed(2)}.`);
  }

  const stressEight = gaps.find((gap) => gap.gapPct === -8);
  if (
    isIncrease &&
    account.usesRTokenAsCollateral &&
    stressEight &&
    stressEight.projectedBufferPct < policy.minCollateralBufferPct
  ) {
    block("COLLATERAL_BUFFER", "An 8% gap would breach the configured collateral buffer.");
  }

  const desiredAction = intent.side === "buy" ? "BUY" : "SELL";
  if (assessment.proposedAction === "HOLD") {
    alert("AGENT_HOLD", "Qwen found no trade-worthy change in the official event.");
  } else if (assessment.proposedAction !== desiredAction) {
    alert("ACTION_MISMATCH", "The requested side conflicts with Qwen's event assessment.");
  }
  if (assessment.novelty === "STALE" || assessment.novelty === "UNCLEAR") {
    alert("EVENT_NOT_NEW", "The event is stale or its timing could not be verified.");
  }
  if (assessment.confidence < policy.minConfidence) {
    alert("LOW_CONFIDENCE", "Qwen confidence is below the configured threshold.");
  }

  if (ruleCodes.length === 0) {
    ruleCodes.push("POLICY_PASS");
    reasons.push("Session, reference, spread, event, and account checks passed.");
  }

  return {
    id: randomUUID(),
    createdAt: (args.now ?? new Date()).toISOString(),
    verdict,
    symbol: snapshot.symbol,
    requestedNotionalUsd: intent.notionalUsd,
    allowedNotionalUsd: verdict === "TRADE" ? Math.min(intent.notionalUsd, cap) : 0,
    reasons,
    ruleCodes,
    gaps,
    snapshot,
    assessment,
  };
}

export function evaluatePermission(args: EvaluationArgs): PermissionDecision {
  try {
    return evaluateUnchecked(args);
  } catch {
    return {
      id: randomUUID(),
      createdAt: (args.now ?? new Date()).toISOString(),
      verdict: "BLOCK",
      symbol: args.snapshot.symbol,
      requestedNotionalUsd: Number.isFinite(args.intent.notionalUsd) ? args.intent.notionalUsd : 0,
      allowedNotionalUsd: 0,
      reasons: ["The deterministic rule engine could not complete safely."],
      ruleCodes: ["RULE_ENGINE_ERROR"],
      gaps: [],
      snapshot: args.snapshot,
      assessment: args.assessment,
    };
  }
}
