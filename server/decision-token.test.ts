import { describe, expect, it } from "vitest";
import { DecisionTokenService } from "./decision-token.js";

const payload = {
  decisionId: "decision-1",
  symbol: "RNVDAUSDT" as const,
  side: "buy" as const,
  allowedNotionalUsd: 150,
  mode: "replay" as const,
  sessionHash: "replay",
};

describe("single-use decision token", () => {
  it("binds the signed decision fields and consumes once", () => {
    const service = new DecisionTokenService("secret");
    const issued = service.issue(payload);
    expect(service.consume(issued.token, "replay")).toMatchObject(payload);
    expect(() => service.consume(issued.token, "replay")).toThrow("already used");
  });

  it("rejects another browser session and signature tampering", () => {
    const service = new DecisionTokenService("secret");
    const issued = service.issue({ ...payload, sessionHash: "browser-a" });
    expect(() => service.consume(issued.token, "browser-b")).toThrow("session mismatch");
    expect(() => service.consume(`${issued.token}x`, "browser-a")).toThrow("signature");
  });

  it("rejects an expired permission", () => {
    const service = new DecisionTokenService("secret");
    const issued = service.issue(payload, -1);
    expect(() => service.consume(issued.token, "replay")).toThrow("expired");
  });
});
