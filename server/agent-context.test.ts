import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assembleAgentContext } from "./agent-context.js";
import { cashTime, testEvent, testMarket, testPortfolio, testSettings, testTrigger } from "./agent-test-fixtures.js";

function input(overrides: Record<string, unknown> = {}) {
  return { trigger: testTrigger(), event: testEvent(), market: testMarket(), portfolio: testPortfolio(),
    settings: testSettings(), recentRuns: [], outstandingOrder: false, dailyBaselineEquityCents: 500_000,
    now: cashTime, ...overrides };
}

describe("privacy-preserving immutable agent context", () => {
  it("removes tenant identity, exact balances, raw document and chart while retaining risk ratios", () => {
    const context = assembleAgentContext(input()); const serialized = JSON.stringify(context);
    expect(context.contextHash).toHaveLength(64);
    expect(context.portfolioRisk).toMatchObject({ accountEquityBand: "1K_TO_5K", availableBalancePct: 50, singleNameExposurePct: 10 });
    expect(serialized).not.toContain(testTrigger().userId);
    expect(serialized).not.toContain('"accountEquityCents"');
    expect(serialized).not.toContain('"availableBalanceCents"');
    expect(serialized).not.toContain('"normalizedText"');
    expect(serialized).not.toContain('"chart"');
  });

  it("hashes stable equivalent input and allows Qwen to propose up to the $250 platform ceiling", () => {
    const first = assembleAgentContext(input()); const second = assembleAgentContext(input());
    expect(first.contextHash).toBe(second.contextHash);
    expect(first.platformMaximumNotionalCents).toBe(25_000);
  });

  it.each([
    ["CONTEXT_MARKET_SYMBOL_MISMATCH", () => input({ market: testMarket({ symbol: "RTSLAUSDT" }) })],
    ["CONTEXT_SOURCE_MODE_MISMATCH", () => input({ market: testMarket({ dataMode: "REPLAY", sourceLabel: "REPLAY" }) })],
    ["CONTEXT_PORTFOLIO_TENANT_MISMATCH", () => input({ portfolio: testPortfolio({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) })],
    ["CONTEXT_EVENT_BINDING_MISMATCH", () => input({ trigger: testTrigger({ eventId: null }) })],
    ["CONTEXT_EVENT_SYMBOL_MISMATCH", () => input({ event: testEvent({ symbol: "RTSLAUSDT" }) })],
  ])("fails closed on %s", (code, make) => {
    expect(() => assembleAgentContext(make() as Parameters<typeof assembleAgentContext>[0])).toThrow(code);
  });

  it("rejects stale live market/portfolio, inconsistent times, and tampered evidence", () => {
    expect(() => assembleAgentContext(input({ market: testMarket({ quoteAgeMs: 10_001 }) }))).toThrow("CONTEXT_INPUT_STALE");
    expect(() => assembleAgentContext(input({ portfolio: testPortfolio({ capturedAt: "2026-09-15T14:59:44.000Z" }) }))).toThrow("CONTEXT_INPUT_STALE");
    expect(() => assembleAgentContext(input({ market: testMarket({ providerTimestamp: "2026-09-15T15:00:01.000Z" }) }))).toThrow("CONTEXT_MARKET_TIME_INVALID");
    const event = testEvent(); event.evidence[0].text = "tampered";
    expect(() => assembleAgentContext(input({ event }))).toThrow("CONTEXT_EVIDENCE_HASH_MISMATCH");
    const future = testEvent({ effectiveAt: "2026-09-15T15:06:00.000Z" });
    expect(() => assembleAgentContext(input({ event: future }))).toThrow("CONTEXT_EVENT_TIME_INVALID");
  });

  it("limits evidence to 20 segments and roughly 16k characters", () => {
    const evidence = Array.from({ length: 30 }, (_, index) => { const text = `${index}:` + "x".repeat(900);
      return { id: `seg-${index}`, index, text, hash: createHash("sha256").update(text).digest("hex") }; });
    const event = testEvent({ evidence });
    const context = assembleAgentContext(input({ event }));
    expect(context.evidence.length).toBeLessThanOrEqual(20);
    expect(context.evidence.reduce((sum, segment) => sum + segment.text.length, 0)).toBeLessThanOrEqual(16_000);
  });
});
