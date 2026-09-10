import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { ProductionDecisionTokenService, walletSessionHash } from "./production-token.js";

const hash = (value: string) => value.repeat(64).slice(0, 64);

function service() {
  return new ProductionDecisionTokenService("agent-authority-test-key-longer-than-thirty-two-characters", new MemoryCoordinator());
}

describe("agent capability authority isolation", () => {
  it("structurally rejects replay capabilities and manual/agent authority substitution", async () => {
    const tokens = service(); const userId = randomUUID(); const sessionId = randomUUID();
    const common = { decisionId: randomUUID(), userId, symbol: "RNVDAUSDT" as const, side: "buy" as const,
      allowedNotionalCents: 10_000, maxSlippageBps: 35, policyVersion: "policy-v1", inputHash: hash("a"),
      marketHash: hash("b"), portfolioHash: hash("c") };
    expect(() => tokens.issueAgent({ ...common, grantId: randomUUID(), grantHash: hash("d"), settingsVersion: "settings-v1",
      contextHash: hash("e"), runId: randomUUID(), dataMode: "REPLAY" })).toThrow("AGENT_CAPABILITY_LIVE_BITGET_ONLY");
    const manual = tokens.issue({ ...common, walletSessionHash: walletSessionHash(sessionId), dataMode: "LIVE_BITGET" });
    await expect(tokens.consumeAgent(manual.token, { userId, grantId: randomUUID(), grantHash: hash("d"), runId: randomUUID() }))
      .rejects.toThrow("DECISION_TOKEN_AUTHORITY_MISMATCH");
    const grantId = randomUUID(); const runId = randomUUID(); const grantHash = hash("d");
    const agent = tokens.issueAgent({ ...common, grantId, grantHash, settingsVersion: "settings-v1", contextHash: hash("e"),
      runId, dataMode: "LIVE_BITGET" });
    await expect(tokens.consume(agent.token, { userId, sessionId })).rejects.toThrow("DECISION_TOKEN_AUTHORITY_MISMATCH");
  });

  it("binds user, grant, grant hash, run, policy, settings, context, market, portfolio, side, and amount", async () => {
    const tokens = service(); const userId = randomUUID(); const grantId = randomUUID(); const runId = randomUUID(); const grantHash = hash("d");
    const issued = tokens.issueAgent({ decisionId: randomUUID(), userId, grantId, grantHash, runId,
      settingsVersion: "settings-v1", contextHash: hash("e"), symbol: "RORCLUSDT", side: "sell",
      allowedNotionalCents: 7_500, maxSlippageBps: 20, policyVersion: "policy-v1", inputHash: hash("a"),
      marketHash: hash("b"), portfolioHash: hash("c"), dataMode: "LIVE_BITGET" });
    const payload = tokens.verifyAgent(issued.token, { userId, grantId, grantHash, runId });
    expect(payload).toMatchObject({ authority: "AGENT_GRANT", userId, grantId, grantHash, runId, settingsVersion: "settings-v1",
      contextHash: hash("e"), symbol: "RORCLUSDT", side: "sell", allowedNotionalCents: 7_500,
      policyVersion: "policy-v1", inputHash: hash("a"), marketHash: hash("b"), portfolioHash: hash("c") });
    for (const expected of [
      { userId: randomUUID(), grantId, grantHash, runId },
      { userId, grantId: randomUUID(), grantHash, runId },
      { userId, grantId, grantHash: hash("f"), runId },
      { userId, grantId, grantHash, runId: randomUUID() },
    ]) await expect(tokens.consumeAgent(issued.token, expected)).rejects.toThrow("DECISION_TOKEN_GRANT_MISMATCH");
  });

  it("allows exactly one of ten concurrent consumers", async () => {
    const tokens = service(); const userId = randomUUID(); const grantId = randomUUID(); const runId = randomUUID(); const grantHash = hash("d");
    const issued = tokens.issueAgent({ decisionId: randomUUID(), userId, grantId, grantHash, runId,
      settingsVersion: "settings-v1", contextHash: hash("e"), symbol: "RNVDAUSDT", side: "buy",
      allowedNotionalCents: 10_000, maxSlippageBps: 35, policyVersion: "policy-v1", inputHash: hash("a"),
      marketHash: hash("b"), portfolioHash: hash("c"), dataMode: "LIVE_BITGET" });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
      tokens.consumeAgent(issued.token, { userId, grantId, grantHash, runId })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(9);
  });
});
