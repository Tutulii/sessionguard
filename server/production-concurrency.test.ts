import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { ProductionDecisionTokenService, walletSessionHash } from "./production-token.js";

describe("concurrent production capabilities", () => {
  it("allows exactly one atomic consumer under concurrent token use", async () => {
    const coordinator = new MemoryCoordinator();
    const service = new ProductionDecisionTokenService("concurrency-test-signing-key-more-than-32-characters", coordinator);
    const userId = randomUUID(); const sessionId = randomUUID();
    const issued = service.issue({
      decisionId: randomUUID(), userId, walletSessionHash: walletSessionHash(sessionId), symbol: "RNVDAUSDT", side: "buy",
      allowedNotionalCents: 10_000, maxSlippageBps: 25, policyVersion: "p1", inputHash: "a".repeat(64),
      marketHash: "b".repeat(64), portfolioHash: "c".repeat(64), dataMode: "REPLAY",
    });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.consume(issued.token, { userId, sessionId })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(19);
    expect(results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .every((result) => String(result.reason).includes("ALREADY_USED"))).toBe(true);
  });
});
