import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultUserPolicy, supportedSymbols, type PaperOrderReceiptV1 } from "../shared/production-types.js";
import { AgentJobV1Schema } from "../shared/agent-types.js";
import { PostgresAgentRepository } from "./agent-repository.js";
import { createSessionRecord } from "./coordinator-contract.js";
import { PostgresPlatformRepository } from "./postgres-repository.js";
import { RedisCoordinator } from "./redis-coordinator.js";
import { replayPortfolio } from "./production-bitget.js";
import { ProductionMarketService } from "./production-market.js";
import { evaluateProductionGuard } from "./production-rules.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!databaseUrl || !redisUrl)("managed-infrastructure contracts", () => {
  it("applies PostgreSQL schema, preserves tenancy, and serializes duplicate reservations", async () => {
    const repository = new PostgresPlatformRepository(databaseUrl!); await repository.init();
    const redis = new RedisCoordinator(redisUrl!); await redis.init();
    const address = `0x${randomBytes(20).toString("hex")}`;
    const otherAddress = `0x${randomBytes(20).toString("hex")}`;
    const user = await repository.createOrLoginUser(address, 500);
    const other = await repository.createOrLoginUser(otherAddress, 500);
    try {
      const watchlist = await repository.pool.query<{ symbols_json: string[] }>("SELECT symbols_json FROM watchlists WHERE user_id=$1", [user.id]);
      expect(watchlist.rows[0]?.symbols_json).toEqual([...supportedSymbols]);
      const now = new Date();
      const snapshot = await new ProductionMarketService(repository, redis).snapshot("RNVDAUSDT", {
        mode: "REPLAY", replayId: "cash-nvidia", now,
      });
      const portfolio = replayPortfolio(user.id);
      const decision = evaluateProductionGuard({ userId: user.id,
        input: { symbol: "RNVDAUSDT", side: "buy", notionalCents: 1_000, maxSlippageBps: 50, dataMode: "REPLAY", earningsWindow: false },
        snapshot, portfolio, policy: defaultUserPolicy, policyVersion: "default", dailyUsage: { count: 0, grossNewNotionalCents: 0 }, now });
      expect(decision.permission).toBe("TRADE");
      await repository.saveDecision(decision);
      const at = now.toISOString();
      const receipt: PaperOrderReceiptV1 = { id: randomUUID(), decisionId: decision.id, userId: user.id,
        clientOrderId: `sg_ci_${randomUUID()}`, executionMode: "LOCAL_REPLAY", status: "RESERVED", providerOrderId: null,
        message: "Integration reservation.", submittedAt: at, updatedAt: at, attemptCount: 0 };
      const reservations = await Promise.all([
        repository.reserveOrder(receipt, 1_000, "buy"), repository.reserveOrder(receipt, 1_000, "buy"),
      ]);
      expect(reservations.filter((result) => result.created)).toHaveLength(1);
      expect(await repository.getOrderByDecision(decision.id, other.id)).toBeNull();
      await repository.saveAudit(user.id, "INTEGRATION_ACCOUNT_DELETE", user.id, {});
      await expect(repository.deleteUser(user.id)).resolves.toBeUndefined();
    } finally {
      await repository.deleteUser(other.id);
      await Promise.all([repository.close(), redis.close()]);
    }
  });

  it("provides Redis atomicity, sessions, pub/sub, locks, caching, and leased jobs", async () => {
    const redis = new RedisCoordinator(redisUrl!); await redis.init();
    const namespace = randomUUID();
    try {
      const consumed = await Promise.all(Array.from({ length: 10 }, () => redis.consumeOnce(`ci:${namespace}`, "once", 60_000)));
      expect(consumed.filter(Boolean)).toHaveLength(1);
      await redis.cacheSet(`ci:${namespace}`, { ready: true }, 60);
      expect(await redis.cacheGet(`ci:${namespace}`)).toEqual({ ready: true });

      const user = { id: randomUUID(), address: `0x${randomBytes(20).toString("hex")}` };
      const session = createSessionRecord(user); await redis.saveSession(session);
      expect((await redis.getSession(session.id))?.userId).toBe(user.id);
      await redis.deleteSession(session.id); expect(await redis.getSession(session.id)).toBeNull();

      const received = new Promise<string>(async (resolve) => {
        const unsubscribe = await redis.subscribe(`ci:${namespace}`, (payload) => { void unsubscribe().then(() => resolve(payload)); });
        await redis.publish(`ci:${namespace}`, { message: "ready" });
      });
      await expect(received).resolves.toContain("ready");

      const release = await redis.acquireLock(`ci:${namespace}`, 30_000); expect(release).not.toBeNull();
      expect(await redis.acquireLock(`ci:${namespace}`, 30_000)).toBeNull();
      await release!(); expect(await redis.acquireLock(`ci:${namespace}`, 30_000)).not.toBeNull();

      const now = new Date();
      const job = { id: randomUUID(), notificationId: randomUUID(), userId: randomUUID(), channelId: randomUUID(), attempt: 0, runAt: now.toISOString() };
      await redis.enqueueNotification(job); expect(await redis.claimNotification(now)).toEqual(job);
      expect(await redis.claimNotification(new Date(now.getTime() + 59_999))).toBeNull();
      expect(await redis.claimNotification(new Date(now.getTime() + 60_000))).toEqual(job);
      await redis.completeNotification(job.id);
    } finally { await redis.close(); }
  });
  it("completes a PostgreSQL job with no error code instead of leaving it leased", async () => {
    const repository = new PostgresAgentRepository(databaseUrl!); await repository.init();
    const at = new Date();
    const job = AgentJobV1Schema.parse({ id: randomUUID(), runId: randomUUID(), userId: randomUUID(),
      kind: "PROCESS_RUN", status: "QUEUED", runAt: at.toISOString(), attemptCount: 0, workerId: null,
      leaseExpiresAt: null, lastErrorCode: null, createdAt: at.toISOString(), updatedAt: at.toISOString() });
    try {
      await repository.enqueueJob(job);
      expect(await repository.claimJob("integration-worker", at, 60_000)).toMatchObject({ id: job.id, status: "LEASED" });
      await expect(repository.completeJob(job.id, "integration-worker", at)).resolves.toBeUndefined();
      expect(await repository.queueStats(at)).toMatchObject({ runnable: 0, leased: 0 });
    } finally {
      await repository.pool.query("DELETE FROM agent_jobs WHERE id=$1", [job.id]);
      await repository.close();
    }
  });
});
