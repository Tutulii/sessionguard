import { AwsKmsDataKeyManager, EnvelopeVault, LocalDataKeyManager, PersistentCredentialVault, type DataKeyManager } from "./envelope-vault.js";
import { ExternalNotificationSender, NotificationService, NotificationWorker, type NotificationSender } from "./notifications.js";
import { MemoryCoordinator, RedisCoordinator, type Coordinator } from "./coordinator.js";
import { SqlitePlatformRepository, type PlatformRepository } from "./platform-repository.js";
import { PostgresPlatformRepository } from "./postgres-repository.js";
import { BitgetDemoTradingAdapter, type DemoTradingAdapter } from "./production-bitget.js";
import { ProductionMarketService } from "./production-market.js";
import { ProductionTradingService } from "./production-trading.js";
import { ProductionDecisionTokenService } from "./production-token.js";
import { SessionGuardTelemetry } from "./telemetry.js";
import { isHackathonDeploymentProfile, validateProductionEnvironment } from "./production-config.js";
import { platformPolicy, supportedSymbols } from "../shared/production-types.js";
import { PostgresAgentRepository, SqliteAgentRepository, type AgentRepository } from "./agent-repository.js";
import { AgentGrantService } from "./agent-grant.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import { ProductionOfficialEventWatcher } from "./production-events.js";
import { ProductionQwenAnalyst, qwenConfiguration } from "./production-qwen.js";

export type ProductionWorkerOptions = {
  repository?: PlatformRepository;
  agentRepository?: AgentRepository;
  coordinator?: Coordinator;
  keyManager?: DataKeyManager;
  tradingAdapter?: DemoTradingAdapter;
  notificationSender?: NotificationSender;
  fetcher?: typeof fetch;
  allowLocal?: boolean;
  qwen?: ProductionQwenAnalyst | null;
  eventWatcher?: ProductionOfficialEventWatcher;
  runtimeEnabled?: boolean;
};

