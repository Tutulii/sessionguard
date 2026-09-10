import { createHash, randomUUID } from "node:crypto";
import { getAddress, Wallet } from "ethers";
import { SiweMessage, generateNonce } from "siwe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGrantChallengeSchema, AgentJobV1Schema, AgentRunTransitionV1Schema, AgentRunV1Schema, AgentTriggerV1Schema, agentPolicy } from "../shared/agent-types.js";
import { AgentGrantService, agentEligibility, type AgentGrantScopeInput } from "./agent-grant.js";
import { SqliteAgentRepository } from "./agent-repository.js";
import { SqlitePlatformRepository, type DemoConnectionRecord } from "./platform-repository.js";
import { productionHash } from "./production-rules.js";
import { testJob, testRun, testSettings, testTransition, testTrigger } from "./agent-test-fixtures.js";

const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { while (closeables.length) await closeables.pop()!.close(); });

async function setup(now = new Date("2026-09-15T15:00:00.000Z")) {
  const agent = new SqliteAgentRepository(); const platform = new SqlitePlatformRepository();
  closeables.push(agent, platform); await agent.init(); await platform.init();
  const wallet = Wallet.createRandom(); const user = await platform.createOrLoginUser(wallet.address, 500);
  const settings = testSettings("SHADOW", { userId: user.id, shadowStartedAt: new Date(now.getTime() - 48 * 60 * 60_000).toISOString(),
    createdAt: new Date(now.getTime() - 48 * 60 * 60_000).toISOString(), updatedAt: new Date(now.getTime() - 48 * 60 * 60_000).toISOString() });
  await agent.saveSettings(settings);
  const connection: DemoConnectionRecord = { userId: user.id, envelope: { cipherText: "cipher", iv: "iv", authTag: "tag",
    encryptedDataKey: "key", keyProvider: "TEST", version: 1, updatedAt: now.toISOString() }, executionEnabled: true,
    lastValidatedAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString() };
  await platform.saveConnection(connection);
  return { agent, platform, wallet, user, settings, now };
}

async function addQualifying(agent: SqliteAgentRepository, userId: string, count: number, startedAt: string) {
  for (let index = 0; index < count; index += 1) {
    const at = new Date(new Date(startedAt).getTime() + (index + 1) * 60_000).toISOString();
    const triggerId = randomUUID(); const runId = randomUUID(); const traceId = randomUUID();
    const trigger = AgentTriggerV1Schema.parse({ ...testTrigger(), id: triggerId, userId, eventId: null, type: "SESSION_CHANGE",
      dedupeKey: productionHash(`${userId}:${index}:${at}`), createdAt: at });
    const run = AgentRunV1Schema.parse({ ...testRun(), id: runId, traceId, triggerId, userId, eventId: null,
      createdAt: at, updatedAt: at });
    const job = AgentJobV1Schema.parse({ ...testJob(), id: randomUUID(), runId, userId, runAt: at, createdAt: at, updatedAt: at });
    const transition = AgentRunTransitionV1Schema.parse({ ...testTransition(), id: randomUUID(), runId, userId, traceId, createdAt: at });
    await agent.createRunBundle(trigger, run, job, transition);
    for (const state of ["CONTEXT_BUILDING", "CONTEXT_READY", "ASSESSING", "AUTHORIZING"] as const) {
      await agent.transitionRun(userId, runId, state, `TEST_${state}`, {}, {}, new Date(at));
    }
    await agent.transitionRun(userId, runId, "SHADOW_COMPLETE", "SHADOW_POLICY_PASS", { qualifyingShadowRun: true }, {}, new Date(at));
  }
}

const scope: AgentGrantScopeInput = { symbols: ["RNVDAUSDT"], actions: ["BUY", "REDUCE"],
  automaticOrderLimitCents: 10_000, automaticOrdersPerDay: 5, automaticGrossNewNotionalCents: 50_000 };

