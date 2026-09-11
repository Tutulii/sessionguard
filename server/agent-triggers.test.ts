import { Wallet } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductionMarketSnapshot, ProductionSession } from "../shared/production-types.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import { SqliteAgentRepository } from "./agent-repository.js";
import { MemoryCoordinator } from "./coordinator.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { testMarket, testPortfolio } from "./agent-test-fixtures.js";

const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { while (closeables.length) await closeables.pop()!.close(); });

async function setup(now: Date, initial: { session?: ProductionSession; move?: number; referenceTimestamp?: string } = {}) {
  const agent = new SqliteAgentRepository(); const platform = new SqlitePlatformRepository(); const coordinator = new MemoryCoordinator();
  closeables.push(agent, platform, coordinator); await agent.init(); await platform.init(); await coordinator.init();
  const user = await platform.createOrLoginUser(Wallet.createRandom().address, 500);
  let session = initial.session ?? "CASH_OPEN"; let move = initial.move ?? 0;
  let referenceTimestamp = initial.referenceTimestamp ?? "2026-09-17T20:00:00.000Z";
  const market = { snapshot: vi.fn(async (symbol: "RNVDAUSDT") => testMarket({ symbol, session, offHoursMoveBps: move,
    referenceTimestamp, providerTimestamp: now.toISOString(), receivedTimestamp: now.toISOString(), nextCashOpen: "2026-09-21T13:30:00.000Z" }) as ProductionMarketSnapshot) };
  const trading = { connectionStatus: vi.fn(async () => ({ connected: false, executionEnabled: false, mode: "paper-only", lastValidatedAt: null })) };
  const orchestrator = new AgentOrchestrator({ runtimeEnabled: true, repository: agent, platformRepository: platform,
    coordinator, market: market as never, trading: trading as never, notifications: {} as never, grantService: {} as never,
    watcher: { health: () => ({ status: "HEALTHY" }) } as never, qwen: null, workerId: "trigger-test", now: () => now });
  await orchestrator.updateSettings(user.id, { mode: "SHADOW", symbols: ["RNVDAUSDT"], offHoursMoveThresholdBps: 100,
    minCollateralBufferPct: 15, automaticOrderLimitCents: 10_000, automaticOrdersPerDay: 5,
    automaticGrossNewNotionalCents: 50_000, notificationsEnabled: true });
  return { agent, platform, coordinator, user, orchestrator, setSession: (value: ProductionSession) => { session = value; },
    setMove: (value: number) => { move = value; }, setReference: (value: string) => { referenceTimestamp = value; } };
}