export async function createProductionWorker(options: ProductionWorkerOptions = {}) {
  const allowLocal = options.allowLocal ?? (process.env.SESSIONGUARD_ALLOW_LOCAL_INFRA === "1" || process.env.NODE_ENV !== "production");
  validateProductionEnvironment(process.env.NODE_ENV === "production", allowLocal);
  const repository = options.repository ?? (process.env.DATABASE_URL
    ? new PostgresPlatformRepository(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === "1" })
    : allowLocal ? new SqlitePlatformRepository(process.env.PLATFORM_DATABASE_PATH ?? ".data/sessionguard-platform.sqlite")
      : (() => { throw new Error("DATABASE_URL is required in production"); })());
  const coordinator = options.coordinator ?? (process.env.REDIS_URL
    ? new RedisCoordinator(process.env.REDIS_URL)
    : allowLocal ? new MemoryCoordinator() : (() => { throw new Error("REDIS_URL is required in production"); })());
  const keyManager = options.keyManager ?? (() => {
    if (process.env.KMS_KEY_ID) {
      return new AwsKmsDataKeyManager(process.env.KMS_KEY_ID, process.env.AWS_REGION ?? "ap-southeast-1");
    }
    if (isHackathonDeploymentProfile() && process.env.LOCAL_KMS_MASTER_KEY) {
      return new LocalDataKeyManager(process.env.LOCAL_KMS_MASTER_KEY, "FLY_SECRET_AES256_GCM");
    }
    if (!allowLocal) throw new Error("KMS_KEY_ID or hackathon secret-wrapped key is required in production");
    return new LocalDataKeyManager(process.env.LOCAL_KMS_MASTER_KEY ?? "local-kms-master-key-at-least-32-characters");
  })();
  await repository.init();
  const agentRepository = options.agentRepository ?? (process.env.DATABASE_URL
    ? new PostgresAgentRepository(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === "1" })
    : new SqliteAgentRepository(process.env.PLATFORM_DATABASE_PATH ?? ".data/sessionguard-platform.sqlite"));
  await Promise.all([agentRepository.init(), coordinator.init()]);

  const appOrigin = process.env.APP_ORIGIN ?? (allowLocal ? "http://127.0.0.1:8787" : (() => { throw new Error("APP_ORIGIN is required in production"); })());
  const envelope = new EnvelopeVault(keyManager);
  const vault = new PersistentCredentialVault(repository, envelope);
  const market = new ProductionMarketService(repository, coordinator, options.fetcher);
  const bitget = options.tradingAdapter ?? new BitgetDemoTradingAdapter();
  const notifications = new NotificationService(repository, coordinator, envelope, appOrigin, process.env.TELEGRAM_BOT_NAME ?? "SessionGuardBot");
  const telemetry = new SessionGuardTelemetry(process.env.SENTRY_DSN, process.env.NODE_ENV ?? "development");
  const sender = options.notificationSender ?? new ExternalNotificationSender({
    appOrigin, resendApiKey: process.env.RESEND_API_KEY, emailFrom: process.env.EMAIL_FROM,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN, vapidSubject: process.env.VAPID_SUBJECT,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY, vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
  });
  const delivery = new NotificationWorker(repository, coordinator, envelope, sender, (seconds) => telemetry.notificationLatency.observe(seconds));
  const signingKey = process.env.DECISION_SIGNING_KEY ?? process.env.SESSION_MASTER_KEY ?? (allowLocal ? "local-decision-signing-key-at-least-32-characters" : "");
  if (signingKey.length < 32) throw new Error("DECISION_SIGNING_KEY is required and must contain at least 32 characters");
  const trading = new ProductionTradingService(repository, coordinator, market, vault, bitget,
    new ProductionDecisionTokenService(signingKey, coordinator), notifications, () => telemetry.duplicateOrders.inc(), agentRepository);
  const runtimeEnabled = options.runtimeEnabled ?? process.env.AGENT_RUNTIME_ENABLED === "1";
  const qwenConfig = qwenConfiguration(runtimeEnabled);
  const qwen = options.qwen === undefined ? (qwenConfig ? new ProductionQwenAnalyst(qwenConfig, options.fetcher) : null) : options.qwen;
  const watcher = options.eventWatcher ?? new ProductionOfficialEventWatcher(agentRepository, { fetcher: options.fetcher });
  const grantService = new AgentGrantService(agentRepository, repository, appOrigin, notifications);
  const configuredReplayDelay = Number(process.env.AGENT_REPLAY_OUTCOME_DELAY_MS ?? 0);
  const replayOutcomeDelayMs = process.env.NODE_ENV !== "production" && Number.isFinite(configuredReplayDelay)
    ? Math.max(0, Math.min(configuredReplayDelay, 10 * 60_000)) : 0;
  const agent = new AgentOrchestrator({ runtimeEnabled, repository: agentRepository, platformRepository: repository,
    coordinator, market, trading, notifications, grantService, watcher, qwen, telemetry, replayOutcomeDelayMs });
  let stopped = false;
  let lastPortfolioSync = 0;
  let lastRetention = 0;
  let lastSuccessfulTickAt: string | null = null;
  let lastOfficialPoll = 0;
  let lastAgentScan = 0;
  let lastGrantMaintenance = 0;
  let lastHeartbeatAt: string | null = null;
  let activeTickStartedAt: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  async function marketTick(now: Date) {
    const release = await coordinator.acquireLock("worker:market-feed", 4_500);
    if (!release) return;
    try {
      const connectedUsers = await repository.listConnectedUsers();
      await Promise.all(supportedSymbols.map(async (symbol) => {
        try {
          const snapshot = await market.snapshot(symbol, { mode: "LIVE_BITGET", now });
          telemetry.providerFresh.set({ provider: "bitget", symbol }, snapshot.session === "MARKET_UNAVAILABLE" ? 0 : 1);
          const sessionKey = `last-session:${symbol}`;
          const previous = await coordinator.cacheGet<string>(sessionKey);
          if (previous && previous !== snapshot.session) {
            for (const userId of connectedUsers) {
              await notifications.emit(userId, { kind: "SESSION_TRANSITION", severity: "INFO", title: `${snapshot.displaySymbol} · ${snapshot.session}`,
                body: `SessionGuard changed the deterministic market state from ${previous} to ${snapshot.session}.` }, `session:${symbol}:${snapshot.session}`);
            }
          }
          if (snapshot.session !== "CASH_OPEN" && snapshot.offHoursMoveBps !== null && Math.abs(snapshot.offHoursMoveBps) >= platformPolicy.maxOffHoursMoveBps) {
            const band = Math.trunc(snapshot.offHoursMoveBps / 25);
            for (const userId of connectedUsers) {
              await notifications.emit(userId, { kind: "OFF_HOURS_MOVE", severity: "WARNING",
                title: `${snapshot.displaySymbol} moved off hours`,
                body: `${snapshot.displaySymbol} is ${snapshot.offHoursMoveBps.toFixed(1)} bps from its Bitget cash-session anchor during ${snapshot.session}.` },
              `off-hours:${symbol}:${snapshot.session}:${band}`);
            }
          }
          await coordinator.cacheSet(sessionKey, snapshot.session, 7 * 86_400);
        } catch (error) {
          telemetry.providerFresh.set({ provider: "bitget", symbol }, 0);
          telemetry.capture(error, { job: "market-feed", symbol });
        }
      }));
    } finally { await release(); }
  }


  async function agentTick(now: Date) {
    const queue = await agentRepository.queueStats(now).catch(() => null);
    if (queue) telemetry.agentQueueAge.set(queue.oldestRunnableAgeMs / 1000);
    await agent.runOne(now);
    if (!runtimeEnabled) return;
    if (now.getTime() - lastAgentScan >= 5_000) {
      lastAgentScan = now.getTime();
      await agent.scanDeterministicTriggers(now).catch((error) => telemetry.capture(error, { job: "agent-trigger-scan" }));
    }
    if (now.getTime() - lastOfficialPoll >= 2 * 60_000) {
      lastOfficialPoll = now.getTime();
      await agent.pollOfficialEvents().catch((error) => telemetry.capture(error, { job: "official-source-poll" }));
    }
    if (now.getTime() - lastGrantMaintenance >= 60_000) {
      lastGrantMaintenance = now.getTime();
      await grantService.maintain(now).catch((error) => telemetry.capture(error, { job: "agent-grant-maintenance" }));
    }
    const health = { qwen: qwen?.health() ?? { status: "DISABLED" }, source: watcher.health() };
    await coordinator.cacheSet("agent:runtime-health", health, 60);
    telemetry.agentKillSwitch.set({ scope: "runtime" }, runtimeEnabled ? 0 : 1);
  }

  async function notificationTick() {
    for (let index = 0; index < 25; index += 1) if (!await delivery.runOne()) break;
  }

  async function tick(now = new Date()) {
    activeTickStartedAt = new Date().toISOString();
    lastHeartbeatAt = activeTickStartedAt;
    try {
      return await telemetry.withSpan("worker.tick", { "sessionguard.worker.time": now.toISOString() }, async () => {
        const jobs: Promise<unknown>[] = [
          marketTick(now),
          notificationTick(),
          agentTick(now),
          trading.reconcilePendingOrders({ now }).catch((error) => {
            telemetry.capture(error, { job: "order-reconciliation" });
            return 0;
          }),
        ];
        if (now.getTime() - lastPortfolioSync >= 5 * 60_000) {
          lastPortfolioSync = now.getTime();
          jobs.push(trading.refreshConnectedPortfolios().catch((error) => telemetry.capture(error, { job: "portfolio-sync" })));
        }
        if (now.getTime() - lastRetention >= 24 * 60 * 60_000) {
          lastRetention = now.getTime();
          jobs.push(Promise.all([repository.prune(now), agentRepository.prune(now)])
            .catch((error) => telemetry.capture(error, { job: "retention" })));
        }
        await Promise.all(jobs);
        lastSuccessfulTickAt = new Date().toISOString();
        telemetry.workerLastSuccess.set(Date.now() / 1_000);
      });
    } finally {
      activeTickStartedAt = null;
      lastHeartbeatAt = new Date().toISOString();
    }
  }

  async function run() {
    lastHeartbeatAt = new Date().toISOString();
    heartbeatTimer = setInterval(() => { lastHeartbeatAt = new Date().toISOString(); }, 5_000);
    try {
      while (!stopped) {
        const started = Date.now();
        await tick().catch((error) => telemetry.capture(error, { job: "worker-loop" }));
        await new Promise((resolve) => setTimeout(resolve, Math.max(250, 5_000 - (Date.now() - started))));
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function stop() {
    stopped = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    await Promise.allSettled([repository.close(), agentRepository.close(), coordinator.close()]);
  }

  async function health() {
    const [database, agentDatabase, redis] = await Promise.all([repository.ready(), agentRepository.ready(), coordinator.ready()]);
    const heartbeatRecent = lastHeartbeatAt !== null && Date.now() - new Date(lastHeartbeatAt).getTime() < 15_000;
    const tickStalled = activeTickStartedAt !== null && Date.now() - new Date(activeTickStartedAt).getTime() >= 180_000;
    const recent = heartbeatRecent && !tickStalled;
    return { ok: database && agentDatabase && redis && recent && !stopped, database, agentDatabase, redis, recent,
      heartbeatRecent, tickStalled, lastHeartbeatAt, activeTickStartedAt, lastSuccessfulTickAt, agentRuntime: runtimeEnabled };
  }

  return { run, tick, stop, health, agent, agentRepository, metrics: () => telemetry.metrics(), metricsContentType: () => telemetry.contentType() };
}