describe("purpose-bound seven-day agent grant", () => {
  it("requires both exactly 24 elapsed hours and ten distinct qualifying live runs", async () => {
    const { agent, user, settings, now } = await setup();
    const almostOldEnough = testSettings("SHADOW", { ...settings, shadowStartedAt: new Date(now.getTime() - agentPolicy.minimumShadowAgeMs + 1).toISOString() });
    await addQualifying(agent, user.id, 10, almostOldEnough.shadowStartedAt!);
    expect(await agentEligibility(agent, almostOldEnough, now)).toMatchObject({ eligible: false, ageRequirementMet: false, runsRequirementMet: true, qualifyingRuns: 10 });
    const exact = testSettings("SHADOW", { ...settings, shadowStartedAt: new Date(now.getTime() - agentPolicy.minimumShadowAgeMs).toISOString() });
    expect(await agentEligibility(agent, exact, now)).toMatchObject({ eligible: true, ageRequirementMet: true, runsRequirementMet: true });
  });

  it("issues a ten-minute, one-use challenge and activates an exact seven-day Demo-only grant", async () => {
    const { agent, platform, wallet, user, settings, now } = await setup(); await addQualifying(agent, user.id, 10, settings.shadowStartedAt!);
    const service = new AgentGrantService(agent, platform, "https://sessionguard.test");
    const challenge = await service.createChallenge(user, scope, now);
    expect(new Date(challenge.expiresAt).getTime() - now.getTime()).toBe(agentPolicy.grantChallengeTtlMs);
    expect(new Date(challenge.grantExpiresAt).getTime() - now.getTime()).toBe(agentPolicy.grantLifetimeMs);
    expect(challenge.message).toContain("background Bitget Demo BUY/REDUCE orders only during the US cash session");
    expect(challenge.message).toContain("No live-money trading or fund transfers");
    const signature = await wallet.signMessage(challenge.message);
    const activated = await service.verify(user, { challengeId: challenge.challengeId, message: challenge.message, signature }, now);
    expect(activated.settings.mode).toBe("PAPER_AUTO");
    expect(activated.grant).toMatchObject({ executionMode: "BITGET_DEMO", cashOpenOnly: true, symbols: ["RNVDAUSDT"], actions: ["BUY", "REDUCE"] });
    expect(activated.grant).not.toHaveProperty("messageHash"); expect(activated.grant).not.toHaveProperty("walletAddress");
    expect(new Date(activated.grant!.expiresAt).getTime() - new Date(activated.grant!.issuedAt).getTime()).toBe(agentPolicy.grantLifetimeMs);
    await expect(service.verify(user, { challengeId: challenge.challengeId, message: challenge.message, signature }, now))
      .rejects.toThrow("AGENT_GRANT_CHALLENGE_INVALID_OR_USED");
  });

  it("rejects message replay, altered scope, wrong wallet, origin, URI, chain, and expired challenges", async () => {
    const { agent, platform, wallet, user, settings, now } = await setup(); await addQualifying(agent, user.id, 10, settings.shadowStartedAt!);
    const service = new AgentGrantService(agent, platform, "https://sessionguard.test");
    const altered = await service.createChallenge(user, scope, now);
    await expect(service.verify(user, { challengeId: altered.challengeId, message: `${altered.message}\nchanged`,
      signature: await wallet.signMessage(`${altered.message}\nchanged`) }, now)).rejects.toThrow("AGENT_GRANT_MESSAGE_MISMATCH");

    const wrongWallet = await service.createChallenge(user, scope, now);
    await expect(service.verify(user, { challengeId: wrongWallet.challengeId, message: wrongWallet.message,
      signature: await Wallet.createRandom().signMessage(wrongWallet.message) }, now)).rejects.toThrow();

    const wrongOrigin = await service.createChallenge(user, scope, now);
    await expect(new AgentGrantService(agent, platform, "https://evil.test").verify(user, { challengeId: wrongOrigin.challengeId,
      message: wrongOrigin.message, signature: await wallet.signMessage(wrongOrigin.message) }, now)).rejects.toThrow("AGENT_GRANT_ORIGIN_MISMATCH");

    for (const attack of [
      { domain: "sessionguard.test", uri: "https://sessionguard.test/agent", chainId: 1, code: "AGENT_GRANT_CHAIN_MISMATCH" },
      { domain: "sessionguard.test", uri: "https://sessionguard.test/not-agent", chainId: 42161, code: "AGENT_GRANT_ORIGIN_MISMATCH" },
      { domain: "evil.test", uri: "https://sessionguard.test/agent", chainId: 42161, code: "AGENT_GRANT_ORIGIN_MISMATCH" },
    ]) {
      const nonce = generateNonce(); const id = randomUUID(); const expires = new Date(now.getTime() + agentPolicy.grantLifetimeMs).toISOString();
      const scopeHash = productionHash({ attack: id });
      const message = new SiweMessage({ domain: attack.domain, address: getAddress(user.address), statement: "Authorize SessionGuard background Bitget Demo orders for this bounded test scope.",
        uri: attack.uri, version: "1", chainId: attack.chainId, nonce, issuedAt: now.toISOString(), expirationTime: expires,
        resources: [`urn:sessionguard:agent-scope:${scopeHash}`] }).prepareMessage();
      await agent.saveGrantChallenge(AgentGrantChallengeSchema.parse({ id, userId: user.id, nonce, message, scopeHash, scope,
        grantExpiresAt: expires, expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(), createdAt: now.toISOString(), consumedAt: null }));
      await expect(service.verify(user, { challengeId: id, message, signature: await wallet.signMessage(message) }, now)).rejects.toThrow(attack.code);
    }

    const expired = await service.createChallenge(user, scope, now);
    await expect(service.verify(user, { challengeId: expired.challengeId, message: expired.message,
      signature: await wallet.signMessage(expired.message) }, new Date(now.getTime() + agentPolicy.grantChallengeTtlMs)))
      .rejects.toThrow("AGENT_GRANT_CHALLENGE_INVALID_OR_USED");
  });

  it("does not allow a signed scope to broaden current user settings", async () => {
    const { agent, platform, user, settings, now } = await setup(); await addQualifying(agent, user.id, 10, settings.shadowStartedAt!);
    const tightened = testSettings("SHADOW", { ...settings, symbols: ["RNVDAUSDT"], automaticOrderLimitCents: 5_000,
      automaticOrdersPerDay: 2, automaticGrossNewNotionalCents: 8_000, updatedAt: now.toISOString() });
    await agent.saveSettings(tightened);
    const service = new AgentGrantService(agent, platform, "https://sessionguard.test");
    await expect(service.createChallenge(user, scope, now)).rejects.toThrow("GRANT_SCOPE_MAY_ONLY_TIGHTEN_SETTINGS");
  });

  it("revokes without another signature, demotes PAPER_AUTO, and sends bounded expiry warnings", async () => {
    const { agent, platform, wallet, user, settings, now } = await setup(); await addQualifying(agent, user.id, 10, settings.shadowStartedAt!);
    const notifications = { emit: vi.fn(async () => ({ id: randomUUID() })) };
    const service = new AgentGrantService(agent, platform, "https://sessionguard.test", notifications as never);
    const challenge = await service.createChallenge(user, scope, now);
    await service.verify(user, { challengeId: challenge.challengeId, message: challenge.message,
      signature: await wallet.signMessage(challenge.message) }, now);
    await service.maintain(new Date(new Date(challenge.grantExpiresAt).getTime() - 23 * 60 * 60_000));
    expect(notifications.emit).toHaveBeenCalledWith(user.id, expect.objectContaining({ title: expect.stringContaining("24 hours") }), expect.any(String));
    await service.maintain(new Date(new Date(challenge.grantExpiresAt).getTime() - 30 * 60_000));
    expect(notifications.emit).toHaveBeenCalledWith(user.id, expect.objectContaining({ title: expect.stringContaining("one hour") }), expect.any(String));
    const revoked = await service.revoke(user.id, "USER_REVOKED", now);
    expect(revoked).toEqual({ revoked: true, mode: "ALERT_ONLY" });
    expect((await agent.getCurrentGrant(user.id))?.revokedAt).toBeUndefined();
  });

  it("automatically expires and demotes without provider availability", async () => {
    const { agent, platform, wallet, user, settings, now } = await setup(); await addQualifying(agent, user.id, 10, settings.shadowStartedAt!);
    const notifications = { emit: vi.fn(async () => ({ id: randomUUID() })) };
    const service = new AgentGrantService(agent, platform, "https://sessionguard.test", notifications as never);
    const challenge = await service.createChallenge(user, scope, now);
    await service.verify(user, { challengeId: challenge.challengeId, message: challenge.message,
      signature: await wallet.signMessage(challenge.message) }, now);
    await service.maintain(new Date(challenge.grantExpiresAt));
    expect((await agent.getSettings(user.id))?.mode).toBe("ALERT_ONLY");
    expect(await agent.getCurrentGrant(user.id)).toBeNull();
    expect(notifications.emit).toHaveBeenCalledWith(user.id, expect.objectContaining({ title: "Agent grant expired" }), expect.any(String));
  });
});
