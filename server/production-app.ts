import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import {
  GuardEvaluationSchema,
  NotificationChannelInputSchema,
  PaperOrderRequestSchema,
  PersistentDemoConnectSchema,
  SiweNonceRequestSchema,
  SiweVerifyRequestSchema,
  UserPolicySchema,
} from "../shared/production-types.js";
import { replayScenarios } from "../shared/replays.js";
import { SupportedSymbolSchema } from "../shared/types.js";
import { MemoryCoordinator, RedisCoordinator, type Coordinator } from "./coordinator.js";
import {
  AwsKmsDataKeyManager,
  EnvelopeVault,
  LocalDataKeyManager,
  PersistentCredentialVault,
  type DataKeyManager,
} from "./envelope-vault.js";
import {
  ExternalNotificationSender,
  NotificationService,
  type NotificationSender,
} from "./notifications.js";
import type { PlatformRepository } from "./platform-repository.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { PostgresPlatformRepository } from "./postgres-repository.js";
import { BitgetDemoTradingAdapter, type DemoTradingAdapter } from "./production-bitget.js";
import { ProductionMarketService } from "./production-market.js";
import { ProductionTradingService } from "./production-trading.js";
import { ProductionDecisionTokenService } from "./production-token.js";
import { SessionGuardTelemetry } from "./telemetry.js";
import { validateProductionEnvironment } from "./production-config.js";
import { SiweAuthService } from "./siwe-auth.js";
import { AgentGrantScopeInputSchema, AgentGrantVerifyRequestSchema, ManualShadowRequestSchema, ReplayAgentRequestSchema, UpdateAgentSettingsSchema } from "../shared/agent-types.js";
import { PostgresAgentRepository, SqliteAgentRepository, type AgentRepository } from "./agent-repository.js";
import { AgentGrantService } from "./agent-grant.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import { ProductionOfficialEventWatcher } from "./production-events.js";
import { ProductionQwenAnalyst, qwenConfiguration } from "./production-qwen.js";

type LoggerConfig = Exclude<FastifyServerOptions["logger"], boolean | undefined>;
type AuthContext = NonNullable<Awaited<ReturnType<SiweAuthService["authenticate"]>>>;

const KillSwitchScopeSchema = z.string().regex(/^(global|agent-runtime|agent-model|agent-provider|user:[0-9a-f-]{36}|symbol:(RNVDAUSDT|RTSLAUSDT|RORCLUSDT))$/);
const KillSwitchRequestSchema = z.object({ scope: KillSwitchScopeSchema, enabled: z.boolean() }).strict();

export type ProductionAppOptions = {
  production?: boolean;
  staticRoot?: string;
  logger?: FastifyServerOptions["logger"];
  appOrigin?: string;
  repository?: PlatformRepository;
  agentRepository?: AgentRepository;
  coordinator?: Coordinator;
  keyManager?: DataKeyManager;
  marketService?: ProductionMarketService;
  tradingAdapter?: DemoTradingAdapter;
  notificationSender?: NotificationSender;
  marketFetcher?: typeof fetch;
  qwen?: ProductionQwenAnalyst | null;
  eventWatcher?: ProductionOfficialEventWatcher;
  agentRuntimeEnabled?: boolean;
};

declare module "fastify" {
  interface FastifyRequest { productionAuth?: AuthContext; startedAtNs?: bigint; productionSpan?: Span }
}

function loggerOptions(): LoggerConfig {
  return {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "req.headers.authorization", "req.headers.cookie", "req.body.apiKey", "req.body.secretKey",
        "req.body.passphrase", "req.body.signature", "req.body.message", "body.apiKey", "body.secretKey", "body.passphrase",
        "body.signature", "*.encryptedDataKey", "*.cipherText",
      ],
      censor: "[REDACTED]",
    },
  };
}

function secureEqual(left: string | undefined, right: string | undefined) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function localInfrastructureAllowed(production: boolean) {
  return !production || process.env.SESSIONGUARD_ALLOW_LOCAL_INFRA === "1";
}

