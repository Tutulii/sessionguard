import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentJobV1Schema, AgentOutcomeV1Schema, AgentRunTransitionV1Schema, AgentRunV1Schema, AgentTriggerV1Schema } from "../shared/agent-types.js";
import { SqliteAgentRepository } from "./agent-repository.js";
import { productionHash } from "./production-rules.js";
import { cashTime, testGrant, testIds, testJob, testRun, testSettings, testTransition, testTrigger } from "./agent-test-fixtures.js";

const repositories: SqliteAgentRepository[] = [];

function repository() {
  const value = new SqliteAgentRepository();
  repositories.push(value);
  return value;
}

function bundle(input: {
  userId?: string;
  eventId?: string | null;
  symbol?: "RNVDAUSDT" | "RTSLAUSDT" | "RORCLUSDT";
  createdAt?: string;
  dedupeSeed?: string;
  qualifying?: boolean;
} = {}) {
  const userId = input.userId ?? testIds.user;
  const eventId = input.eventId === undefined ? testIds.event : input.eventId;
  const symbol = input.symbol ?? "RNVDAUSDT";
  const createdAt = input.createdAt ?? cashTime.toISOString();
  const triggerId = randomUUID();
  const runId = randomUUID();
  const traceId = randomUUID();
  const trigger = AgentTriggerV1Schema.parse({ ...testTrigger(), id: triggerId, userId, eventId, symbol,
    dedupeKey: productionHash(input.dedupeSeed ?? randomUUID()), createdAt });
  const run = AgentRunV1Schema.parse({ ...testRun(), id: runId, traceId, triggerId, userId, eventId, symbol,
    qualifyingShadowRun: input.qualifying ?? false, createdAt, updatedAt: createdAt });
  const job = AgentJobV1Schema.parse({ ...testJob(), id: randomUUID(), runId, userId, runAt: createdAt,
    createdAt, updatedAt: createdAt });
  const transition = AgentRunTransitionV1Schema.parse({ ...testTransition(), id: randomUUID(), runId, userId,
    traceId, createdAt });
  return { trigger, run, job, transition };
}

async function advanceToShadow(repository: SqliteAgentRepository, runId: string, userId = testIds.user, at = cashTime) {
  for (const state of ["CONTEXT_BUILDING", "CONTEXT_READY", "ASSESSING", "AUTHORIZING"] as const) {
    await repository.transitionRun(userId, runId, state, `TEST_${state}`, {}, {}, at);
  }
  return repository.transitionRun(userId, runId, "SHADOW_COMPLETE", "SHADOW_POLICY_PASS",
    { qualifyingShadowRun: true }, {}, at);
}

afterEach(async () => {
  while (repositories.length) await repositories.pop()!.close();
});

