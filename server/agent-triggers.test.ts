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

  it("deduplicates collateral risk by two-percentage-point band for one hour", async () => {
    const now = new Date("2026-09-15T15:00:00.000Z"); const env = await setup(now);
    await env.platform.savePortfolio(testPortfolio({ userId: env.user.id, collateralBufferPct: 18, capturedAt: now.toISOString() }));
    expect(await env.orchestrator.scanDeterministicTriggers(now)).toBe(1);
    expect(await env.orchestrator.scanDeterministicTriggers(now)).toBe(0);
    await env.platform.savePortfolio(testPortfolio({ userId: env.user.id, collateralBufferPct: 16, capturedAt: now.toISOString() }));
    expect(await env.orchestrator.scanDeterministicTriggers(now)).toBe(1);
    const triggers = await Promise.all((await env.agent.listRuns(env.user.id, 10)).items.map((run) => env.agent.getTrigger(env.user.id, run.triggerId)));
    expect(triggers.filter((item) => item?.type === "COLLATERAL_RISK").map((item) => item?.facts.collateralBandPct).sort()).toEqual([16, 18]);
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
