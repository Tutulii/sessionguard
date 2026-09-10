import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  DemoConnectSchema,
  PaperOrderSchema,
  SupportedSymbolSchema,
  TradeIntentSchema,
  type AgentAssessment,
  type DemoConnectInput,
  type MarketEvent,
  type MarketSnapshot,
} from "../shared/types.js";
import { replayScenarios } from "../shared/replays.js";
import {
  validateDemoCredentials,
  placeDemoOrder,
  simulateWithOfficialSdk,
} from "./bitget-demo.js";
import { CredentialVault, hashSession } from "./credential-vault.js";
import { DecisionTokenService } from "./decision-token.js";
import { applyEventRiskFlags } from "./event-flags.js";
import { OfficialEventService } from "./events.js";
import { getLiveSnapshot } from "./market.js";
import { assessWithQwen, unavailableAssessment } from "./qwen.js";
import { evaluatePermission } from "./rules.js";
import { DecisionStore } from "./store.js";

type DemoValidation = { account: unknown; rTokenTradingSupported: boolean };
type DemoOrderArgs = Parameters<typeof placeDemoOrder>[0];
type SimulatorArgs = Parameters<typeof simulateWithOfficialSdk>[0];
type LoggerConfig = Exclude<FastifyServerOptions["logger"], boolean | undefined>;

export function sessionGuardLoggerOptions(stream?: LoggerConfig["stream"]): LoggerConfig {
  const config: LoggerConfig = {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.apiKey",
        "req.body.secretKey",
        "req.body.passphrase",
        "body.apiKey",
        "body.secretKey",
        "body.passphrase",
      ],
      censor: "[REDACTED]",
    },
  };
  if (stream) config.stream = stream;
  return config;
}

export type SessionGuardAppOptions = {
  production?: boolean;
  startEvents?: boolean;
  databasePath?: string;
  sessionSecret?: string;
  staticRoot?: string;
  logger?: FastifyServerOptions["logger"];
  initialEvents?: MarketEvent[];
  getSnapshot?: (symbol: Parameters<typeof getLiveSnapshot>[0]) => Promise<MarketSnapshot>;
  assess?: (event: MarketEvent, notional: number) => Promise<AgentAssessment>;
  validateCredentials?: (credentials: DemoConnectInput) => Promise<DemoValidation>;
  submitDemoOrder?: (args: DemoOrderArgs) => Promise<Record<string, unknown>>;
  simulateOrder?: (args: SimulatorArgs) => Promise<Record<string, unknown>>;
};