describe("agent durable repository", () => {
  it("creates trigger, run, transition, and job atomically and deduplicates by durable key", async () => {
    const repo = repository(); await repo.init();
    const first = bundle({ dedupeSeed: "same" });
    expect(await repo.createRunBundle(first.trigger, first.run, first.job, first.transition)).toMatchObject({ created: true });
    const duplicate = bundle({ dedupeSeed: "same" });
    const result = await repo.createRunBundle(duplicate.trigger, duplicate.run, duplicate.job, duplicate.transition);
    expect(result).toMatchObject({ created: false, run: { id: first.run.id } });
    expect((await repo.getRunDetail(testIds.user, first.run.id))?.transitions).toHaveLength(1);
    expect(await repo.queueStats(cashTime)).toMatchObject({ runnable: 1, leased: 0 });
  });

  it("rejects cross-bound trigger/run/job/transition bundles before any write", async () => {
    const repo = repository(); await repo.init();
    for (const mutate of [
      (value: ReturnType<typeof bundle>) => ({ ...value, run: { ...value.run, triggerId: randomUUID() } }),
      (value: ReturnType<typeof bundle>) => ({ ...value, job: { ...value.job, userId: testIds.otherUser } }),
      (value: ReturnType<typeof bundle>) => ({ ...value, transition: { ...value.transition, traceId: randomUUID() } }),
    ]) {
      const value = mutate(bundle());
      await expect(repo.createRunBundle(value.trigger, value.run as never, value.job as never, value.transition as never))
        .rejects.toThrow("AGENT_RUN_BUNDLE_BINDING_INVALID");
    }
    expect(await repo.queueStats(cashTime)).toMatchObject({ runnable: 0, leased: 0 });
  });

  it("enforces tenant ownership and append-only legal transitions", async () => {
    const repo = repository(); await repo.init(); const value = bundle();
    await repo.createRunBundle(value.trigger, value.run, value.job, value.transition);
    expect(await repo.getRun(testIds.otherUser, value.run.id)).toBeNull();
    await expect(repo.transitionRun(testIds.otherUser, value.run.id, "CONTEXT_BUILDING", "ATTACK"))
      .rejects.toThrow("AGENT_RUN_NOT_FOUND");
    const results = await Promise.allSettled([
      repo.transitionRun(testIds.user, value.run.id, "CONTEXT_BUILDING", "ONE", {}, {}, cashTime),
      repo.transitionRun(testIds.user, value.run.id, "CONTEXT_BUILDING", "TWO", {}, {}, cashTime),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    await expect(repo.transitionRun(testIds.user, value.run.id, "SUBMITTING", "ILLEGAL"))
      .rejects.toThrow("ILLEGAL_AGENT_TRANSITION");
    expect((await repo.getRunDetail(testIds.user, value.run.id))?.transitions.map((item) => item.toState))
      .toEqual(["QUEUED", "CONTEXT_BUILDING"]);
  });

  it("leases once, heartbeats only for the owner, and recovers an expired lease", async () => {
    const repo = repository(); await repo.init(); const value = bundle();
    await repo.createRunBundle(value.trigger, value.run, value.job, value.transition);
    const first = await repo.claimJob("worker-a", cashTime, 60_000);
    expect(first).toMatchObject({ status: "LEASED", workerId: "worker-a", attemptCount: 1 });
    expect(await repo.claimJob("worker-b", cashTime, 60_000)).toBeNull();
    expect(await repo.heartbeatJob(value.job.id, "worker-b", cashTime, 60_000)).toBe(false);
    expect(await repo.heartbeatJob(value.job.id, "worker-a", new Date(cashTime.getTime() + 10_000), 60_000)).toBe(true);
    expect(await repo.claimJob("worker-b", new Date(cashTime.getTime() + 65_000), 60_000)).toBeNull();
    const recovered = await repo.claimJob("worker-b", new Date(cashTime.getTime() + 71_000), 60_000);
    expect(recovered).toMatchObject({ status: "LEASED", workerId: "worker-b", attemptCount: 2 });
    await expect(repo.completeJob(value.job.id, "worker-a", cashTime)).rejects.toThrow("AGENT_JOB_LEASE_LOST");
    await repo.completeJob(value.job.id, "worker-b", new Date(cashTime.getTime() + 72_000));
    expect(await repo.queueStats(new Date(cashTime.getTime() + 72_000))).toMatchObject({ runnable: 0, leased: 0 });
  });

  it("persists retry state without losing the durable job", async () => {
    const repo = repository(); await repo.init(); const value = bundle();
    await repo.createRunBundle(value.trigger, value.run, value.job, value.transition);
    await repo.claimJob("worker-a", cashTime, 60_000);
    const retryAt = new Date(cashTime.getTime() + 60_000);
    await repo.retryJob(value.job.id, "worker-a", retryAt, "QWEN_HTTP_503", cashTime);
    expect(await repo.claimJob("worker-b", new Date(cashTime.getTime() + 59_999), 60_000)).toBeNull();
    expect(await repo.claimJob("worker-b", retryAt, 60_000)).toMatchObject({ attemptCount: 2, lastErrorCode: "QWEN_HTTP_503" });
  });

  it("counts only distinct runs explicitly marked qualifying after the shadow start", async () => {
    const repo = repository(); await repo.init();
    const start = new Date("2026-09-13T15:00:00.000Z");
    for (let index = 0; index < 11; index += 1) {
      const at = new Date(start.getTime() + index * 60_000);
      const value = bundle({ createdAt: at.toISOString() });
      await repo.createRunBundle(value.trigger, value.run, value.job, value.transition);
      if (index < 10) await advanceToShadow(repo, value.run.id, testIds.user, at);
    }
    expect(await repo.countQualifyingRuns(testIds.user, start.toISOString())).toBe(10);
    expect(await repo.countQualifyingRuns(testIds.otherUser, start.toISOString())).toBe(0);
  });

  it("atomically enforces per-run, event, cooldown, count, and gross-notional reservations", async () => {
    const repo = repository(); await repo.init();
    const first = bundle(); await repo.createRunBundle(first.trigger, first.run, first.job, first.transition);
    const limits = { count: 5, grossNewNotionalCents: 50_000, cooldownMs: 3_600_000 };
    const reservation = { runId: first.run.id, userId: testIds.user, eventId: first.run.eventId,
      symbol: first.run.symbol, side: "buy" as const, notionalCents: 10_000, createdAt: cashTime.toISOString() };
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => repo.reserveAutomaticExecution(reservation, limits)));
    expect(concurrent.filter((result) => result.created)).toHaveLength(1);
    expect(await repo.getAutomaticUsage(testIds.user, cashTime.toISOString().slice(0, 10))).toEqual({ count: 1, grossNewNotionalCents: 10_000 });

    const wrong = { ...reservation, runId: randomUUID() };
    await expect(repo.reserveAutomaticExecution(wrong, limits)).rejects.toThrow("AGENT_EXECUTION_RUN_BINDING_INVALID");
    const sameEvent = bundle({ createdAt: new Date(cashTime.getTime() + 3_700_000).toISOString() });
    await repo.createRunBundle(sameEvent.trigger, sameEvent.run, sameEvent.job, sameEvent.transition);
    await expect(repo.reserveAutomaticExecution({ ...reservation, runId: sameEvent.run.id,
      createdAt: sameEvent.run.createdAt }, limits)).rejects.toThrow("AGENT_EVENT_ALREADY_ACTIONED");

    const cooldownRun = bundle({ eventId: null, createdAt: new Date(cashTime.getTime() + 1_000).toISOString() });
    await repo.createRunBundle(cooldownRun.trigger, cooldownRun.run, cooldownRun.job, cooldownRun.transition);
    await expect(repo.reserveAutomaticExecution({ ...reservation, runId: cooldownRun.run.id, eventId: null,
      createdAt: cooldownRun.run.createdAt }, limits)).rejects.toThrow("AGENT_SYMBOL_COOLDOWN");
  });

  it("keeps the first UTC equity baseline under concurrent writes", async () => {
    const repo = repository(); await repo.init();
    const values = await Promise.all([500_000, 400_000, 700_000].map((equity) =>
      repo.getOrCreateDailyEquityBaseline(testIds.user, "2026-09-15", equity, cashTime.toISOString())));
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe(500_000);
  });

  it("binds outcomes to the owning run and paginates tenant data", async () => {
    const repo = repository(); await repo.init(); const value = bundle();
    await repo.createRunBundle(value.trigger, value.run, value.job, value.transition);
    const outcome = AgentOutcomeV1Schema.parse({ version: 1, id: randomUUID(), runId: value.run.id, userId: testIds.user,
      symbol: value.run.symbol, status: "PENDING", decisionPriceMicros: 100_000_000, proposedNotionalCents: 15_000,
      allowedNotionalCents: 10_000, nextOpenPriceMicros: null, plus60mPriceMicros: null, cashClosePriceMicros: null,
      pnlCents: null, mfeBps: null, maeBps: null, collateralBufferChangePct: null, eventSuperseded: false,
      observationDueAt: cashTime.toISOString(), scoredAt: null, label: "Waiting for observations." });
    await repo.saveOutcome(outcome);
    expect(await repo.getOutcome(value.run.id, testIds.otherUser)).toBeNull();
    await expect(repo.saveOutcome({ ...outcome, id: randomUUID(), userId: testIds.otherUser }))
      .rejects.toThrow("AGENT_OUTCOME_TENANT_MISMATCH");
    expect((await repo.listOutcomes(testIds.user, 1)).items).toHaveLength(1);
  });

  it("exports every tenant-owned agent category with grant proof redacted, then deletes all of it", async () => {
    const repo = repository(); await repo.init(); const value = bundle();
    await repo.saveSettings(testSettings()); await repo.saveGrant(testGrant());
    await repo.saveCollateralRiskState({ userId: testIds.user, settingsVersion: "settings-v1", phase: "ACTIVE",
      episodeKey: "episode-1", lastBandPct: 18, updatedAt: cashTime.toISOString() });
    await repo.createRunBundle(value.trigger, value.run, value.job, value.transition);
    await repo.getOrCreateDailyEquityBaseline(testIds.user, "2026-09-15", 500_000, cashTime.toISOString());
    await repo.reserveAutomaticExecution({ runId: value.run.id, userId: testIds.user, eventId: value.run.eventId,
      symbol: value.run.symbol, side: "buy", notionalCents: 5_000, createdAt: cashTime.toISOString() },
    { count: 5, grossNewNotionalCents: 50_000, cooldownMs: 3_600_000 });
    const exported = await repo.exportUserData(testIds.user) as Record<string, unknown>;
    expect(Object.keys(exported).sort()).toEqual(["collateralRiskState", "dailyEquityBaselines", "executionReservations", "grantChallenges", "grants", "jobs", "outcomes", "runs", "settings", "triggers"].sort());
    expect(JSON.stringify(exported)).toContain("[REDACTED]");
    expect(JSON.stringify(exported)).not.toContain(testGrant().messageHash);
    await repo.deleteUserData(testIds.user);
    expect(await repo.getSettings(testIds.user)).toBeNull();
    expect(await repo.getRun(testIds.user, value.run.id)).toBeNull();
    expect(await repo.getCurrentGrant(testIds.user)).toBeNull();
    expect(await repo.getCollateralRiskState(testIds.user)).toBeNull();
    expect(await repo.queueStats(cashTime)).toMatchObject({ runnable: 0, leased: 0 });
  });
});
