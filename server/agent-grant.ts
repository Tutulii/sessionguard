import { createHash, randomUUID } from "node:crypto";
import { getAddress } from "ethers";
import { SiweMessage, generateNonce } from "siwe";
import {
  AgentGrantScopeInputSchema,
  AgentGrantV1Schema,
  AgentSettingsV1Schema,
  agentPolicy,
  type AgentEligibility,
  type AgentGrantV1,
  type AgentSettingsV1,
} from "../shared/agent-types.js";
import type { AuthenticatedUser } from "../shared/production-types.js";
import type { z } from "zod";
import type { AgentRepository } from "./agent-repository.js";
import type { NotificationService } from "./notifications.js";
import type { PlatformRepository } from "./platform-repository.js";
import { productionHash } from "./production-rules.js";

export type AgentGrantScopeInput = z.infer<typeof AgentGrantScopeInputSchema>;

export function agentGrantHash(grant: AgentGrantV1) {
  return productionHash({ ...grant, messageHash: undefined });
}

export async function agentEligibility(repository: AgentRepository, settings: AgentSettingsV1, now = new Date()): Promise<AgentEligibility> {
  const started = settings.shadowStartedAt;
  const earliest = started ? new Date(new Date(started).getTime() + agentPolicy.minimumShadowAgeMs).toISOString() : null;
  const count = started ? await repository.countQualifyingRuns(settings.userId, started) : 0;
  const ageRequirementMet = Boolean(earliest && new Date(earliest).getTime() <= now.getTime());
  const runsRequirementMet = count >= agentPolicy.minimumQualifyingShadowRuns;
  return { eligible: ageRequirementMet && runsRequirementMet, qualifyingRuns: count,
    requiredRuns: agentPolicy.minimumQualifyingShadowRuns, shadowStartedAt: started,
    earliestEligibleAt: earliest, ageRequirementMet, runsRequirementMet };
}

export class AgentGrantService {
  private readonly origin: URL;
  constructor(private readonly agentRepository: AgentRepository, private readonly platformRepository: PlatformRepository,
    origin: string, private readonly notifications?: NotificationService) { this.origin = new URL(origin); }

  async createChallenge(user: AuthenticatedUser, input: AgentGrantScopeInput, now = new Date()) {
    const scope = AgentGrantScopeInputSchema.parse(input); this.assertUnique(scope.symbols, "GRANT_DUPLICATE_SYMBOL"); this.assertUnique(scope.actions, "GRANT_DUPLICATE_ACTION");
    const settings = await this.requireEligibleSettings(user.id, now); await this.requireDemoReady(user.id);
    if (scope.symbols.some((symbol) => !settings.symbols.includes(symbol)) || scope.automaticOrderLimitCents > settings.automaticOrderLimitCents ||
      scope.automaticOrdersPerDay > settings.automaticOrdersPerDay ||
      scope.automaticGrossNewNotionalCents > settings.automaticGrossNewNotionalCents) throw new Error("GRANT_SCOPE_MAY_ONLY_TIGHTEN_SETTINGS");
    const issuedAt = now.toISOString(); const grantExpiresAt = new Date(now.getTime() + agentPolicy.grantLifetimeMs).toISOString();
    const scopeHash = productionHash({ userId: user.id, walletAddress: user.address.toLowerCase(), chainId: 42161, scope,
      executionMode: "BITGET_DEMO", cashOpenOnly: true, policyVersion: settings.policyVersion,
      settingsVersion: settings.settingsVersion, issuedAt, expiresAt: grantExpiresAt });
    const nonce = generateNonce();
    const statement = `Authorize SessionGuard background Bitget Demo BUY/REDUCE orders only during the US cash session. Scope SHA-256 ${scopeHash}. Maximum $${(scope.automaticOrderLimitCents / 100).toFixed(2)} per order, ${scope.automaticOrdersPerDay} orders and $${(scope.automaticGrossNewNotionalCents / 100).toFixed(2)} gross new notional per UTC day. No live-money trading or fund transfers.`;
    const message = new SiweMessage({ domain: this.origin.host, address: getAddress(user.address), statement,
      uri: new URL("/agent", this.origin).toString(), version: "1", chainId: 42161, nonce, issuedAt,
      expirationTime: grantExpiresAt, resources: [`urn:sessionguard:agent-scope:${scopeHash}`] }).prepareMessage();
    const challengeExpiresAt = new Date(now.getTime() + agentPolicy.grantChallengeTtlMs).toISOString();
    const challenge = { id: randomUUID(), userId: user.id, nonce, message, scopeHash, scope, grantExpiresAt,
      expiresAt: challengeExpiresAt, createdAt: issuedAt, consumedAt: null };
    await this.agentRepository.saveGrantChallenge(challenge);
    await this.platformRepository.saveAudit(user.id, "AGENT_GRANT_CHALLENGE_CREATED", challenge.id,
      { scopeHash, challengeExpiresAt, grantExpiresAt, executionMode: "BITGET_DEMO", cashOpenOnly: true });
    return { challengeId: challenge.id, message, expiresAt: challengeExpiresAt, grantExpiresAt,
      executionMode: "BITGET_DEMO" as const, cashOpenOnly: true as const, scope };
  }

