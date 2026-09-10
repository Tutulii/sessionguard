import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DataModeSchema } from "../shared/production-types.js";
import { SupportedSymbolSchema } from "../shared/types.js";
import type { Coordinator } from "./coordinator.js";

const BaseTokenPayloadSchema = z.object({
  decisionId: z.string().uuid(),
  userId: z.string().uuid(),
  symbol: SupportedSymbolSchema,
  side: z.enum(["buy", "sell"]),
  allowedNotionalCents: z.number().int().positive(),
  maxSlippageBps: z.number().int().nonnegative(),
  policyVersion: z.string(),
  inputHash: z.string().length(64),
  marketHash: z.string().length(64),
  portfolioHash: z.string().length(64),
  dataMode: DataModeSchema,
  replayId: z.string().min(1).max(128).optional(),
  earningsWindow: z.boolean().optional(),
  nonce: z.string().uuid(),
  exp: z.number().int().positive(),
});

const WalletTokenPayloadSchema = BaseTokenPayloadSchema.extend({
  authority: z.literal("WALLET_SESSION"),
  walletSessionHash: z.string().length(64),
}).strict();

const AgentTokenPayloadSchema = BaseTokenPayloadSchema.extend({
  authority: z.literal("AGENT_GRANT"),
  grantId: z.string().uuid(),
  grantHash: z.string().length(64),
  settingsVersion: z.string().min(1).max(128),
  contextHash: z.string().length(64),
  runId: z.string().uuid(),
}).strict();

const TokenPayloadSchema = z.discriminatedUnion("authority", [WalletTokenPayloadSchema, AgentTokenPayloadSchema]);
export type ProductionTokenPayload = z.infer<typeof TokenPayloadSchema>;
export type WalletTokenPayload = z.infer<typeof WalletTokenPayloadSchema>;
export type AgentTokenPayload = z.infer<typeof AgentTokenPayloadSchema>;
type WalletIssue = Omit<WalletTokenPayload, "authority" | "nonce" | "exp">;
type AgentIssue = Omit<AgentTokenPayload, "authority" | "nonce" | "exp">;

export function walletSessionHash(sessionId: string) {
  return createHash("sha256").update(sessionId).digest("hex");
}

export class ProductionDecisionTokenService {
  private readonly key: Buffer;

  constructor(secret: string, private readonly coordinator: Coordinator) {
    if (secret.length < 32) throw new Error("DECISION_SIGNING_KEY must contain at least 32 characters");
    this.key = createHash("sha256").update(secret).digest();
  }

  issue(payload: WalletIssue, ttlMs = 90_000) {
    return this.encode({ ...payload, authority: "WALLET_SESSION", nonce: randomUUID(), exp: Date.now() + ttlMs });
  }

  issueAgent(payload: AgentIssue, ttlMs = 90_000) {
    if (payload.dataMode !== "LIVE_BITGET") throw new Error("AGENT_CAPABILITY_LIVE_BITGET_ONLY");
    return this.encode({ ...payload, authority: "AGENT_GRANT", nonce: randomUUID(), exp: Date.now() + ttlMs });
  }

  verify(token: string, expected: { userId: string; sessionId: string }) {
    const payload = this.verifySigned(token);
    if (payload.authority !== "WALLET_SESSION") throw new Error("DECISION_TOKEN_AUTHORITY_MISMATCH");
    if (payload.userId !== expected.userId || payload.walletSessionHash !== walletSessionHash(expected.sessionId)) {
      throw new Error("DECISION_TOKEN_SESSION_MISMATCH");
    }
    return payload;
  }

  verifyAgent(token: string, expected: { userId: string; grantId: string; grantHash: string; runId: string }) {
    const payload = this.verifySigned(token);
    if (payload.authority !== "AGENT_GRANT") throw new Error("DECISION_TOKEN_AUTHORITY_MISMATCH");
    if (payload.userId !== expected.userId || payload.grantId !== expected.grantId ||
      payload.grantHash !== expected.grantHash || payload.runId !== expected.runId) throw new Error("DECISION_TOKEN_GRANT_MISMATCH");
    return payload;
  }

  async consumePayload<T extends ProductionTokenPayload>(payload: T) {
    const consumed = await this.coordinator.consumeOnce("decision-token", payload.nonce, Math.max(1, payload.exp - Date.now()));
    if (!consumed) throw new Error("DECISION_TOKEN_ALREADY_USED");
    return payload;
  }

  async consume(token: string, expected: { userId: string; sessionId: string }) {
    return this.consumePayload(this.verify(token, expected));
  }

  async consumeAgent(token: string, expected: { userId: string; grantId: string; grantHash: string; runId: string }) {
    return this.consumePayload(this.verifyAgent(token, expected));
  }

  private verifySigned(token: string) {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra) throw new Error("MALFORMED_DECISION_TOKEN");
    const calculated = this.sign(encoded); const left = Buffer.from(signature); const right = Buffer.from(calculated);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("INVALID_DECISION_TOKEN_SIGNATURE");
    let payload: ProductionTokenPayload;
    try { payload = TokenPayloadSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); }
    catch { throw new Error("INVALID_DECISION_TOKEN_PAYLOAD"); }
    if (payload.exp <= Date.now()) throw new Error("DECISION_TOKEN_EXPIRED");
    return payload;
  }

  private encode(payload: ProductionTokenPayload) {
    const parsed = TokenPayloadSchema.parse(payload); const encoded = Buffer.from(JSON.stringify(parsed)).toString("base64url");
    return { token: `${encoded}.${this.sign(encoded)}`, expiresAt: new Date(parsed.exp).toISOString() };
  }

  private sign(encoded: string) { return createHmac("sha256", this.key).update(encoded).digest("base64url"); }
}