export async function createSessionGuardApp(options: SessionGuardAppOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === "production";
  if (production && !options.sessionSecret && !process.env.SESSION_MASTER_KEY) {
    throw new Error("SESSION_MASTER_KEY is required in production");
  }
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_MASTER_KEY ?? randomBytes(32).toString("hex");
  if (production && sessionSecret.length < 32) {
    throw new Error("SESSION_MASTER_KEY must contain at least 32 characters");
  }
  const app = Fastify({
    logger: options.logger ?? (production ? sessionGuardLoggerOptions() : false),
  });
  const store = new DecisionStore(options.databasePath);
  const vault = new CredentialVault(sessionSecret);
  const tokens = new DecisionTokenService(sessionSecret);
  const officialEvents = new OfficialEventService(store);
  const capabilities = new Map<string, boolean>();
  const snapshotProvider = options.getSnapshot ?? ((symbol) => getLiveSnapshot(symbol));
  const assessor = options.assess ?? assessWithQwen;
  const credentialValidator = options.validateCredentials ?? ((credentials) => validateDemoCredentials(credentials));
  const demoOrder = options.submitDemoOrder ?? placeDemoOrder;
  const simulator = options.simulateOrder ?? simulateWithOfficialSdk;

  for (const event of options.initialEvents ?? []) store.saveEvent(event);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => `${request.ip}:${request.cookies.sg_session ?? "public"}`,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      if (request.headers["x-sessionguard-request"] !== "1") {
        return reply.code(400).send({ error: "Missing SessionGuard request header" });
      }
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (production) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    reply.header(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.bitget.com; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    return payload;
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "sessionguard",
    mode: "paper-only",
    qwenConfigured: Boolean(process.env.QWEN_API_KEY),
  }));

  app.get("/api/replays", async () => ({ scenarios: replayScenarios }));

  app.get("/api/market/snapshot/:symbol", async (request, reply) => {
    const parsed = SupportedSymbolSchema.safeParse((request.params as { symbol: string }).symbol);
    if (!parsed.success) return reply.code(400).send({ error: "Unsupported rToken symbol" });
    try {
      return { snapshot: await snapshotProvider(parsed.data) };
    } catch (error) {
      return reply.code(503).send({
        error: error instanceof Error ? error.message : "Live market data is unavailable",
        fallback: "replay",
      });
    }
  });

  app.get("/api/events", async (request) => {
    const query = request.query as { refresh?: string };
    if (query.refresh === "1") await officialEvents.refresh();
    return { events: store.listEvents(30) };
  });

  app.get("/api/demo/session", async (request) => {
    const id = request.cookies.sg_session;
    const credentials = id ? vault.read(id) : null;
    if (id && !credentials) capabilities.delete(id);
    const executionEnabled = Boolean(id && credentials && capabilities.get(id));
    return {
      connected: Boolean(credentials),
      executionEnabled,
      rTokenTradingSupported: executionEnabled,
      mode: "paper-only",
    };
  });

  app.post(
    "/api/demo/connect",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = DemoConnectSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid demo credentials" });
      try {
        const validation = await credentialValidator(parsed.data);
        const oldId = request.cookies.sg_session;
        if (oldId) {
          vault.destroy(oldId);
          capabilities.delete(oldId);
        }
        const id = vault.create(parsed.data);
        capabilities.set(id, validation.rTokenTradingSupported);
        reply.setCookie("sg_session", id, {
          httpOnly: true,
          sameSite: "strict",
          secure: production,
          path: "/",
          maxAge: 30 * 60,
        });
        return {
          connected: true,
          executionEnabled: validation.rTokenTradingSupported,
          rTokenTradingSupported: validation.rTokenTradingSupported,
          mode: "paper-only",
        };
      } catch (error) {
        return reply.code(401).send({
          error: error instanceof Error ? error.message : "Demo credentials could not be verified",
        });
      }
    },
  );

  app.delete("/api/demo/session", async (request, reply) => {
    const id = request.cookies.sg_session;
    if (id) {
      vault.destroy(id);
      capabilities.delete(id);
    }
    reply.clearCookie("sg_session", { path: "/" });
    return { connected: false, executionEnabled: false };
  });

  app.post(
    "/api/agent/evaluate",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = TradeIntentSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid trade intent" });
      const intent = parsed.data;
      const replay = replayScenarios.find((scenario) => scenario.event.id === intent.eventId);
      let snapshot: MarketSnapshot;
      let event: MarketEvent;
      let assessment: AgentAssessment;
      let agentUnavailable = false;

      if (intent.mode === "replay") {
        if (!replay || replay.snapshot.symbol !== intent.symbol) {
          return reply.code(404).send({ error: "Replay scenario was not found for this symbol" });
        }
        snapshot = replay.snapshot;
        event = replay.event;
        assessment = replay.assessment;
      } else {
        const found = store.listEvents(100).find((candidate) => candidate.id === intent.eventId);
        if (!found || found.symbol !== intent.symbol || !found.isOfficial) {
          return reply.code(404).send({ error: "Matching official event was not found" });
        }
        event = found;
        const [snapshotResult, assessmentResult] = await Promise.allSettled([
          snapshotProvider(intent.symbol),
          assessor(event, intent.notionalUsd),
        ]);
        if (snapshotResult.status === "rejected") {
          return reply.code(503).send({ error: "Live market data is unavailable", fallback: "replay" });
        }
        snapshot = applyEventRiskFlags(snapshotResult.value, event);
        if (assessmentResult.status === "fulfilled") {
          assessment = assessmentResult.value;
        } else {
          assessment = unavailableAssessment(event);
          agentUnavailable = true;
        }
      }

      const decision = evaluatePermission({ snapshot, assessment, intent });
      if (agentUnavailable) {
        decision.verdict = "BLOCK";
        decision.allowedNotionalUsd = 0;
        decision.ruleCodes.unshift("AGENT_UNAVAILABLE");
        decision.reasons.unshift("Qwen was unavailable or returned invalid output.");
      }

      const sessionId = request.cookies.sg_session;
      const sessionHash = intent.mode === "replay"
        ? "public"
        : sessionId
          ? hashSession(sessionId)
          : "public";
      const liveExecutionEnabled = Boolean(sessionId && vault.read(sessionId) && capabilities.get(sessionId));
      if (decision.verdict === "TRADE" && (intent.mode === "replay" || liveExecutionEnabled)) {
        const issued = tokens.issue({
          decisionId: decision.id,
          symbol: decision.symbol,
          side: intent.side,
          allowedNotionalUsd: decision.allowedNotionalUsd,
          mode: intent.mode,
          sessionHash: intent.mode === "replay" ? "replay" : sessionHash,
        });
        decision.decisionToken = issued.token;
        decision.tokenExpiresAt = issued.expiresAt;
      }
      store.saveDecision(decision, event, sessionHash);
      return {
        receipt: { decision, event, order: null },
        executionEnabled: intent.mode === "replay" || liveExecutionEnabled,
      };
    },
  );

  app.post(
    "/api/demo/orders",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = PaperOrderSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid paper order request" });
      let untrustedMode: "live" | "replay";
      try {
        const encoded = parsed.data.decisionToken.split(".")[0];
        const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { mode?: unknown };
        if (decoded.mode !== "live" && decoded.mode !== "replay") throw new Error("Invalid token mode");
        untrustedMode = decoded.mode;
      } catch {
        return reply.code(400).send({ error: "Malformed decision token" });
      }
      const sessionId = request.cookies.sg_session;
      const expectedHash = untrustedMode === "replay"
        ? "replay"
        : sessionId
          ? hashSession(sessionId)
          : "missing";
      try {
        const token = tokens.consume(parsed.data.decisionToken, expectedHash);
        const receipt = store.getReceipt(token.decisionId);
        if (
          !receipt ||
          receipt.decision.verdict !== "TRADE" ||
          receipt.decision.symbol !== token.symbol ||
          receipt.decision.allowedNotionalUsd !== token.allowedNotionalUsd
        ) {
          return reply.code(403).send({ error: "The underlying decision is not executable" });
        }
        let order;
        if (token.mode === "replay") {
          const result = await simulator({
            symbol: token.symbol,
            side: token.side,
            notionalUsd: token.allowedNotionalUsd,
            rTokenPrice: receipt.decision.snapshot.rTokenPrice,
          });
          order = {
            status: "SIMULATED" as const,
            orderId: String(result.orderId ?? result.clientOid ?? `sdk_${token.decisionId.slice(0, 8)}`),
            message: "Replay order filled by the official Bitget SDK MockServer.",
            submittedAt: new Date().toISOString(),
          };
        } else {
          if (!sessionId) return reply.code(401).send({ error: "Connect a Bitget demo account first" });
          const credentials = vault.read(sessionId);
          if (!credentials) return reply.code(401).send({ error: "Demo session expired" });
          if (!capabilities.get(sessionId)) {
            return reply.code(409).send({ error: "rToken spot execution is unavailable in this demo account" });
          }
          const latest = applyEventRiskFlags(await snapshotProvider(token.symbol), receipt.event);
          if (
            latest.session !== receipt.decision.snapshot.session ||
            latest.flags.some((flag) => ["HALT", "STALE_QUOTE", "REFERENCE_UNAVAILABLE"].includes(flag)) ||
            latest.alignedReference === null ||
            latest.basisBps === null ||
            latest.spreadBps > (latest.session === "EXTENDED" ? 50 : 35) ||
            Math.abs(latest.basisBps) > 250
          ) {
            return reply.code(409).send({ error: "Market conditions changed; run SessionGuard again" });
          }
          const result = await demoOrder({
            credentials,
            symbol: token.symbol,
            side: token.side,
            notionalUsd: token.allowedNotionalUsd,
            rTokenPrice: latest.rTokenPrice,
          });
          order = {
            status: "SUBMITTED" as const,
            orderId: String(result.orderId ?? result.clientOid ?? "paper-submitted"),
            message: "Order submitted to Bitget demo trading in paper-only mode.",
            submittedAt: new Date().toISOString(),
          };
        }
        store.saveOrder(token.decisionId, order);
        return { receipt: { ...receipt, order } };
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Paper order could not be submitted",
        });
      }
    },
  );

  app.get("/api/decisions", async (request) => {
    const sessionId = request.cookies.sg_session;
    const scope = sessionId ? hashSession(sessionId) : "public";
    return { receipts: store.listReceipts(scope, 50) };
  });

  app.get("/api/decisions/export", async (request, reply) => {
    const sessionId = request.cookies.sg_session;
    const scope = sessionId ? hashSession(sessionId) : "public";
    const receipts = store.listReceipts(scope, 500);
    const format = (request.query as { format?: string }).format;
    if (format === "csv") {
      const rows = [
        ["time", "symbol", "session", "basis_bps", "verdict", "requested_usd", "allowed_usd", "rules", "order_status"],
        ...receipts.map((receipt) => [
          receipt.decision.createdAt,
          receipt.decision.symbol,
          receipt.decision.snapshot.session,
          receipt.decision.snapshot.basisBps ?? "",
          receipt.decision.verdict,
          receipt.decision.requestedNotionalUsd,
          receipt.decision.allowedNotionalUsd,
          receipt.decision.ruleCodes.join("|"),
          receipt.order?.status ?? "",
        ]),
      ];
      const csv = rows
        .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
        .join("\n");
      reply.type("text/csv").header("content-disposition", "attachment; filename=sessionguard-decisions.csv");
      return csv;
    }
    reply.type("application/json").header("content-disposition", "attachment; filename=sessionguard-decisions.json");
    return JSON.stringify(receipts, null, 2);
  });

  if (production) {
    await app.register(fastifyStatic, {
      root: options.staticRoot ?? resolve(process.cwd(), "dist"),
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "API route not found" });
      return reply.sendFile("index.html");
    });
  }

  if (options.startEvents) officialEvents.start();
  const cleanup = setInterval(() => {
    vault.cleanup();
    for (const id of capabilities.keys()) {
      if (!vault.read(id)) capabilities.delete(id);
    }
  }, 60_000);
  cleanup.unref();

  app.addHook("onClose", async () => {
    clearInterval(cleanup);
    officialEvents.stop();
    store.close();
  });

  return app;
}
