import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { SupportedSymbol } from "../shared/types.js";

export type DecisionTokenPayload = {
  decisionId: string;
  symbol: SupportedSymbol;
  side: "buy" | "sell";
  allowedNotionalUsd: number;
  mode: "live" | "replay";
  sessionHash: string;
  nonce: string;
  exp: number;
};

export class DecisionTokenService {
  private readonly used = new Map<string, number>();

  constructor(private readonly secret: string) {}

  issue(
    payload: Omit<DecisionTokenPayload, "nonce" | "exp">,
    ttlMs = 90_000,
  ): { token: string; expiresAt: string } {
    this.cleanup();
    const complete: DecisionTokenPayload = {
      ...payload,
      nonce: randomUUID(),
      exp: Date.now() + ttlMs,
    };
    const encoded = Buffer.from(JSON.stringify(complete)).toString("base64url");
    const signature = this.sign(encoded);
    return {
      token: `${encoded}.${signature}`,
      expiresAt: new Date(complete.exp).toISOString(),
    };
  }

  consume(token: string, expectedSessionHash: string): DecisionTokenPayload {
    const [encoded, suppliedSignature] = token.split(".");
    if (!encoded || !suppliedSignature) throw new Error("Malformed decision token");
    const expectedSignature = this.sign(encoded);
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error("Invalid decision token signature");
    }
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as DecisionTokenPayload;
    if (payload.exp <= Date.now()) throw new Error("Decision token expired");
    if (payload.sessionHash !== expectedSessionHash) throw new Error("Decision token session mismatch");
    this.cleanup();
    if (this.used.has(payload.nonce)) throw new Error("Decision token already used");
    this.used.set(payload.nonce, payload.exp);
    return payload;
  }

  private cleanup() {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.used) {
      if (expiresAt <= now) this.used.delete(nonce);
    }
  }

  private sign(encoded: string) {
    return createHmac("sha256", this.secret).update(encoded).digest("base64url");
  }
}
