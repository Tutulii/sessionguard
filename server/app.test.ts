import type { FastifyInstance } from "fastify";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replayScenarios } from "../shared/replays.js";
import type { AgentAssessment, MarketSnapshot } from "../shared/types.js";
import { createSessionGuardApp, sessionGuardLoggerOptions } from "./app.js";

const openScenario = replayScenarios[1];
const officialEvent = { ...openScenario.event, source: "SEC" as const, isOfficial: true };
const mutateHeaders = { "x-sessionguard-request": "1", "content-type": "application/json" };
const apps: FastifyInstance[] = [];

async function testApp(overrides: Parameters<typeof createSessionGuardApp>[0] = {}) {
  const app = await createSessionGuardApp({
    databasePath: ":memory:",
    sessionSecret: "test-session-secret",
    logger: false,
    initialEvents: [officialEvent],
    getSnapshot: async () => ({ ...openScenario.snapshot, sourceMode: "live" }),
    assess: async () => openScenario.assessment,
    validateCredentials: async () => ({ account: [], rTokenTradingSupported: true }),
    submitDemoOrder: async () => ({ orderId: "demo-order-1" }),
    simulateOrder: async () => ({ orderId: "sdk-sim-order-1" }),
    ...overrides,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("SessionGuard API", () => {
  it("reports paper-only health and sends defensive headers", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, mode: "paper-only" });
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("requires the same-origin mutation header", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "POST", url: "/api/agent/evaluate", payload: openScenario.intent });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/request header/i);
  });

  it("returns a deterministic replay catalog", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/replays" });
    expect(response.json().scenarios).toHaveLength(3);
  });

  it("proves BLOCK and ALERT decisions cannot acquire an execution token", async () => {
    const simulator = vi.fn(async () => ({ orderId: "must-not-run" }));
    const app = await testApp({ simulateOrder: simulator });
    for (const scenario of [replayScenarios[0], replayScenarios[2]]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/evaluate",
        headers: mutateHeaders,
        payload: scenario.intent,
      });
      expect(response.statusCode).toBe(200);
      const decision = response.json().receipt.decision;
      expect(["BLOCK", "ALERT"]).toContain(decision.verdict);
      expect(decision.decisionToken).toBeUndefined();
      expect(decision.allowedNotionalUsd).toBe(0);
    }
    expect(simulator).not.toHaveBeenCalled();
  });

  it("executes an allowed replay once through the SDK simulator boundary", async () => {
    const simulator = vi.fn(async () => ({ orderId: "sdk-sim-order-42" }));
    const app = await testApp({ simulateOrder: simulator });
    const evaluated = await app.inject({
      method: "POST",
      url: "/api/agent/evaluate",
      headers: mutateHeaders,
      payload: openScenario.intent,
    });
    const token = evaluated.json().receipt.decision.decisionToken as string;
    expect(token).toBeTruthy();
    const persisted = await app.inject({ method: "GET", url: "/api/decisions" });
    expect(persisted.json().receipts[0].decision.decisionToken).toBeUndefined();
    expect(persisted.body).not.toContain(token);
    const placed = await app.inject({
      method: "POST",
      url: "/api/demo/orders",
      headers: mutateHeaders,
      payload: { decisionToken: token },
    });
    expect(placed.statusCode).toBe(200);
    expect(placed.json().receipt.order).toMatchObject({ status: "SIMULATED", orderId: "sdk-sim-order-42" });
    expect(placed.json().receipt.order.message).toContain("official Bitget SDK MockServer");
    expect(simulator).toHaveBeenCalledTimes(1);

    const reused = await app.inject({ method: "POST", url: "/api/demo/orders", headers: mutateHeaders, payload: { decisionToken: token } });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error).toMatch(/already used/i);
  });

  it("fails a live decision closed when Qwen is unavailable", async () => {
    const app = await testApp({ assess: async () => { throw new Error("Qwen timeout"); } });
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/evaluate",
      headers: mutateHeaders,
      payload: { ...openScenario.intent, mode: "live", eventId: officialEvent.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().receipt.decision).toMatchObject({ verdict: "BLOCK", allowedNotionalUsd: 0 });
    expect(response.json().receipt.decision.ruleCodes).toContain("AGENT_UNAVAILABLE");
  });

  it("fails live market errors with an explicit replay fallback", async () => {
    const app = await testApp({ getSnapshot: async () => { throw new Error("ticker unavailable"); } });
    const response = await app.inject({ method: "GET", url: "/api/market/snapshot/RNVDAUSDT" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ fallback: "replay" });
  });

  it("rejects cross-symbol event substitution", async () => {
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/evaluate",
      headers: mutateHeaders,
      payload: { ...openScenario.intent, mode: "live", symbol: "RTSLAUSDT", eventId: officialEvent.id },
    });
    expect(response.statusCode).toBe(404);
  });

  it("connects ephemeral demo credentials and exposes capability honestly", async () => {
    const validator = vi.fn(async () => ({ account: [], rTokenTradingSupported: false }));
    const app = await testApp({ validateCredentials: validator });
    const credentials = { apiKey: "private-api-key", secretKey: "private-secret-key", passphrase: "private-pass" };
    const connected = await app.inject({ method: "POST", url: "/api/demo/connect", headers: mutateHeaders, payload: credentials });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({ connected: true, executionEnabled: false });
    expect(validator).toHaveBeenCalledWith(credentials);
    const cookie = String(connected.headers["set-cookie"]).split(";")[0];
    expect(String(connected.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(connected.headers["set-cookie"])).toContain("SameSite=Strict");
    const session = await app.inject({ method: "GET", url: "/api/demo/session", headers: { cookie } });
    expect(session.json()).toMatchObject({ connected: true, executionEnabled: false });
    const exported = await app.inject({ method: "GET", url: "/api/decisions/export", headers: { cookie } });
    expect(exported.body).not.toContain(credentials.apiKey);
    expect(exported.body).not.toContain(credentials.secretKey);
  });
  it("redacts credential-shaped fields from structured logs", async () => {
    let logs = "";
    const stream = new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    });
    const app = await testApp({ logger: sessionGuardLoggerOptions(stream) });
    const secrets = {
      apiKey: "private-api-key",
      secretKey: "private-secret-key",
      passphrase: "private-passphrase",
    };
    app.log.info({
      body: secrets,
      req: { headers: { authorization: "Bearer private-token", cookie: "sg_session=private-cookie" }, body: secrets },
    }, "redaction acceptance probe");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(logs).toContain("[REDACTED]");
    for (const secret of [...Object.values(secrets), "private-token", "private-cookie"]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("rate limits repeated demo connection attempts", async () => {
    const app = await testApp();
    const payload = { apiKey: "test-api-key", secretKey: "test-secret-key", passphrase: "test-pass" };
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      statuses.push((await app.inject({ method: "POST", url: "/api/demo/connect", headers: mutateHeaders, payload })).statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it("does not throttle read-only assets behind mutation limits", async () => {
    const app = await testApp();
    let status = 0;
    for (let index = 0; index < 125; index += 1) {
      status = (await app.inject({ method: "GET", url: "/api/health" })).statusCode;
    }
    expect(status).toBe(200);
  });

  it("deduplicates persisted decisions and exports CSV proof", async () => {
    const app = await testApp();
    await app.inject({ method: "POST", url: "/api/agent/evaluate", headers: mutateHeaders, payload: replayScenarios[0].intent });
    const list = await app.inject({ method: "GET", url: "/api/decisions" });
    expect(list.json().receipts[0].decision.verdict).toBe("BLOCK");
    const csv = await app.inject({ method: "GET", url: "/api/decisions/export?format=csv" });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("CASH_MARKET_DARK");
  });

  it("degrades official-feed failures to an empty safe result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("feed down"); }));
    const app = await testApp({ initialEvents: [] });
    const response = await app.inject({ method: "GET", url: "/api/events?refresh=1" });
    expect(response.statusCode).toBe(200);
    expect(response.json().events).toEqual([]);
  });

  it("requires a stable master key in production", async () => {
    const old = process.env.SESSION_MASTER_KEY;
    delete process.env.SESSION_MASTER_KEY;
    await expect(createSessionGuardApp({ production: true, databasePath: ":memory:", logger: false })).rejects.toThrow("SESSION_MASTER_KEY");
    if (old !== undefined) process.env.SESSION_MASTER_KEY = old;
  });

  it("rejects a weak production master key", async () => {
    await expect(createSessionGuardApp({
      production: true,
      sessionSecret: "too-short",
      databasePath: ":memory:",
      logger: false,
    })).rejects.toThrow(/at least 32 characters/i);
  });

  it("blocks injected stale data even if the model wants to buy", async () => {
    const stale: MarketSnapshot = { ...openScenario.snapshot, sourceMode: "live", flags: ["STALE_QUOTE"] };
    const bullish: AgentAssessment = { ...openScenario.assessment, proposedAction: "BUY" };
    const app = await testApp({ getSnapshot: async () => stale, assess: async () => bullish });
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/evaluate",
      headers: mutateHeaders,
      payload: { ...openScenario.intent, mode: "live", eventId: officialEvent.id },
    });
    expect(response.json().receipt.decision.verdict).toBe("BLOCK");
  });
});