  async verify(user: AuthenticatedUser, input: { challengeId: string; message: string; signature: string }, now = new Date()) {
    const challenge = await this.agentRepository.consumeGrantChallenge(input.challengeId, user.id, now);
    if (!challenge) throw new Error("AGENT_GRANT_CHALLENGE_INVALID_OR_USED");
    if (challenge.message !== input.message) throw new Error("AGENT_GRANT_MESSAGE_MISMATCH");
    const parsed = new SiweMessage(input.message);
    if (parsed.address.toLowerCase() !== user.address.toLowerCase()) throw new Error("AGENT_GRANT_WALLET_MISMATCH");
    if (parsed.chainId !== 42161) throw new Error("AGENT_GRANT_CHAIN_MISMATCH");
    if (parsed.domain !== this.origin.host || parsed.uri !== new URL("/agent", this.origin).toString()) throw new Error("AGENT_GRANT_ORIGIN_MISMATCH");
    if (parsed.nonce !== challenge.nonce || parsed.expirationTime !== challenge.grantExpiresAt) throw new Error("AGENT_GRANT_SCOPE_MESSAGE_MISMATCH");
    if (!parsed.resources?.includes(`urn:sessionguard:agent-scope:${challenge.scopeHash}`)) throw new Error("AGENT_GRANT_RESOURCE_MISMATCH");
    const result = await parsed.verify({ signature: input.signature, domain: this.origin.host, nonce: challenge.nonce, time: now.toISOString() });
    if (!result.success) throw new Error("AGENT_GRANT_SIGNATURE_INVALID");
    const settings = await this.requireEligibleSettings(user.id, now); await this.requireDemoReady(user.id);
    const expectedHash = productionHash({ userId: user.id, walletAddress: user.address.toLowerCase(), chainId: 42161,
      scope: challenge.scope, executionMode: "BITGET_DEMO", cashOpenOnly: true, policyVersion: settings.policyVersion,
      settingsVersion: settings.settingsVersion, issuedAt: parsed.issuedAt, expiresAt: challenge.grantExpiresAt });
    if (expectedHash !== challenge.scopeHash) throw new Error("AGENT_GRANT_SETTINGS_CHANGED");
    const grant = AgentGrantV1Schema.parse({ version: 1, id: randomUUID(), userId: user.id,
      walletAddress: user.address.toLowerCase(), chainId: 42161, symbols: challenge.scope.symbols,
      actions: challenge.scope.actions, executionMode: "BITGET_DEMO", cashOpenOnly: true,
      automaticOrderLimitCents: challenge.scope.automaticOrderLimitCents,
      automaticOrdersPerDay: challenge.scope.automaticOrdersPerDay,
      automaticGrossNewNotionalCents: challenge.scope.automaticGrossNewNotionalCents,
      policyVersion: settings.policyVersion, settingsVersion: settings.settingsVersion,
      messageHash: createHash("sha256").update(input.message).digest("hex"), issuedAt: parsed.issuedAt,
      expiresAt: challenge.grantExpiresAt, revokedAt: null, revokedReason: null });
    await this.agentRepository.saveGrant(grant);
    const activated = AgentSettingsV1Schema.parse({ ...settings, mode: "PAPER_AUTO", updatedAt: now.toISOString() });
    await this.agentRepository.saveSettings(activated);
    await this.platformRepository.saveAudit(user.id, "AGENT_GRANT_VERIFIED", grant.id,
      { expiresAt: grant.expiresAt, scopeHash: challenge.scopeHash, executionMode: grant.executionMode, cashOpenOnly: true });
    return { grant: this.publicGrant(grant), settings: activated };
  }

