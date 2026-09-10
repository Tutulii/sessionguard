import { Wallet } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function runtime(now: Date, qwen: ProductionQwenAnalyst | null = null, replayOutcomeDelayMs = 0) {
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
  const market = new ProductionMarketService(platform, coordinator);
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

  it("runs cash-open NVIDIA through a deterministic $100 cap without ever entering the Demo adapter", async () => {
    const env = await runtime(new Date("2026-09-15T15:06:00.000Z"));
    const queued = await env.orchestrator.replay(env.user.id, "cash-nvidia", "RECORDED");
    await env.orchestrator.drain();
    const detail = await env.agent.getRunDetail(env.user.id, queued.id);
    expect(detail).toMatchObject({ state: "COMPLETED", assessment: { action: "BUY", proposedNotionalCents: 15_000 },
      authorization: { permission: "TRADE", allowedNotionalCents: 10_000 },
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

  it("deduplicates one official event per user/content/policy before a second model call can exist", async () => {
    const env = await runtime(new Date("2026-09-15T15:06:00.000Z"));
    await env.orchestrator.updateSettings(env.user.id, { mode: "SHADOW", symbols: ["RNVDAUSDT"],
      offHoursMoveThresholdBps: 100, minCollateralBufferPct: 15, automaticOrderLimitCents: 10_000,
      automaticOrdersPerDay: 5, automaticGrossNewNotionalCents: 50_000, notificationsEnabled: true });
    const source = (env.orchestrator as unknown as { replayEvent(id: string): unknown }).replayEvent("cash-nvidia") as never;
    const first = await env.orchestrator.enqueueOfficialEvent(source);
    const second = await env.orchestrator.enqueueOfficialEvent(source);
    expect(first).toHaveLength(1); expect(second).toHaveLength(1); expect(second[0].id).toBe(first[0].id);
    expect((await env.agent.listRuns(env.user.id, 10)).items).toHaveLength(1);
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