export async function createProductionApp(options: ProductionAppOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === "production";
  const allowLocal = localInfrastructureAllowed(production);
  const appOrigin = options.appOrigin ?? process.env.APP_ORIGIN ?? (allowLocal ? "http://127.0.0.1:8787" : "");
  validateProductionEnvironment(production, allowLocal);
  if (!appOrigin) throw new Error("APP_ORIGIN is required in production");
  const signingKey = process.env.DECISION_SIGNING_KEY ?? process.env.SESSION_MASTER_KEY ?? (allowLocal ? "local-decision-signing-key-at-least-32-characters" : "");
  const userCap = Number(process.env.PUBLIC_BETA_USER_CAP ?? 500);
  if (!Number.isInteger(userCap) || userCap < 1 || userCap > 500) throw new Error("PUBLIC_BETA_USER_CAP must be an integer from 1 to 500");
  if (signingKey.length < 32) throw new Error("DECISION_SIGNING_KEY is required and must contain at least 32 characters");

  const repository = options.repository ?? (() => {
    if (process.env.DATABASE_URL) return new PostgresPlatformRepository(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === "1" });
    if (!allowLocal) throw new Error("DATABASE_URL is required in production");
    return new SqlitePlatformRepository(process.env.PLATFORM_DATABASE_PATH ?? ".data/sessionguard-platform.sqlite");
  })();
  const coordinator = options.coordinator ?? (() => {
    if (process.env.REDIS_URL) return new RedisCoordinator(process.env.REDIS_URL);
    if (!allowLocal) throw new Error("REDIS_URL is required in production");
    return new MemoryCoordinator();
  })();
  const keyManager = options.keyManager ?? (() => {
    if (process.env.KMS_KEY_ID) return new AwsKmsDataKeyManager(process.env.KMS_KEY_ID, process.env.AWS_REGION ?? "ap-southeast-1");
    if (!allowLocal) throw new Error("KMS_KEY_ID is required in production");
    return new LocalDataKeyManager(process.env.LOCAL_KMS_MASTER_KEY ?? "local-kms-master-key-at-least-32-characters");
  })();

  await repository.init();
  const agentRepository = options.agentRepository ?? (process.env.DATABASE_URL && !options.repository
    ? new PostgresAgentRepository(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === "1" })
    : new SqliteAgentRepository(options.repository ? ":memory:" : (process.env.PLATFORM_DATABASE_PATH ?? ".data/sessionguard-platform.sqlite")));
  await Promise.all([agentRepository.init(), coordinator.init()]);
  const envelope = new EnvelopeVault(keyManager);
  const credentialVault = new PersistentCredentialVault(repository, envelope);
  const market = options.marketService ?? new ProductionMarketService(repository, coordinator, options.marketFetcher);
  const adapter = options.tradingAdapter ?? new BitgetDemoTradingAdapter();
  const tokens = new ProductionDecisionTokenService(signingKey, coordinator);
  const telemetry = new SessionGuardTelemetry(process.env.SENTRY_DSN, production ? "production" : "development");
  const sender = options.notificationSender ?? new ExternalNotificationSender({
    appOrigin,
    resendApiKey: process.env.RESEND_API_KEY,
    emailFrom: process.env.EMAIL_FROM,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    vapidSubject: process.env.VAPID_SUBJECT,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
  });
  const sendVerificationEmail = process.env.RESEND_API_KEY && process.env.EMAIL_FROM
    ? async (email: string, url: string) => {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [email], subject: "Verify SessionGuard alerts",
          text: `Verify this SessionGuard alert channel: ${url}` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`EMAIL_VERIFICATION_HTTP_${response.status}`);
    }
    : undefined;
  const notifications = new NotificationService(repository, coordinator, envelope, appOrigin,
    process.env.TELEGRAM_BOT_NAME ?? "SessionGuardBot", sendVerificationEmail);
  const trading = new ProductionTradingService(repository, coordinator, market, credentialVault, adapter, tokens, notifications,
    () => telemetry.duplicateOrders.inc(), agentRepository);
  const agentRuntimeEnabled = options.agentRuntimeEnabled ?? process.env.AGENT_RUNTIME_ENABLED === "1";
  const qwenConfig = qwenConfiguration(agentRuntimeEnabled);
  const qwen = options.qwen === undefined ? (qwenConfig ? new ProductionQwenAnalyst(qwenConfig, options.marketFetcher) : null) : options.qwen;
  const eventWatcher = options.eventWatcher ?? new ProductionOfficialEventWatcher(agentRepository, { fetcher: options.marketFetcher });
  const agentGrants = new AgentGrantService(agentRepository, repository, appOrigin, notifications);
  const agent = new AgentOrchestrator({ runtimeEnabled: agentRuntimeEnabled, repository: agentRepository,
    platformRepository: repository, coordinator, market, trading, notifications, grantService: agentGrants,
    watcher: eventWatcher, qwen });
  const auth = new SiweAuthService(repository, coordinator, appOrigin, userCap);

  const app = Fastify({ logger: options.logger ?? (production ? loggerOptions() : false), bodyLimit: 64 * 1024, requestIdHeader: "x-request-id" });
  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    request.startedAtNs = process.hrtime.bigint();
    request.productionSpan = telemetry.tracer.startSpan("http.server.request", { attributes: {
      "http.request.method": request.method,
      "http.route": request.routeOptions.url ?? "unmatched",
    } });
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const telegram = request.url.startsWith("/api/v1/notifications/telegram/webhook");
      if (!telegram && request.headers["x-sessionguard-request"] !== "1") {
        return reply.code(400).send({ error: "MISSING_REQUEST_GUARD" });
      }
      const origin = request.headers.origin;
      if (!telegram && origin && origin !== new URL(appOrigin).origin) return reply.code(403).send({ error: "ORIGIN_MISMATCH" });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unknown";
    telemetry.requests.inc({ method: request.method, route, status: String(reply.statusCode) });
    if (request.startedAtNs) telemetry.duration.observe({ method: request.method, route }, Number(process.hrtime.bigint() - request.startedAtNs) / 1e9);
    request.productionSpan?.setAttribute("http.response.status_code", reply.statusCode);
    request.productionSpan?.setStatus({ code: reply.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
    request.productionSpan?.end();
  });

  app.addHook("onError", async (request, _reply, error) => {
    request.productionSpan?.recordException(error);
    request.productionSpan?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    telemetry.capture(error, { requestId: request.id, route: request.routeOptions.url });
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    if (production) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
    reply.header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.bitget.com https://api.resend.com https://api.telegram.org; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    return payload;
  });

  async function rate(request: FastifyRequest, reply: any, bucket: string, max: number) {
    const authId = request.cookies.sg_auth ?? request.ip;
    const result = await coordinator.rateLimit(`${bucket}:${authId}`, max, 60);
    reply.header("x-ratelimit-remaining", result.remaining);
    if (!result.allowed) { reply.code(429).send({ error: "RATE_LIMITED" }); return false; }
    return true;
  }

  async function requireAuth(request: FastifyRequest, reply: any, fresh = false): Promise<AuthContext | null> {
    const context = await auth.authenticate(request.cookies.sg_auth);
    if (!context) { reply.code(401).send({ error: "WALLET_AUTH_REQUIRED" }); return null; }
    if (fresh && !auth.isFresh(context.session)) { reply.code(428).send({ error: "FRESH_WALLET_SIGNATURE_REQUIRED" }); return null; }
    request.productionAuth = context;
    return context;
  }

  const health = () => ({ ok: true, service: "sessionguard", mode: "paper-only", marketSource: "BITGET_ONLY", userCap });
  app.get("/api/health", async () => health());
  app.get("/api/v1/health/live", async () => health());
  app.get("/api/v1/health/ready", async (_request, reply) => {
    const [database, agentDatabase, redis] = await Promise.all([repository.ready(), agentRepository.ready(), coordinator.ready()]);
    return reply.code(database && agentDatabase && redis ? 200 : 503).send({ ok: database && agentDatabase && redis, database, agentDatabase, redis, execution: "paper-only" });
  });
  app.get("/api/v1/metrics", async (request, reply) => {
    if (production && !secureEqual(String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), process.env.METRICS_TOKEN)) return reply.code(401).send({ error: "METRICS_AUTH_REQUIRED" });
    return reply.type(telemetry.contentType()).send(await telemetry.metrics());
  });

  app.get("/api/replays", async () => ({ scenarios: replayScenarios }));
  app.get("/api/v1/replays", async () => ({ scenarios: replayScenarios.map(({ id, name, kicker, description, snapshot }) => ({ id, name, kicker, description, symbol: snapshot.symbol })) }));


  app.get("/api/v1/agent/status", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    return { status: await agent.status(context.user.id) };
  });
  app.get("/api/v1/agent/settings", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    return { settings: await agent.settings(context.user.id) };
  });
  app.put("/api/v1/agent/settings", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    if (!await rate(request, reply, "agent-settings", 10)) return;
    const parsed = UpdateAgentSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_AGENT_SETTINGS", details: parsed.error.issues });
    try { return { settings: await agent.updateSettings(context.user.id, parsed.data) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "AGENT_SETTINGS_FAILED" }); }
  });
  app.post("/api/v1/agent/grants/challenge", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    if (!await rate(request, reply, "agent-grant", 5)) return;
    const parsed = AgentGrantScopeInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_AGENT_GRANT_SCOPE", details: parsed.error.issues });
    try { return await agentGrants.createChallenge(context.user, parsed.data); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "AGENT_GRANT_CHALLENGE_FAILED" }); }
  });
  app.post("/api/v1/agent/grants/verify", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    if (!await rate(request, reply, "agent-grant-verify", 5)) return;
    const parsed = AgentGrantVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_AGENT_GRANT_PROOF" });
    try { return await agentGrants.verify(context.user, parsed.data); }
    catch (error) { return reply.code(401).send({ error: error instanceof Error ? error.message : "AGENT_GRANT_VERIFY_FAILED" }); }
  });
  app.delete("/api/v1/agent/grants/current", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    if (!await rate(request, reply, "agent-grant-revoke", 10)) return;
    return agentGrants.revoke(context.user.id);
  });
  app.get("/api/v1/agent/runs", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    const query = request.query as { cursor?: string; limit?: string }; const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25)));
    return agentRepository.listRuns(context.user.id, limit, query.cursor);
  });
  app.get("/api/v1/agent/runs/:id", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    const detail = await agentRepository.getRunDetail(context.user.id, (request.params as { id: string }).id);
    return detail ? { run: detail } : reply.code(404).send({ error: "AGENT_RUN_NOT_FOUND" });
  });
  app.post("/api/v1/agent/runs/manual-shadow", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    if (!agentRuntimeEnabled) return reply.code(503).send({ error: "AGENT_RUNTIME_DISABLED" });
    if (!await rate(request, reply, "agent-manual", 5)) return;
    const parsed = ManualShadowRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MANUAL_SHADOW_REQUEST" });
    try { return reply.code(202).send({ run: await agent.manualShadow(context.user.id, parsed.data.symbol, parsed.data.triggerType) }); }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : "MANUAL_SHADOW_FAILED" }); }
  });
  app.post("/api/v1/agent/replays/:replayId", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    if (!agentRuntimeEnabled) return reply.code(503).send({ error: "AGENT_RUNTIME_DISABLED" });
    if (!await rate(request, reply, "agent-replay", 10)) return;
    const parsed = ReplayAgentRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_AGENT_REPLAY_REQUEST" });
    try { return reply.code(202).send({ run: await agent.replay(context.user.id, (request.params as { replayId: string }).replayId, parsed.data.analyst) }); }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : "REPLAY_NOT_FOUND" }); }
  });
  app.get("/api/v1/agent/outcomes", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    const query = request.query as { cursor?: string; limit?: string }; const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25)));
    return agentRepository.listOutcomes(context.user.id, limit, query.cursor);
  });
  app.get("/api/v1/agent/stream", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform",
      connection: "keep-alive", "x-accel-buffering": "no" });
    reply.raw.write(`event: status\ndata: ${JSON.stringify(await agent.status(context.user.id))}\n\n`);
    const unsubscribe = await coordinator.subscribe(`agent:${context.user.id}`, (payload) => reply.raw.write(`event: agent\ndata: ${payload}\n\n`));
    const keepalive = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);
    request.raw.on("close", () => { clearInterval(keepalive); void unsubscribe(); });
  });

  app.post("/api/v1/auth/nonce", async (request, reply) => {
    if (!await rate(request, reply, "auth-nonce", 10)) return;
    const parsed = SiweNonceRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_AUTH_REQUEST" });
    return auth.createChallenge(parsed.data.address);
  });

  app.post("/api/v1/auth/verify", async (request, reply) => {
    if (!await rate(request, reply, "auth-verify", 10)) return;
    const parsed = SiweVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_AUTH_PROOF" });
    try {
      const verified = await auth.verify(parsed.data.message, parsed.data.signature);
      reply.setCookie("sg_auth", verified.session.id, { httpOnly: true, secure: production, sameSite: "lax", path: "/", maxAge: 7 * 86_400 });
      await notifications.ensureInApp(verified.user.id);
      return { user: verified.user };
    } catch (error) {
      const message = error instanceof Error ? error.message : "AUTH_FAILED";
      return reply.code(message === "PUBLIC_BETA_CAP_REACHED" ? 403 : 401).send({ error: message });
    }
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const context = await auth.authenticate(request.cookies.sg_auth);
    return context ? { authenticated: true, user: context.user } : reply.code(401).send({ authenticated: false, error: "WALLET_AUTH_REQUIRED" });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const context = await auth.authenticate(request.cookies.sg_auth, false);
    await auth.logout(request.cookies.sg_auth, context?.user.id);
    reply.clearCookie("sg_auth", { path: "/" });
    return { authenticated: false };
  });

  app.get("/api/v1/market/snapshots/:symbol", async (request, reply) => {
    if (!await rate(request, reply, "market", 120)) return;
    const symbol = SupportedSymbolSchema.safeParse((request.params as { symbol: string }).symbol);
    if (!symbol.success) return reply.code(400).send({ error: "UNSUPPORTED_RTOKEN" });
    const query = request.query as { mode?: string; replayId?: string };
    const mode = query.mode === "REPLAY" ? "REPLAY" : "LIVE_BITGET";
    try { return { snapshot: await market.snapshot(symbol.data, { mode, replayId: query.replayId }) }; }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : "BITGET_UNAVAILABLE", fallback: "REPLAY" }); }
  });

  app.get("/api/v1/market/stream", async (request, reply) => {
    const symbol = SupportedSymbolSchema.safeParse((request.query as { symbol?: string }).symbol);
    if (!symbol.success) return reply.code(400).send({ error: "UNSUPPORTED_RTOKEN" });
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    const write = (payload: string) => reply.raw.write(`event: market\ndata: ${payload}\n\n`);
    const unsubscribe = await coordinator.subscribe(`market:${symbol.data}`, write);
    const keepalive = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);
    request.raw.on("close", () => { clearInterval(keepalive); void unsubscribe(); });
  });

  app.get("/api/v1/connections/bitget-demo", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    return trading.connectionStatus(context.user.id);
  });
  app.put("/api/v1/connections/bitget-demo", async (request, reply) => {
    const context = await requireAuth(request, reply, true); if (!context) return;
    if (!await rate(request, reply, "credential", 5)) return;
    const parsed = PersistentDemoConnectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_DEMO_CREDENTIALS" });
    try { return await trading.connect(context.user.id, parsed.data); }
    catch { return reply.code(401).send({ error: "BITGET_DEMO_VALIDATION_FAILED" }); }
  });
  app.delete("/api/v1/connections/bitget-demo", async (request, reply) => {
    const context = await requireAuth(request, reply, true); if (!context) return;
    await agentGrants.revoke(context.user.id, "DEMO_DISCONNECTED");
    return trading.disconnect(context.user.id);
  });

  app.get("/api/v1/portfolio", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    const query = request.query as { mode?: string; replayId?: string };
    try { return { portfolio: await trading.portfolio(context.user.id, query.mode === "REPLAY" ? "REPLAY" : "LIVE_BITGET", query.replayId) }; }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : "PORTFOLIO_UNAVAILABLE" }); }
  });

  app.get("/api/v1/policies", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    return trading.getPolicy(context.user.id);
  });
  app.put("/api/v1/policies", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    const parsed = UserPolicySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "POLICY_MAY_ONLY_TIGHTEN_PLATFORM_LIMITS", details: parsed.error.issues });
    await agentGrants.revoke(context.user.id, "USER_POLICY_UPDATED");
    return trading.updatePolicy(context.user.id, parsed.data);
  });

  app.post("/api/v1/guard/evaluate", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    if (!await rate(request, reply, "guard", 30)) return;
    const parsed = GuardEvaluationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_GUARD_REQUEST", details: parsed.error.issues });
    try { return { decision: await trading.evaluate(context.user.id, context.session.id, parsed.data) }; }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : "GUARD_UNAVAILABLE" }); }
  });

  app.post("/api/v1/paper-orders", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    if (!await rate(request, reply, "paper-order", 10)) return;
    const parsed = PaperOrderRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PAPER_ORDER_REQUEST" });
    try { return { order: await trading.execute(context.user.id, context.session.id, parsed.data.decisionToken) }; }
    catch (error) {
      const message = error instanceof Error ? error.message : "PAPER_ORDER_FAILED";
      const conflict = /CHANGED|KILLED|ALREADY_USED|LIMIT/.test(message);
      return reply.code(conflict ? 409 : 400).send({ error: message });
    }
  });

  app.get("/api/v1/decisions", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25)));
    const offset = Math.max(0, Number(query.offset ?? 0));
    const decisions = await repository.listDecisions(context.user.id, limit, offset);
    const receipts = await Promise.all(decisions.map(async (decision) => ({ decision, order: await repository.getOrderByDecision(decision.id, context.user.id) })));
    return { receipts, page: { limit, offset, nextOffset: receipts.length === limit ? offset + limit : null } };
  });

  app.get("/api/v1/decisions/export", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    const decisions = await repository.listDecisions(context.user.id, 500, 0);
    const rows = [["time", "symbol", "session", "off_hours_move_bps", "permission", "requested_cents", "allowed_cents", "rules"],
      ...decisions.map((item) => [item.createdAt, item.symbol, item.snapshot.session, item.snapshot.offHoursMoveBps ?? "", item.permission,
        item.requestedNotionalCents, item.allowedNotionalCents, item.reasonCodes.join("|")])];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    return reply.type("text/csv").header("content-disposition", "attachment; filename=sessionguard-production-decisions.csv").send(csv);
  });

  app.get("/api/v1/notifications/channels", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    return { channels: await notifications.listChannels(context.user.id), vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null };
  });
  app.post("/api/v1/notifications/channels", async (request, reply) => {
    const context = await requireAuth(request, reply, true); if (!context) return;
    const parsed = NotificationChannelInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_NOTIFICATION_CHANNEL" });
    if (parsed.data.type === "EMAIL") return notifications.addEmail(context.user.id, parsed.data.email);
    if (parsed.data.type === "TELEGRAM") return notifications.addTelegram(context.user.id);
    return { channel: await notifications.addWebPush(context.user.id, parsed.data.subscription) };
  });
  app.delete("/api/v1/notifications/channels/:id", async (request, reply) => {
    const context = await requireAuth(request, reply, true); if (!context) return;
    try { await notifications.removeChannel(context.user.id, (request.params as { id: string }).id); return { removed: true }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "CHANNEL_REMOVE_FAILED" }); }
  });
  app.get("/api/v1/notifications/verify-email", async (request, reply) => {
    try { const channel = await notifications.verifyEmail(String((request.query as { token?: string }).token ?? "")); return { verified: true, channel }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "VERIFICATION_FAILED" }); }
  });
  app.post("/api/v1/notifications/telegram/webhook", async (request, reply) => {
    if (!secureEqual(String(request.headers["x-telegram-bot-api-secret-token"] ?? ""), process.env.TELEGRAM_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: "INVALID_TELEGRAM_WEBHOOK" });
    }
    const body = request.body as { message?: { text?: string; chat?: { id?: string | number } } };
    const match = body.message?.text?.match(/^\/start\s+([A-Za-z0-9_-]+)$/);
    if (match && body.message?.chat?.id !== undefined) await notifications.connectTelegram(match[1], String(body.message.chat.id));
    return { ok: true };
  });
  app.get("/api/v1/notifications/inbox", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    return { notifications: await repository.listNotifications(context.user.id, 100) };
  });
  app.post("/api/v1/notifications/inbox/:id/ack", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    await repository.acknowledgeNotification((request.params as { id: string }).id, context.user.id, new Date().toISOString());
    return { acknowledged: true };
  });
  app.post("/api/v1/notifications/test", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    return { notification: await notifications.emit(context.user.id, { kind: "SESSION_TRANSITION", severity: "INFO", title: "SessionGuard test",
      body: "Your verified alert pipeline is ready." }, `test:${Math.floor(Date.now() / 60_000)}`) };
  });
  app.get("/api/v1/notifications/stream", async (request, reply) => {
    const context = await requireAuth(request, reply); if (!context) return;
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    const unsubscribe = await coordinator.subscribe(`notifications:${context.user.id}`, (payload) => reply.raw.write(`event: notification\ndata: ${payload}\n\n`));
    const keepalive = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);
    request.raw.on("close", () => { clearInterval(keepalive); void unsubscribe(); });
  });

  app.get("/api/v1/account/export", async (request, reply) => {
    const context = await requireAuth(request, reply, true); if (!context) return;
    const [policy, decisions, channels, inbox] = await Promise.all([
      trading.getPolicy(context.user.id), repository.listDecisions(context.user.id, 500, 0),
      notifications.listChannels(context.user.id), repository.listNotifications(context.user.id, 500),
    ]);
    const agentData = await agentRepository.exportUserData(context.user.id);
    reply.header("content-disposition", "attachment; filename=sessionguard-account-export.json");
    return { exportedAt: new Date().toISOString(), user: context.user, policy, decisions, channels, notifications: inbox, agent: agentData };
  });
  app.delete("/api/v1/account", async (request, reply) => {
    const context = await requireAuth(request, reply, true); if (!context) return;
    await agentGrants.revoke(context.user.id, "ACCOUNT_DELETED");
    await agentRepository.deleteUserData(context.user.id);
    await credentialVault.destroy(context.user.id);
    await repository.saveAudit(context.user.id, "ACCOUNT_DELETED", context.user.id, {});
    await repository.deleteUser(context.user.id);
    await coordinator.deleteSession(context.session.id);
    reply.clearCookie("sg_auth", { path: "/" });
    return { deleted: true, backupExpiryDays: 35 };
  });

  const authorizeAdmin = (request: FastifyRequest, reply: any) => {
    if (!secureEqual(String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), process.env.ADMIN_TOKEN)) {
      reply.code(401).send({ error: "ADMIN_AUTH_REQUIRED" });
      return false;
    }
    return true;
  };

  app.get("/api/v1/admin/kill-switch", async (request, reply) => {
    if (!authorizeAdmin(request, reply)) return;
    const parsed = KillSwitchScopeSchema.safeParse((request.query as { scope?: string }).scope);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_KILL_SWITCH_SCOPE" });
    return { scope: parsed.data, enabled: Boolean(await coordinator.cacheGet<boolean>(`kill:${parsed.data}`)) };
  });

  app.put("/api/v1/admin/kill-switch", async (request, reply) => {
    if (!authorizeAdmin(request, reply)) return;
    const parsed = KillSwitchRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_KILL_SWITCH_REQUEST" });
    await coordinator.cacheSet(`kill:${parsed.data.scope}`, parsed.data.enabled, 10 * 365 * 86_400);
    await repository.saveAudit(null, "KILL_SWITCH_UPDATED", parsed.data.scope, { enabled: parsed.data.enabled });
    return parsed.data;
  });

  if (production) {
    await app.register(fastifyStatic, { root: options.staticRoot ?? resolve(process.cwd(), "dist"), wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/")
      ? reply.code(404).send({ error: "API_ROUTE_NOT_FOUND" })
      : reply.sendFile("index.html"));
  }

  const retention = setInterval(() => void repository.prune(new Date()).catch((error) => telemetry.capture(error, { job: "retention" })), 6 * 60 * 60_000);
  retention.unref();
  app.addHook("onClose", async () => {
    clearInterval(retention);
    await Promise.allSettled([repository.close(), agentRepository.close(), coordinator.close()]);
  });

  return app;
}
