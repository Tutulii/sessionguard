import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentJobV1Schema, AgentRunTransitionV1Schema, AgentRunV1Schema, AgentTriggerV1Schema } from "../shared/agent-types.js";
import type { PortfolioSnapshot, ProductionSession, ProductionSymbol } from "../shared/production-types.js";
import { assembleAgentContext } from "./agent-context.js";
import { SqliteAgentRepository } from "./agent-repository.js";
import { MemoryCoordinator } from "./coordinator.js";
import { EnvelopeVault, LocalDataKeyManager, PersistentCredentialVault } from "./envelope-vault.js";
import { NotificationService } from "./notifications.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import type { DemoTradingAdapter, PortfolioPrices } from "./production-bitget.js";
import { ProductionDecisionTokenService } from "./production-token.js";
import { ProductionTradingService } from "./production-trading.js";
import { productionHash } from "./production-rules.js";
import { testAssessment, testEvent, testGrant, testJob, testMarket, testPortfolio, testRun, testSettings, testTransition, testTrigger } from "./agent-test-fixtures.js";

const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { while (closeables.length) await closeables.pop()!.close(); });

async function qualifyingRun(agent: SqliteAgentRepository, userId: string, createdAt: string, index: number) {
  const triggerId = randomUUID(); const runId = randomUUID(); const traceId = randomUUID();
  const trigger = AgentTriggerV1Schema.parse({ ...testTrigger(), id: triggerId, userId, type: "SESSION_CHANGE", eventId: null,
    dedupeKey: productionHash(`qualifying:${userId}:${index}`), createdAt });
  const run = AgentRunV1Schema.parse({ ...testRun(), id: runId, traceId, triggerId, userId, eventId: null,
    modeAtStart: "SHADOW", createdAt, updatedAt: createdAt });
  const job = AgentJobV1Schema.parse({ ...testJob(), id: randomUUID(), runId, userId, runAt: createdAt, createdAt, updatedAt: createdAt });
  const transition = AgentRunTransitionV1Schema.parse({ ...testTransition(), id: randomUUID(), runId, userId, traceId, createdAt });
  await agent.createRunBundle(trigger, run, job, transition);
  for (const state of ["CONTEXT_BUILDING", "CONTEXT_READY", "ASSESSING", "AUTHORIZING"] as const) {
    await agent.transitionRun(userId, runId, state, `TEST_${state}`, {}, {}, new Date(createdAt));
  }
  await agent.transitionRun(userId, runId, "SHADOW_COMPLETE", "SHADOW_POLICY_PASS", { qualifyingShadowRun: true }, {}, new Date(createdAt));
}