  async revoke(userId: string, reason = "USER_REVOKED", now = new Date()) {
    const revoked = await this.agentRepository.revokeCurrentGrant(userId, reason, now);
    const settings = await this.agentRepository.getSettings(userId);
    if (settings?.mode === "PAPER_AUTO") {
      const demoted = AgentSettingsV1Schema.parse({ ...settings, mode: "ALERT_ONLY",
        settingsVersion: productionHash({ prior: settings.settingsVersion, mode: "ALERT_ONLY", at: now.toISOString() }).slice(0, 24),
        updatedAt: now.toISOString() });
      await this.agentRepository.saveSettings(demoted);
    }
    await this.platformRepository.saveAudit(userId, "AGENT_GRANT_REVOKED", revoked?.id ?? null, { reason });
    return { revoked: Boolean(revoked), mode: (await this.agentRepository.getSettings(userId))?.mode ?? "DISABLED" };
  }

  async maintain(now = new Date()) {
    const grants = await this.agentRepository.listExpiringGrants(new Date(now.getTime() + 24 * 60 * 60_000).toISOString());
    for (const grant of grants) {
      const remaining = new Date(grant.expiresAt).getTime() - now.getTime();
      if (remaining <= 0) {
        await this.revoke(grant.userId, "EXPIRED", now);
        await this.notifications?.emit(grant.userId, { kind: "CREDENTIAL", severity: "WARNING", title: "Agent grant expired",
          body: "PAPER_AUTO was safely demoted to alert only. A new wallet signature is required to renew." }, `agent-grant-expired:${grant.id}`);
      } else {
        const window = remaining <= 60 * 60_000 ? "one hour" : "24 hours";
        await this.notifications?.emit(grant.userId, { kind: "CREDENTIAL", severity: "WARNING", title: `Agent grant expires within ${window}`,
          body: "Review and sign a new seven-day Bitget Demo scope if you want PAPER_AUTO to continue." },
        `agent-grant-warning:${grant.id}:${window.replace(/ /g, "-")}`);
      }
    }
  }

  publicGrant(grant: AgentGrantV1 | null) {
    return grant ? { id: grant.id, symbols: grant.symbols, actions: grant.actions, executionMode: grant.executionMode,
      cashOpenOnly: grant.cashOpenOnly, automaticOrderLimitCents: grant.automaticOrderLimitCents,
      automaticOrdersPerDay: grant.automaticOrdersPerDay,
      automaticGrossNewNotionalCents: grant.automaticGrossNewNotionalCents,
      issuedAt: grant.issuedAt, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt } : null;
  }

  private async requireEligibleSettings(userId: string, now: Date) {
    const settings = await this.agentRepository.getSettings(userId);
    if (!settings || settings.mode === "DISABLED") throw new Error("AGENT_SHADOW_OPT_IN_REQUIRED");
    if (!(await agentEligibility(this.agentRepository, settings, now)).eligible) throw new Error("AGENT_SHADOW_ELIGIBILITY_REQUIRED");
    return settings;
  }
  private async requireDemoReady(userId: string) {
    const connection = await this.platformRepository.getConnection(userId);
    if (!connection?.executionEnabled) throw new Error("BITGET_DEMO_EXECUTION_REQUIRED");
    const pending = await this.platformRepository.listReconciliationOrders(500);
    if (pending.some((receipt) => receipt.userId === userId)) throw new Error("UNRESOLVED_DEMO_ORDER");
  }
  private assertUnique(values: string[], code: string) { if (new Set(values).size !== values.length) throw new Error(code); }
}