describe("deterministic agent triggers", () => {
  it("creates one informational session transition per user/symbol/state change", async () => {
    const now = new Date("2026-09-15T15:00:00.000Z"); const env = await setup(now, { session: "EXTENDED" });
    expect(await env.orchestrator.scanDeterministicTriggers(now)).toBe(0);
    env.setSession("CASH_OPEN"); expect(await env.orchestrator.scanDeterministicTriggers(now)).toBe(1);
    expect(await env.orchestrator.scanDeterministicTriggers(now)).toBe(0);
    const runs = (await env.agent.listRuns(env.user.id, 10)).items;
    expect(runs).toHaveLength(1);
    expect((await env.agent.getTrigger(env.user.id, runs[0].triggerId))?.facts).toEqual({ from: "EXTENDED", to: "CASH_OPEN" });
  });

  it("uses threshold hysteresis and dedupe until move falls below 75 percent", async () => {
    const now = new Date("2026-09-13T18:42:00.000Z"); const env = await setup(now, { session: "WEEKEND", move: 120 });
    expect(await env.orchestrator.scanDeterministicTriggers(now)).toBe(1);
    expect(await env.orchestrator.scanDeterministicTriggers(now)).toBe(0);
    env.setMove(75); await env.orchestrator.scanDeterministicTriggers(now);
    env.setMove(74); await env.orchestrator.scanDeterministicTriggers(now);
    env.setMove(130); env.setReference("2026-09-18T20:00:00.000Z");
    expect(await env.orchestrator.scanDeterministicTriggers(new Date("2026-09-20T18:42:00.000Z"))).toBe(1);
    const triggers = await Promise.all((await env.agent.listRuns(env.user.id, 10)).items.map((run) => env.agent.getTrigger(env.user.id, run.triggerId)));
    expect(triggers.filter((item) => item?.type === "OFF_HOURS_MOVE")).toHaveLength(2);
  });

  it("adopts a legacy collateral run without emitting an upgrade duplicate", async () => {
    const now = new Date("2026-09-15T15:00:00.000Z"); const env = await setup(now);
    const settings = await env.agent.getSettings(env.user.id);
    const createLegacy = (facts: { collateralBandPct: number }, dedupeSeed: string, at: Date) =>
      (env.orchestrator as unknown as { createRun(input: Record<string, unknown>): Promise<unknown> }).createRun({
        settings, type: "COLLATERAL_RISK", symbol: "RNVDAUSDT", event: null, sourceMode: "LIVE_BITGET",
        analystOrigin: "QWEN", facts, dedupeSeed, now: at,
      });
    await createLegacy({ collateralBandPct: 10 }, "legacy-worse-band", now);
    await createLegacy({ collateralBandPct: 18 }, "legacy-newest-hour", new Date(now.getTime() + 60_000));
    await env.platform.savePortfolio(testPortfolio({ userId: env.user.id, collateralBufferPct: 10, capturedAt: now.toISOString() }));

    expect(await env.orchestrator.scanDeterministicTriggers(new Date("2026-09-15T18:00:00.000Z"))).toBe(0);
    expect(await env.agent.getCollateralRiskState(env.user.id)).toMatchObject({ phase: "ACTIVE", lastBandPct: 10 });
    expect((await env.agent.listRuns(env.user.id, 10)).items).toHaveLength(2);
  });

  it("creates collateral risk only on entry, worsening, or a new re-armed episode", async () => {
    const now = new Date("2026-09-15T15:00:00.000Z"); const env = await setup(now);
    await env.platform.savePortfolio(testPortfolio({ userId: env.user.id, collateralBufferPct: 18, capturedAt: now.toISOString() }));
    expect(await env.orchestrator.scanDeterministicTriggers(now)).toBe(1);
    expect(await env.orchestrator.scanDeterministicTriggers(now)).toBe(0);
    expect(await env.orchestrator.scanDeterministicTriggers(new Date("2026-09-15T18:05:00.000Z"))).toBe(0);
    await env.orchestrator.updateSettings(env.user.id, { mode: "SHADOW", symbols: ["RNVDAUSDT"],
      offHoursMoveThresholdBps: 95, minCollateralBufferPct: 15, automaticOrderLimitCents: 10_000,
      automaticOrdersPerDay: 5, automaticGrossNewNotionalCents: 50_000, notificationsEnabled: true });
    expect(await env.orchestrator.scanDeterministicTriggers(new Date("2026-09-15T18:05:30.000Z"))).toBe(0);

    await env.platform.savePortfolio(testPortfolio({ userId: env.user.id, collateralBufferPct: 16, capturedAt: now.toISOString() }));
    expect(await env.orchestrator.scanDeterministicTriggers(new Date("2026-09-15T18:06:00.000Z"))).toBe(1);
    await env.platform.savePortfolio(testPortfolio({ userId: env.user.id, collateralBufferPct: 26, capturedAt: now.toISOString() }));
    expect(await env.orchestrator.scanDeterministicTriggers(new Date("2026-09-15T18:07:00.000Z"))).toBe(0);
    await env.platform.savePortfolio(testPortfolio({ userId: env.user.id, collateralBufferPct: 18, capturedAt: now.toISOString() }));
    expect(await env.orchestrator.scanDeterministicTriggers(new Date("2026-09-15T18:08:00.000Z"))).toBe(1);

    const triggers = await Promise.all((await env.agent.listRuns(env.user.id, 10)).items.map((run) => env.agent.getTrigger(env.user.id, run.triggerId)));
    const collateral = triggers.filter((item) => item?.type === "COLLATERAL_RISK");
    expect(collateral.map((item) => item?.facts.collateralBandPct).sort()).toEqual([16, 18, 18]);
    expect(collateral.every((item) => typeof item?.facts.riskEpisode === "string")).toBe(true);
    expect(new Set(collateral.map((item) => item?.facts.riskEpisode)).size).toBe(2);
  });

  it("schedules Friday pre-weekend sweep at 15:45 America/New_York once per symbol/day", async () => {
    const before = new Date("2026-09-18T19:44:00.000Z"); const env = await setup(before, { session: "CASH_OPEN" });
    expect(await env.orchestrator.scanDeterministicTriggers(before)).toBe(0);
    const due = new Date("2026-09-18T19:45:00.000Z");
    expect(await env.orchestrator.scanDeterministicTriggers(due)).toBe(1);
    expect(await env.orchestrator.scanDeterministicTriggers(new Date("2026-09-18T19:55:00.000Z"))).toBe(0);
    const run = (await env.agent.listRuns(env.user.id, 10)).items[0];
    expect((await env.agent.getTrigger(env.user.id, run.triggerId))?.type).toBe("PRE_WEEKEND_SWEEP");
  });

  it("creates no Friday sweep on a holiday/closed cash session", async () => {
    const due = new Date("2026-12-25T20:45:00.000Z"); const env = await setup(due, { session: "HOLIDAY" });
    expect(await env.orchestrator.scanDeterministicTriggers(due)).toBe(0);
    expect((await env.agent.listRuns(env.user.id, 10)).items).toHaveLength(0);
  });
});
