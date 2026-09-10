import { describe, expect, it } from "vitest";
import { replayScenarios } from "../shared/replays.js";
import type { AccountContext, AgentAssessment, MarketSnapshot, TradeIntent } from "../shared/types.js";
import { calculateGapScenarios, evaluatePermission } from "./rules.js";

const sunday = replayScenarios[0];
const cash = replayScenarios[1];
const extended = replayScenarios[2];

describe("deterministic permission rules", () => {
  it("blocks weekend exposure and allows zero dollars", () => {
    const decision = evaluatePermission({ snapshot: sunday.snapshot, assessment: sunday.assessment, intent: sunday.intent });
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.allowedNotionalUsd).toBe(0);
    expect(decision.ruleCodes).toContain("CASH_MARKET_DARK");
  });

  it("passes a healthy cash-open paper intent", () => {
    const decision = evaluatePermission({ snapshot: cash.snapshot, assessment: cash.assessment, intent: cash.intent });
    expect(decision.verdict).toBe("TRADE");
    expect(decision.allowedNotionalUsd).toBe(150);
    expect(decision.ruleCodes).toEqual(["POLICY_PASS"]);
  });

  it("keeps an extended-session HOLD at alert only", () => {
    const decision = evaluatePermission({ snapshot: extended.snapshot, assessment: extended.assessment, intent: extended.intent });
    expect(decision.verdict).toBe("ALERT");
    expect(decision.allowedNotionalUsd).toBe(0);
    expect(decision.ruleCodes).toContain("EXTENDED_SIZE_CAP");
    expect(decision.ruleCodes).toContain("AGENT_HOLD");
  });

  it("permits a weekend position reduction when inputs and spread pass", () => {
    const snapshot: MarketSnapshot = { ...sunday.snapshot, flags: [], basisBps: 40, spreadBps: 12 };
    const assessment: AgentAssessment = { ...sunday.assessment, proposedAction: "SELL", confidence: 0.9 };
    const intent: TradeIntent = { ...sunday.intent, side: "sell", notionalUsd: 100 };
    const decision = evaluatePermission({ snapshot, assessment, intent });
    expect(decision.verdict).toBe("TRADE");
    expect(decision.allowedNotionalUsd).toBe(100);
  });

  it("blocks weekday overnight increases", () => {
    const decision = evaluatePermission({
      snapshot: { ...cash.snapshot, session: "CLOSED" },
      assessment: cash.assessment,
      intent: cash.intent,
    });
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.ruleCodes).toContain("CASH_MARKET_DARK");
  });

  it("applies extended and earnings caps cumulatively", () => {
    const decision = evaluatePermission({
      snapshot: { ...cash.snapshot, session: "EXTENDED", flags: ["EARNINGS_WINDOW"] },
      assessment: cash.assessment,
      intent: { ...cash.intent, notionalUsd: 200 },
    });
    expect(decision.verdict).toBe("TRADE");
    expect(decision.allowedNotionalUsd).toBe(25);
  });

  it.each(["HALT", "STALE_QUOTE", "REFERENCE_UNAVAILABLE"] as const)("fails closed for %s", (flag) => {
    const snapshot: MarketSnapshot = {
      ...cash.snapshot,
      flags: [flag],
      ...(flag === "REFERENCE_UNAVAILABLE" ? { alignedReference: null, basisBps: null } : {}),
    };
    expect(evaluatePermission({ snapshot, assessment: cash.assessment, intent: cash.intent }).verdict).toBe("BLOCK");
  });

  it("blocks when the minus-eight-percent gap breaches collateral buffer", () => {
    const decision = evaluatePermission({
      snapshot: cash.snapshot,
      assessment: cash.assessment,
      intent: cash.intent,
      account: {
        accountEquityUsd: 1000,
        currentPositionUsd: 900,
        collateralBufferPct: 16,
        usesRTokenAsCollateral: true,
      },
    });
    expect(decision.ruleCodes).toContain("COLLATERAL_BUFFER");
    expect(decision.verdict).toBe("BLOCK");
  });

  it("calculates explainable dollar losses and buffers", () => {
    expect(calculateGapScenarios(900, 5000, 24)).toEqual([
      { gapPct: -3, pnlUsd: -27, projectedBufferPct: 23.5 },
      { gapPct: -8, pnlUsd: -72, projectedBufferPct: 22.6 },
      { gapPct: -12, pnlUsd: -108, projectedBufferPct: 21.8 },
    ]);
  });

  it("converts internal rule errors into an auditable block", () => {
    const brokenAccount = { ...cash.intent.account, accountEquityUsd: 0 } as AccountContext;
    const decision = evaluatePermission({ snapshot: cash.snapshot, assessment: cash.assessment, intent: cash.intent, account: brokenAccount });
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.ruleCodes).toEqual(["RULE_ENGINE_ERROR"]);
  });
});
