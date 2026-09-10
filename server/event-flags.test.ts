import { describe, expect, it } from "vitest";
import { replayScenarios } from "../shared/replays.js";
import { applyEventRiskFlags } from "./event-flags.js";

describe("event risk overlays", () => {
  it("adds an earnings window without mutating the original snapshot", () => {
    const scenario = replayScenarios[1];
    const event = {
      ...scenario.event,
      headline: "NVIDIA reports quarterly earnings results",
      publishedAt: scenario.snapshot.quoteTime,
    };
    const result = applyEventRiskFlags(scenario.snapshot, event);
    expect(result.flags).toContain("EARNINGS_WINDOW");
    expect(scenario.snapshot.flags).toEqual([]);
  });

  it("recognizes an official trading suspension", () => {
    const scenario = replayScenarios[1];
    const event = {
      ...scenario.event,
      headline: "Trading halted pending material news",
      publishedAt: scenario.snapshot.quoteTime,
    };
    expect(applyEventRiskFlags(scenario.snapshot, event).flags).toContain("HALT");
  });

  it("does not keep a stale event overlay active", () => {
    const scenario = replayScenarios[1];
    const event = { ...scenario.event, headline: "Quarterly earnings results", publishedAt: "2026-01-01T00:00:00.000Z" };
    expect(applyEventRiskFlags(scenario.snapshot, event).flags).not.toContain("EARNINGS_WINDOW");
  });
});
