import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { ProductionDecisionTokenService, walletSessionHash } from "./production-token.js";

describe("distributed decision token", () => {
  it("binds all decision inputs and consumes a nonce exactly once", async () => {
    const service = new ProductionDecisionTokenService("test-decision-signing-key-longer-than-32-characters", new MemoryCoordinator());
    const userId = randomUUID();
    const sessionId = randomUUID();
    const issued = service.issue({
      decisionId: randomUUID(), userId, walletSessionHash: walletSessionHash(sessionId), symbol: "RNVDAUSDT", side: "buy",
      allowedNotionalCents: 10_000, maxSlippageBps: 25, policyVersion: "p1", inputHash: "a".repeat(64),
      marketHash: "b".repeat(64), portfolioHash: "c".repeat(64), dataMode: "REPLAY",
    });
    expect(await service.consume(issued.token, { userId, sessionId })).toMatchObject({ symbol: "RNVDAUSDT", allowedNotionalCents: 10_000 });
    await expect(service.consume(issued.token, { userId, sessionId })).rejects.toThrow("ALREADY_USED");
  });

  it("rejects session substitution and signature tampering", async () => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const service = new ProductionDecisionTokenService("another-test-decision-signing-key-over-32-characters", new MemoryCoordinator());
    const issued = service.issue({ decisionId: randomUUID(), userId, walletSessionHash: walletSessionHash(sessionId), symbol: "RTSLAUSDT", side: "sell",
      allowedNotionalCents: 1_000, maxSlippageBps: 20, policyVersion: "p1", inputHash: "a".repeat(64), marketHash: "b".repeat(64),
      portfolioHash: "c".repeat(64), dataMode: "LIVE_BITGET" });
    await expect(service.consume(issued.token, { userId, sessionId: randomUUID() })).rejects.toThrow("SESSION_MISMATCH");
    await expect(service.consume(`${issued.token}x`, { userId, sessionId })).rejects.toThrow("SIGNATURE");
  });
});
