import { SiweMessage, generateNonce } from "siwe";
import type { AuthenticatedUser } from "../shared/production-types.js";
import type { Coordinator, AuthSessionRecord } from "./coordinator.js";
import { createSessionRecord } from "./coordinator.js";
import type { PlatformRepository } from "./platform-repository.js";

export type AuthChallenge = { nonce: string; message: string; expiresAt: string; chainId: 42161 };

export class SiweAuthService {
  constructor(
    private readonly repository: PlatformRepository,
    private readonly coordinator: Coordinator,
    private readonly origin: string,
    private readonly maxUsers = 500,
  ) {}

  async createChallenge(address: string, now = new Date()): Promise<AuthChallenge> {
    const origin = new URL(this.origin);
    const nonce = generateNonce();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const message = new SiweMessage({
      domain: origin.host,
      address,
      statement: "Sign in to SessionGuard. This does not authorize a transaction or move funds.",
      uri: origin.origin,
      version: "1",
      chainId: 42161,
      nonce,
      issuedAt: now.toISOString(),
      expirationTime: expiresAt,
    }).prepareMessage();
    await this.coordinator.saveNonce({
      nonce,
      address: address.toLowerCase(),
      message,
      domain: origin.host,
      uri: origin.origin,
      expiresAt,
    }, 10 * 60);
    return { nonce, message, expiresAt, chainId: 42161 };
  }

  async verify(message: string, signature: string, now = new Date()) {
    const parsed = new SiweMessage(message);
    const stored = await this.coordinator.takeNonce(parsed.nonce);
    if (!stored) throw new Error("SIWE_NONCE_INVALID_OR_USED");
    if (stored.message !== message) throw new Error("SIWE_MESSAGE_MISMATCH");
    if (stored.address !== parsed.address.toLowerCase()) throw new Error("SIWE_ADDRESS_MISMATCH");
    if (parsed.chainId !== 42161) throw new Error("SIWE_CHAIN_MISMATCH");
    if (stored.domain !== parsed.domain || stored.uri !== parsed.uri) throw new Error("SIWE_ORIGIN_MISMATCH");
    if (new Date(stored.expiresAt).getTime() <= now.getTime()) throw new Error("SIWE_CHALLENGE_EXPIRED");
    const result = await parsed.verify({ signature, domain: stored.domain, nonce: stored.nonce, time: now.toISOString() });
    if (!result.success) throw new Error("SIWE_SIGNATURE_INVALID");
    const user = await this.repository.createOrLoginUser(parsed.address, this.maxUsers);
    const session = createSessionRecord(user, now);
    await this.coordinator.saveSession(session);
    await this.repository.saveAudit(user.id, "AUTH_SIGN_IN", user.id, { chainId: 42161 });
    return { user: this.publicUser(user), session };
  }

  async authenticate(sessionId: string | undefined, touch = true): Promise<{ user: AuthenticatedUser; session: AuthSessionRecord } | null> {
    if (!sessionId) return null;
    const session = await this.coordinator.getSession(sessionId, touch);
    if (!session) return null;
    const user = await this.repository.getUser(session.userId);
    if (!user || user.address !== session.address) {
      await this.coordinator.deleteSession(sessionId);
      return null;
    }
    return { user: this.publicUser(user), session };
  }

  isFresh(session: AuthSessionRecord, now = new Date(), maxAgeMs = 5 * 60_000) {
    return now.getTime() - new Date(session.lastVerifiedAt).getTime() <= maxAgeMs;
  }

  async logout(sessionId: string | undefined, userId?: string) {
    if (sessionId) await this.coordinator.deleteSession(sessionId);
    if (userId) await this.repository.saveAudit(userId, "AUTH_SIGN_OUT", null, {});
  }

  private publicUser(user: { id: string; address: string; chainId: 42161; createdAt: string }): AuthenticatedUser {
    return { id: user.id, address: user.address, chainId: user.chainId, createdAt: user.createdAt };
  }
}
