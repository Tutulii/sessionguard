import { Wallet } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentOutcomeV1Schema, type AgentOutcomeV1, type AgentRunV1, type OfficialEventV1 } from "../shared/agent-types.js";
import type { PortfolioSnapshot } from "../shared/production-types.js";
import { AgentGrantService } from "./agent-grant.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import { SqliteAgentRepository } from "./agent-repository.js";
import { MemoryCoordinator } from "./coordinator.js";
import { EnvelopeVault, LocalDataKeyManager, PersistentCredentialVault } from "./envelope-vault.js";
import { NotificationService } from "./notifications.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import type { DemoTradingAdapter, PortfolioPrices } from "./production-bitget.js";
import { ProductionOfficialEventWatcher } from "./production-events.js";
import type { ProductionQwenAnalyst } from "./production-qwen.js";
import { ProductionMarketService } from "./production-market.js";
import { ProductionDecisionTokenService } from "./production-token.js";
import { ProductionTradingService } from "./production-trading.js";

const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { while (closeables.length) await closeables.pop()!.close(); });

async function runtime(now: Date, qwen: ProductionQwenAnalyst | null = null, replayOutcomeDelayMs = 0,
  marketOverride?: ProductionMarketService) {
  let clock = now;
  const agent = new SqliteAgentRepository(); const platform = new SqlitePlatformRepository(); const coordinator = new MemoryCoordinator();
  closeables.push(agent, platform, coordinator); await agent.init(); await platform.init(); await coordinator.init();
  const user = await platform.createOrLoginUser(Wallet.createRandom().address, 500);
  const envelope = new EnvelopeVault(new LocalDataKeyManager("orchestrator-test-master-key-more-than-32-characters"));
  const adapter: DemoTradingAdapter = {
    validate: vi.fn(async () => ({ executionEnabled: true })),
    portfolio: vi.fn(async (userId: string, _credentials, _prices: PortfolioPrices): Promise<PortfolioSnapshot> => ({ userId,
      accountEquityCents: 500_000, availableBalanceCents: 250_000, collateralBufferPct: 35, positions: [], openOrderCount: 0,
      source: "BITGET_DEMO", capturedAt: now.toISOString() })),
    placeOrder: vi.fn(async () => ({ orderId: "demo-order", raw: {} })), reconcile: vi.fn(async () => null),
  };
  const market = marketOverride ?? new ProductionMarketService(platform, coordinator);
  const notifications = new NotificationService(platform, coordinator, envelope, "https://sessionguard.test");
  const vault = new PersistentCredentialVault(platform, envelope);
  const tokens = new ProductionDecisionTokenService("orchestrator-decision-key-longer-than-thirty-two-characters", coordinator);
  const trading = new ProductionTradingService(platform, coordinator, market, vault, adapter, tokens, notifications, undefined, agent);
  const grants = new AgentGrantService(agent, platform, "https://sessionguard.test", notifications);
  const watcher = new ProductionOfficialEventWatcher(agent, { fetcher: vi.fn() as never });
  const orchestrator = new AgentOrchestrator({ runtimeEnabled: true, repository: agent, platformRepository: platform,
    coordinator, market, trading, notifications, grantService: grants, watcher, qwen, workerId: "agent-test-worker",
    now: () => clock, replayOutcomeDelayMs });
  return { agent, platform, coordinator, user, adapter, orchestrator, setNow: (value: Date) => { clock = value; } };
}