async function setup() {
  const now = new Date("2026-09-15T15:00:00.000Z");
  const agent = new SqliteAgentRepository(); const platform = new SqlitePlatformRepository(); const coordinator = new MemoryCoordinator();
  closeables.push(agent, platform, coordinator); await agent.init(); await platform.init(); await coordinator.init();
  const wallet = Wallet.createRandom(); const user = await platform.createOrLoginUser(wallet.address, 500);
  const settings = testSettings("PAPER_AUTO", { userId: user.id, shadowStartedAt: "2026-09-13T14:00:00.000Z",
    settingsVersion: "auto-settings-v1", createdAt: "2026-09-13T14:00:00.000Z", updatedAt: now.toISOString() });
  await agent.saveSettings(settings);
  for (let index = 0; index < 10; index += 1) await qualifyingRun(agent, user.id, `2026-09-13T${String(14 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`, index);
  const event = testEvent(); await agent.saveOfficialEvent(event);
  const grant = testGrant({ userId: user.id, walletAddress: user.address, settingsVersion: settings.settingsVersion,
    policyVersion: settings.policyVersion, issuedAt: "2026-09-15T14:00:00.000Z", expiresAt: "2026-09-22T14:00:00.000Z" });
  await agent.saveGrant(grant);

  let session: ProductionSession = "CASH_OPEN"; let priceMicros = 100_000_000;
  let portfolio = testPortfolio({ userId: user.id, capturedAt: now.toISOString() });
  const market = { snapshot: vi.fn(async (symbol: ProductionSymbol) => testMarket({ symbol, session, rTokenPriceMicros: priceMicros,
    bidPriceMicros: priceMicros - 10_000, askPriceMicros: priceMicros, providerTimestamp: now.toISOString(),
    receivedTimestamp: now.toISOString(), quoteAgeMs: 0 })) };
  const adapter: DemoTradingAdapter = {
    validate: vi.fn(async () => ({ executionEnabled: true })),
    portfolio: vi.fn(async (_userId: string, _credentials, _prices: PortfolioPrices): Promise<PortfolioSnapshot> => portfolio),
    placeOrder: vi.fn(async () => ({ orderId: "demo-agent-order-1", raw: {} })),
    reconcile: vi.fn(async () => null),
  };
  const envelope = new EnvelopeVault(new LocalDataKeyManager("agent-execution-master-key-longer-than-thirty-two"));
  const vault = new PersistentCredentialVault(platform, envelope);
  await vault.save(user.id, { apiKey: "demo-key", secretKey: "demo-secret", passphrase: "demo-passphrase" }, true);
  const notifications = new NotificationService(platform, coordinator, envelope, "https://sessionguard.test");
  const tokens = new ProductionDecisionTokenService("agent-execution-signing-key-longer-than-thirty-two", coordinator);
  const trading = new ProductionTradingService(platform, coordinator, market as never, vault, adapter, tokens, notifications, undefined, agent);

  async function prepare(action: "BUY" | "REDUCE" | "HOLD" | "ADD_COLLATERAL" = "BUY", runEvent: typeof event | null = event) {
    const triggerId = randomUUID(); const runId = randomUUID(); const traceId = randomUUID();
    const trigger = AgentTriggerV1Schema.parse({ ...testTrigger(), id: triggerId, userId: user.id,
      type: runEvent ? "OFFICIAL_EVENT" : "COLLATERAL_RISK", eventId: runEvent?.id ?? null,
      facts: runEvent ? { source: "SEC_EDGAR" } : { collateralBandPct: 18 },
      dedupeKey: productionHash(`target:${runId}`), createdAt: now.toISOString() });
    const run = AgentRunV1Schema.parse({ ...testRun(), id: runId, traceId, triggerId, userId: user.id,
      eventId: runEvent?.id ?? null, modeAtStart: "PAPER_AUTO", settingsVersion: settings.settingsVersion,
      createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const job = AgentJobV1Schema.parse({ ...testJob(), id: randomUUID(), runId, userId: user.id, runAt: now.toISOString(),
      createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const transition = AgentRunTransitionV1Schema.parse({ ...testTransition(), id: randomUUID(), runId, userId: user.id,
      traceId, createdAt: now.toISOString() });
    await agent.createRunBundle(trigger, run, job, transition);
    await agent.transitionRun(user.id, runId, "CONTEXT_BUILDING", "CONTEXT_STARTED", {}, {}, now);
    const snapshot = await market.snapshot("RNVDAUSDT");
    const context = assembleAgentContext({ trigger, event: runEvent, market: snapshot, portfolio, settings, recentRuns: [],
      outstandingOrder: false, dailyBaselineEquityCents: portfolio.accountEquityCents, now });
    await agent.transitionRun(user.id, runId, "CONTEXT_READY", "CONTEXT_VALIDATED", { context }, {}, now);
    await agent.transitionRun(user.id, runId, "ASSESSING", "MODEL_ASSESSMENT_STARTED", {}, {}, now);
    const assessment = action === "BUY" ? testAssessment() : action === "REDUCE"
      ? testAssessment({ action: "REDUCE", proposedNotionalCents: 5_000, confidence: 0.9 })
      : action === "ADD_COLLATERAL" ? testAssessment({ eventId: null, action: "ADD_COLLATERAL", proposedNotionalCents: 0, evidence: [] })
      : testAssessment({ action: "HOLD", proposedNotionalCents: 0 });
    await agent.transitionRun(user.id, runId, "AUTHORIZING", "MODEL_ASSESSMENT_VALID", { assessment }, {}, now);
    const evaluated = await trading.evaluateAgentProposal({ userId: user.id, runId, context, assessment, settings, event: runEvent, now });
    if (evaluated.capability) {
      await agent.transitionRun(user.id, runId, "EXECUTION_READY", "AGENT_POLICY_PASS", { authorization: evaluated.authorization }, {}, now);
      await agent.transitionRun(user.id, runId, "REVALIDATING", "FRESH_REVALIDATION_STARTED", {}, {}, now);
    } else await agent.transitionRun(user.id, runId, evaluated.authorization.permission === "ALERT_ONLY" ? "ALERTED" : "BLOCKED",
      evaluated.authorization.reasonCodes[0], { authorization: evaluated.authorization }, {}, now);
    return { runId, context, assessment, ...evaluated };
  }

  return { now, agent, platform, coordinator, wallet, user, settings, event, grant, adapter, trading, prepare,
    setSession: (value: ProductionSession) => { session = value; }, setPrice: (value: number) => { priceMicros = value; },
    setPortfolio: (value: PortfolioSnapshot) => { portfolio = value; } };
}

describe("PAPER_AUTO execution integration", () => {
  it("caps a $150 Qwen proposal at $100 and ten concurrent consumers submit exactly one Demo order", async () => {
    const env = await setup(); const prepared = await env.prepare();
    expect(prepared.authorization).toMatchObject({ permission: "TRADE", requestedNotionalCents: 15_000, allowedNotionalCents: 10_000 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => env.trading.executeAgentDecision({
      userId: env.user.id, runId: prepared.runId, decisionToken: prepared.capability!.token, now: env.now })));
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(env.adapter.placeOrder).toHaveBeenCalledTimes(1);
    expect(env.adapter.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: "RNVDAUSDT", side: "buy", notionalCents: 10_000 }));
    expect(await env.agent.getAutomaticUsage(env.user.id, "2026-09-15T00:00:00.000Z")).toEqual({ count: 1, grossNewNotionalCents: 10_000 });
  });

  it("blocks when cash closes or the official event changes between authorization and submission", async () => {
    const closed = await setup(); const first = await closed.prepare(); closed.setSession("EXTENDED");
    await expect(closed.trading.executeAgentDecision({ userId: closed.user.id, runId: first.runId,
      decisionToken: first.capability!.token, now: closed.now })).rejects.toThrow("AGENT_REVALIDATION_BLOCKED");
    expect(closed.adapter.placeOrder).not.toHaveBeenCalled();

    const changed = await setup(); const second = await changed.prepare();
    await changed.agent.saveOfficialEvent(testEvent({ versionId: randomUUID(), normalizedText: "Corrected official agreement with materially changed terms." }));
    await expect(changed.trading.executeAgentDecision({ userId: changed.user.id, runId: second.runId,
      decisionToken: second.capability!.token, now: changed.now })).rejects.toThrow("AGENT_REVALIDATION_BLOCKED");
    expect(changed.adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("keeps HOLD structurally unable to issue a capability or call the adapter", async () => {
    const env = await setup(); const prepared = await env.prepare("HOLD");
    expect(prepared.authorization).toMatchObject({ permission: "BLOCK", allowedNotionalCents: 0, reasonCodes: ["AGENT_HOLD"] });
    expect(prepared.capability).toBeNull(); expect(env.adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("accepts a null event binding for a live collateral-risk proposal", async () => {
    const env = await setup(); const prepared = await env.prepare("ADD_COLLATERAL", null);
    expect(prepared.authorization).toMatchObject({ permission: "ALERT_ONLY", allowedNotionalCents: 0,
      reasonCodes: expect.arrayContaining(["HUMAN_COLLATERAL_ACTION"]) });
    expect(prepared.capability).toBeNull(); expect(env.adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("revokes the grant and demotes immediately on Demo disconnect or user-policy change", async () => {
    const disconnected = await setup(); await disconnected.trading.disconnect(disconnected.user.id);
    expect(await disconnected.agent.getCurrentGrant(disconnected.user.id)).toBeNull();
    expect((await disconnected.agent.getSettings(disconnected.user.id))?.mode).toBe("ALERT_ONLY");
    const changed = await setup(); await changed.trading.updatePolicy(changed.user.id, {
      maxPaperOrderCents: 20_000, minCollateralBufferPct: 15, maxCashSpreadBps: 15, maxExtendedSpreadBps: 35,
      maxOffHoursMoveBps: 100, allowExtended: false, extendedSizePct: 25, earningsSizePct: 10,
    });
    expect(await changed.agent.getCurrentGrant(changed.user.id)).toBeNull();
    expect((await changed.agent.getSettings(changed.user.id))?.mode).toBe("ALERT_ONLY");
  });

  it("reconciles an uncertain response by deterministic client ID without a blind second submission", async () => {
    const env = await setup(); const prepared = await env.prepare();
    vi.mocked(env.adapter.placeOrder).mockRejectedValueOnce(new Error("socket closed"));
    vi.mocked(env.adapter.reconcile).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ orderId: "reconciled-demo-order", status: "filled" });
    await expect(env.trading.executeAgentDecision({ userId: env.user.id, runId: prepared.runId,
      decisionToken: prepared.capability!.token, now: env.now })).rejects.toThrow("BITGET_DEMO_ORDER_RECONCILIATION_PENDING");
    const recovered = await env.trading.executeAgentDecision({ userId: env.user.id, runId: prepared.runId,
      decisionToken: prepared.capability!.token, now: new Date(env.now.getTime() + 1_000) });
    expect(recovered).toMatchObject({ status: "FILLED", providerOrderId: "reconciled-demo-order" });
    expect(env.adapter.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(env.adapter.placeOrder).mock.calls[0][0].clientOrderId).toMatch(/^sg_[0-9a-f]{24}$/);
  });
});
