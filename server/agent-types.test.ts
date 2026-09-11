import { describe, expect, it } from "vitest";
import {
  AgentAssessmentV1Schema,
  defaultAgentSettings,
  AgentGrantScopeInputSchema,
  AgentRunStateSchema,
  AgentSettingsV1Schema,
  UpdateAgentSettingsSchema,
  agentRunTransitions,
  assertAgentRunTransition,
} from "../shared/agent-types.js";
import { testAssessment, testSettings } from "./agent-test-fixtures.js";

describe("agent versioned contracts and explicit state machine", () => {
  it("accepts every declared transition and rejects every undeclared or repeated transition", () => {
    for (const from of AgentRunStateSchema.options) {
      const allowed = new Set(agentRunTransitions[from]);
      for (const to of AgentRunStateSchema.options) {
        if (allowed.has(to)) expect(() => assertAgentRunTransition(from, to)).not.toThrow();
        else expect(() => assertAgentRunTransition(from, to)).toThrow(`ILLEGAL_AGENT_TRANSITION:${from}->${to}`);
      }
    }
  });

  it("keeps structured assessments strict and bounded", () => {
    expect(AgentAssessmentV1Schema.parse(testAssessment()).action).toBe("BUY");
    expect(() => AgentAssessmentV1Schema.parse({ ...testAssessment(), tool: "placeOrder" })).toThrow();
    expect(() => AgentAssessmentV1Schema.parse({ ...testAssessment(), proposedNotionalCents: 25_001 })).toThrow();
    expect(() => AgentAssessmentV1Schema.parse({ ...testAssessment(), confidence: 1.01 })).toThrow();
  });

  it("defaults to a $100 ceiling but accepts an explicitly tightened/signed ceiling up to $250", () => {
    expect(defaultAgentSettings("11111111-1111-4111-8111-111111111111").automaticOrderLimitCents).toBe(10_000);
    expect(AgentSettingsV1Schema.safeParse({ ...testSettings(), automaticOrderLimitCents: 25_000 }).success).toBe(true);
    expect(AgentSettingsV1Schema.safeParse({ ...testSettings(), automaticOrderLimitCents: 25_001 }).success).toBe(false);
  });

  it("rejects duplicate symbols/actions and direct PAPER_AUTO settings", () => {
    const update = { ...testSettings("SHADOW") };
    const publicUpdate = { mode: update.mode, symbols: ["RNVDAUSDT", "RNVDAUSDT"],
      offHoursMoveThresholdBps: update.offHoursMoveThresholdBps, minCollateralBufferPct: update.minCollateralBufferPct,
      automaticOrderLimitCents: update.automaticOrderLimitCents, automaticOrdersPerDay: update.automaticOrdersPerDay,
      automaticGrossNewNotionalCents: update.automaticGrossNewNotionalCents, notificationsEnabled: true };
    expect(UpdateAgentSettingsSchema.safeParse(publicUpdate).success).toBe(false);
    expect(UpdateAgentSettingsSchema.safeParse({ ...publicUpdate, symbols: ["RNVDAUSDT"], mode: "PAPER_AUTO" }).success).toBe(false);
    expect(AgentGrantScopeInputSchema.safeParse({ symbols: ["RNVDAUSDT", "RNVDAUSDT"], actions: ["BUY"],
      automaticOrderLimitCents: 10_000, automaticOrdersPerDay: 5, automaticGrossNewNotionalCents: 50_000 }).success).toBe(false);
    expect(AgentGrantScopeInputSchema.safeParse({ symbols: ["RNVDAUSDT"], actions: ["BUY", "BUY"],
      automaticOrderLimitCents: 10_000, automaticOrdersPerDay: 5, automaticGrossNewNotionalCents: 50_000 }).success).toBe(false);
    expect(() => AgentSettingsV1Schema.parse({ ...testSettings(), symbols: ["RNVDAUSDT", "RNVDAUSDT"] })).toThrow();
  });
});