describe("durable agent orchestrator", () => {
  it("runs the Sunday Oracle fixture end-to-end: Qwen BUY $250 becomes BLOCK $0 and avoided loss", async () => {
    const env = await runtime(new Date("2026-09-10T02:46:00.000Z"));
    const queued = await env.orchestrator.replay(env.user.id, "sunday-oracle", "RECORDED");
    expect(queued).toMatchObject({ sourceMode: "LOCAL_REPLAY", analystOrigin: "RECORDED", state: "QUEUED" });
    expect(await env.orchestrator.drain()).toBe(1);
    const detail = await env.agent.getRunDetail(env.user.id, queued.id);
    expect(detail).toMatchObject({ state: "COMPLETED", sourceMode: "LOCAL_REPLAY", analystOrigin: "RECORDED",
      qualifyingShadowRun: false, assessment: { action: "BUY", proposedNotionalCents: 25_000 },
      authorization: { permission: "BLOCK", allowedNotionalCents: 0 },
      outcome: { status: "AVOIDED_LOSS", label: "Recorded replay fixture counterfactual: avoided loss" } });
    expect(detail?.authorization?.reasonCodes).toContain("CASH_MARKET_DARK");
    expect(detail?.authorization?.reasonCodes).not.toContain("EVENT_TIME_INVALID");
    expect(detail?.transitions.map((item) => item.toState)).toEqual(["QUEUED", "CONTEXT_BUILDING", "CONTEXT_READY",
      "ASSESSING", "AUTHORIZING", "BLOCKED", "OUTCOME_PENDING", "COMPLETED"]);
    expect(env.adapter.placeOrder).not.toHaveBeenCalled(); expect(env.adapter.reconcile).not.toHaveBeenCalled();
  });

  it("runs cash-open NVIDIA through deterministic risk sizing without entering the Demo adapter", async () => {
    const env = await runtime(new Date("2026-09-15T15:06:00.000Z"));
    const queued = await env.orchestrator.replay(env.user.id, "cash-nvidia", "RECORDED");
    await env.orchestrator.drain();
    const detail = await env.agent.getRunDetail(env.user.id, queued.id);
    expect(detail).toMatchObject({ state: "COMPLETED", assessment: { action: "BUY", proposedNotionalCents: 15_000 },
      authorization: { permission: "TRADE", allowedNotionalCents: 6_106, sizing: { configuredCeilingCents: 10_000, equityCapCents: 10_000, riskSizedNotionalCents: 6_106 } },
      outcome: { status: "MISSED_UPSIDE", label: "Recorded replay fixture counterfactual: missed upside" } });
    expect(detail?.transitions.map((item) => item.toState)).toContain("SHADOW_COMPLETE");
    expect(detail?.receipt).toBeNull(); expect(detail?.qualifyingShadowRun).toBe(false);
    expect(env.adapter.placeOrder).not.toHaveBeenCalled();
  });

  it("can delay only a disclosed local replay outcome for a bounded scheduler test", async () => {
    const started = new Date("2026-09-10T02:46:00.000Z");
    const env = await runtime(started, null, 5 * 60_000);
    const queued = await env.orchestrator.replay(env.user.id, "sunday-oracle", "RECORDED");
    expect(await env.orchestrator.drain()).toBe(1);
    expect(await env.agent.getRunDetail(env.user.id, queued.id)).toMatchObject({
      state: "OUTCOME_PENDING", outcome: { status: "PENDING", observationDueAt: "2026-09-10T02:51:00.000Z",
        label: "Local replay scheduler test waiting for its disclosed delay." },
    });
    env.setNow(new Date("2026-09-10T02:51:01.000Z"));
    expect(await env.orchestrator.runOne()).toBe(true);
    expect(await env.agent.getRunDetail(env.user.id, queued.id)).toMatchObject({
      state: "COMPLETED", outcome: { status: "AVOIDED_LOSS" },
    });
  });

  it("recovers late observations from completed Bitget candles and records provenance", async () => {
    const completedObservationCandle = vi.fn(async (_symbol: string, target: Date) => ({
      priceMicros: target.getUTCHours() === 15 ? 101_000_000 : 102_000_000,
      observedAt: target.toISOString(), completedAt: new Date(target.getTime() + 60_000).toISOString(),
      source: "BITGET_COMPLETED_1M_CANDLE" as const,
    }));
    const snapshot = vi.fn();
    const market = { snapshot, completedObservationCandle } as unknown as ProductionMarketService;
    const env = await runtime(new Date("2026-09-15T17:00:00.000Z"), null, 0, market);
    const run = await env.orchestrator.replay(env.user.id, "cash-nvidia", "RECORDED");
    const outcome = AgentOutcomeV1Schema.parse({ version: 1, id: "99999999-9999-4999-8999-999999999991",
      runId: run.id, userId: env.user.id, symbol: run.symbol, status: "PENDING", decisionPriceMicros: 100_000_000,
      proposedNotionalCents: 15_000, allowedNotionalCents: 0, nextOpenPriceMicros: null, plus60mPriceMicros: null,
      cashClosePriceMicros: null, observationSources: { nextOpen: null, plus60m: null, cashClose: null }, pnlCents: null,
      mfeBps: null, maeBps: null, collateralBufferChangePct: null, eventSuperseded: false,
      observationDueAt: "2026-09-15T15:00:00.000Z", scoredAt: null, label: "Waiting for observations." });
    await env.agent.saveOutcome(outcome);
    const internal = env.orchestrator as unknown as {
      freshOutcomeQuote(run: AgentRunV1, kind: "OUTCOME_NEXT_OPEN" | "OUTCOME_60M", now: Date): Promise<Partial<AgentOutcomeV1>>;
      recoverMissingOutcomeObservations(run: AgentRunV1, outcome: AgentOutcomeV1, now: Date): Promise<AgentOutcomeV1>;
    };
    await expect(internal.freshOutcomeQuote(run, "OUTCOME_NEXT_OPEN", new Date("2026-09-15T15:20:00.000Z")))
      .resolves.toMatchObject({ nextOpenPriceMicros: 101_000_000,
        observationSources: { nextOpen: "BITGET_COMPLETED_1M_CANDLE" } });
    expect(snapshot).not.toHaveBeenCalled();
    const repaired = await internal.recoverMissingOutcomeObservations(run, outcome, new Date("2026-09-15T17:00:00.000Z"));
    expect(repaired).toMatchObject({ nextOpenPriceMicros: 101_000_000, plus60mPriceMicros: 102_000_000,
      observationSources: { nextOpen: "BITGET_COMPLETED_1M_CANDLE", plus60m: "BITGET_COMPLETED_1M_CANDLE" } });
  });

  it("deduplicates an exact local replay and reports the skipped duplicate", async () => {
    const env = await runtime(new Date("2026-09-15T15:06:00.000Z"));
    const first = await env.orchestrator.replay(env.user.id, "sunday-oracle", "RECORDED");
    const stored = await env.orchestrator.settings(env.user.id);
    await env.agent.saveSettings({ ...stored!, policyVersion: "agent-policy-next", settingsVersion: "settings-next" });
    const duplicate = await env.orchestrator.replay(env.user.id, "sunday-oracle", "QWEN");
    expect(first.dedupeStatus).toBe("QUEUED");
    expect(duplicate.dedupeStatus).toBe("SKIPPED_DUPLICATE");
    expect(duplicate.id).toBe(first.id);
    expect((await env.agent.listRuns(env.user.id, 10)).items).toHaveLength(1);
    expect(await env.agent.queueStats(new Date("2026-09-15T15:06:00.000Z"))).toMatchObject({ runnable: 1 });
  });

  it("deduplicates one official event per user/content even across policy revisions", async () => {
    const env = await runtime(new Date("2026-09-15T15:06:00.000Z"));
    await env.orchestrator.updateSettings(env.user.id, { mode: "SHADOW", symbols: ["RNVDAUSDT"],
      offHoursMoveThresholdBps: 100, minCollateralBufferPct: 15, automaticOrderLimitCents: 10_000,
      automaticOrdersPerDay: 5, automaticGrossNewNotionalCents: 50_000, notificationsEnabled: true });
    const source = (env.orchestrator as unknown as { replayEvent(id: string): unknown }).replayEvent("cash-nvidia") as OfficialEventV1;
    const first = await env.orchestrator.enqueueOfficialEvent(source);
    const stored = await env.agent.getSettings(env.user.id);
    await env.agent.saveSettings({ ...stored!, policyVersion: "agent-policy-next", settingsVersion: "settings-next" });
    const second = await env.orchestrator.enqueueOfficialEvent(source);
    expect(first).toHaveLength(1); expect(second).toHaveLength(1); expect(second[0].id).toBe(first[0].id);
    const amended = await env.orchestrator.enqueueOfficialEvent({ ...source,
      versionId: "99999999-9999-4999-8999-999999999999", contentHash: "f".repeat(64) });
    expect(amended[0].id).not.toBe(first[0].id);
    expect((await env.agent.listRuns(env.user.id, 10)).items).toHaveLength(2);
  });

  it("keeps manual runs shadow-only and excludes them from eligibility", async () => {
    const env = await runtime(new Date("2026-09-15T15:06:00.000Z"));
    const run = await env.orchestrator.manualShadow(env.user.id, "RNVDAUSDT", "SESSION_CHANGE");
    expect(run).toMatchObject({ sourceMode: "LIVE_BITGET", modeAtStart: "SHADOW", qualifyingShadowRun: false });
    expect((await env.agent.getTrigger(env.user.id, run.triggerId))?.type).toBe("MANUAL_SHADOW");
  });

  it("fails closed with a bounded code when model validation returns verbose details", async () => {
    const qwen = { assess: vi.fn(async () => { throw new Error(`MODEL_OUTPUT_INVALID:${"detail".repeat(100)}`); }),
      health: () => ({ status: "HEALTHY" as const }) } as unknown as ProductionQwenAnalyst;
    const env = await runtime(new Date("2026-09-15T15:06:00.000Z"), qwen);
    const run = await env.orchestrator.replay(env.user.id, "sunday-oracle", "QWEN");
    expect(await env.orchestrator.runOne()).toBe(true);
    expect(await env.agent.getRunDetail(env.user.id, run.id)).toMatchObject({ state: "FAILED_CLOSED", failureCode: "MODEL_OUTPUT_INVALID" });
  });

  it("fails a queued replay closed with an explicit reason when settings change", async () => {
    const env = await runtime(new Date("2026-09-15T15:06:00.000Z"));
    const run = await env.orchestrator.replay(env.user.id, "sunday-oracle", "RECORDED");
    await env.orchestrator.updateSettings(env.user.id, { mode: "SHADOW", symbols: ["RNVDAUSDT", "RTSLAUSDT", "RORCLUSDT"],
      offHoursMoveThresholdBps: 90, minCollateralBufferPct: 15, automaticOrderLimitCents: 10_000,
      automaticOrdersPerDay: 5, automaticGrossNewNotionalCents: 50_000, notificationsEnabled: true });
    expect(await env.orchestrator.runOne()).toBe(true);
    expect(await env.agent.getRunDetail(env.user.id, run.id)).toMatchObject({
      state: "FAILED_CLOSED", failureCode: "AGENT_SETTINGS_CHANGED_DURING_RUN",
    });
  });

  it("heartbeats while disabled but claims no work", async () => {
    const env = await runtime(new Date("2026-09-15T15:06:00.000Z"));
    const disabled = new AgentOrchestrator({ ...(env.orchestrator as unknown as { options: object }).options } as never);
    void disabled;
    const original = env.orchestrator;
    (original as unknown as { options: { runtimeEnabled: boolean } }).options.runtimeEnabled = false;
    expect(await original.runOne()).toBe(false);
    expect(await env.agent.latestWorkerHeartbeat()).toBe("2026-09-15T15:06:00.000Z");
  });
});
