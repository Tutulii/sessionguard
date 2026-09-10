import { Wallet } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUserPolicy, type PersistentDemoConnectInput, type PortfolioSnapshot, type ProductionSymbol } from "../shared/production-types.js";
import { MemoryCoordinator } from "./coordinator.js";
import { LocalDataKeyManager } from "./envelope-vault.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { createProductionApp } from "./production-app.js";
import type { DemoTradingAdapter, PortfolioPrices } from "./production-bitget.js";

const origin = "http://localhost";
const mutationHeaders = { origin, "x-sessionguard-request": "1" };

class FakeDemoAdapter implements DemoTradingAdapter {
  validate = vi.fn(async () => ({ executionEnabled: true }));
  portfolio = vi.fn(async (userId: string, _credentials: PersistentDemoConnectInput, _prices: PortfolioPrices): Promise<PortfolioSnapshot> => ({
    userId,
    accountEquityCents: 500_000,
    availableBalanceCents: 200_000,
    collateralBufferPct: 40,
    positions: [],
    openOrderCount: 0,
    source: "BITGET_DEMO",
    capturedAt: new Date().toISOString(),
  }));
  placeOrder = vi.fn(async () => ({ orderId: "demo-order-1", raw: {} }));
  reconcile = vi.fn(async () => null);
}

type TestApp = Awaited<ReturnType<typeof createProductionApp>>;

async function authenticate(app: TestApp, wallet = Wallet.createRandom()) {
  const nonce = await app.inject({
    method: "POST",
    url: "/api/v1/auth/nonce",
    headers: mutationHeaders,
    payload: { address: wallet.address, chainId: 42161 },
  });
  expect(nonce.statusCode).toBe(200);
  const challenge = nonce.json<{ message: string }>();
  const signature = await wallet.signMessage(challenge.message);
  const verified = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    headers: mutationHeaders,
    payload: { message: challenge.message, signature },
  });
  expect(verified.statusCode).toBe(200);
  const setCookie = verified.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie!).split(";", 1)[0];
  return { wallet, cookie, user: verified.json<{ user: { id: string; address: string } }>().user, challenge, signature };
}

describe("production v1 API", () => {
  let app: TestApp;
  let repository: SqlitePlatformRepository;
  let adapter: FakeDemoAdapter;

  beforeEach(async () => {
    repository = new SqlitePlatformRepository();
    adapter = new FakeDemoAdapter();
    app = await createProductionApp({
      production: false,
      appOrigin: origin,
      repository,
      coordinator: new MemoryCoordinator(),
      keyManager: new LocalDataKeyManager("production-api-test-master-key-over-32-characters"),
      tradingAdapter: adapter,
      marketFetcher: vi.fn(async () => new Response("upstream unavailable", { status: 503 })) as typeof fetch,
    });
  });

  afterEach(async () => { await app.close(); });

  it("enforces request-origin guards and single-use SIWE proof", async () => {
    const wallet = Wallet.createRandom();
    const missingGuard = await app.inject({ method: "POST", url: "/api/v1/auth/nonce", payload: { address: wallet.address, chainId: 42161 } });
    expect(missingGuard.statusCode).toBe(400);
    const wrongOrigin = await app.inject({ method: "POST", url: "/api/v1/auth/nonce", headers: {
      origin: "https://attacker.invalid", "x-sessionguard-request": "1",
    }, payload: { address: wallet.address, chainId: 42161 } });
    expect(wrongOrigin.statusCode).toBe(403);

    const auth = await authenticate(app, wallet);
    const replay = await app.inject({ method: "POST", url: "/api/v1/auth/verify", headers: mutationHeaders,
      payload: { message: auth.challenge.message, signature: auth.signature } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("SIWE_NONCE_INVALID_OR_USED");
  });

  it("blocks weekend exposure, persists a token-free receipt, and emits an in-app alert", async () => {
    const { cookie } = await authenticate(app);
    const evaluated = await app.inject({
      method: "POST",
      url: "/api/v1/guard/evaluate",
      headers: { ...mutationHeaders, cookie },
      payload: {
        symbol: "RORCLUSDT", side: "buy", notionalCents: 25_000, maxSlippageBps: 50,
        dataMode: "REPLAY", replayId: "sunday-oracle", earningsWindow: false,
      },
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json().decision).toMatchObject({ permission: "BLOCK", allowedNotionalCents: 0, dataMode: "REPLAY" });
    expect(evaluated.json().decision.reasonCodes).toContain("CASH_MARKET_DARK");

    const decisions = await app.inject({ method: "GET", url: "/api/v1/decisions", headers: { cookie } });
    expect(decisions.statusCode).toBe(200);
    expect(decisions.json().receipts).toHaveLength(1);
    expect(decisions.json().receipts[0].decision.decisionToken).toBeUndefined();
    const inbox = await app.inject({ method: "GET", url: "/api/v1/notifications/inbox", headers: { cookie } });
    expect(inbox.json().notifications[0]).toMatchObject({ kind: "DECISION_BLOCKED", severity: "WARNING" });
  });

  it("issues one-use permission and simulates replay without calling any Bitget order method", async () => {
    const { cookie } = await authenticate(app);
    const evaluated = await app.inject({
      method: "POST",
      url: "/api/v1/guard/evaluate",
      headers: { ...mutationHeaders, cookie },
      payload: {
        symbol: "RNVDAUSDT", side: "buy", notionalCents: 15_000, maxSlippageBps: 50,
        dataMode: "REPLAY", replayId: "cash-nvidia", earningsWindow: false,
      },
    });
    const decision = evaluated.json().decision;
    expect(decision.permission).toBe("TRADE");
    expect(decision.decisionToken).toEqual(expect.any(String));

    const submitted = await app.inject({ method: "POST", url: "/api/v1/paper-orders", headers: { ...mutationHeaders, cookie },
      payload: { decisionToken: decision.decisionToken } });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().order).toMatchObject({ executionMode: "LOCAL_REPLAY", status: "SIMULATED" });
    expect(submitted.json().order.message).toMatch(/nothing was sent to Bitget/i);
    expect(adapter.placeOrder).not.toHaveBeenCalled();
    expect(adapter.reconcile).not.toHaveBeenCalled();

    const replayedToken = await app.inject({ method: "POST", url: "/api/v1/paper-orders", headers: { ...mutationHeaders, cookie },
      payload: { decisionToken: decision.decisionToken } });
    expect(replayedToken.statusCode).toBe(200);
    expect(replayedToken.json().order.id).toBe(submitted.json().order.id);
  });

  it("stores only an encrypted Demo envelope and isolates every tenant", async () => {
    const first = await authenticate(app);
    const credentials = { apiKey: "api-key-secret", secretKey: "private-secret-value", passphrase: "hidden-passphrase" };
    const connected = await app.inject({ method: "PUT", url: "/api/v1/connections/bitget-demo",
      headers: { ...mutationHeaders, cookie: first.cookie }, payload: credentials });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({ connected: true, executionEnabled: true, mode: "paper-only" });
    const stored = await repository.getConnection(first.user.id);
    expect(stored).not.toBeNull();
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(credentials.apiKey);
    expect(serialized).not.toContain(credentials.secretKey);
    expect(serialized).not.toContain(credentials.passphrase);

    const second = await authenticate(app);
    const secondConnection = await app.inject({ method: "GET", url: "/api/v1/connections/bitget-demo", headers: { cookie: second.cookie } });
    expect(secondConnection.json()).toMatchObject({ connected: false, executionEnabled: false });
    const secondDecisions = await app.inject({ method: "GET", url: "/api/v1/decisions", headers: { cookie: second.cookie } });
    expect(secondDecisions.json().receipts).toEqual([]);
  });

  it("accepts tighter policies, rejects loosened values, and exports private account data", async () => {
    const { cookie, user } = await authenticate(app);
    const tightened = { ...defaultUserPolicy, maxPaperOrderCents: 10_000, extendedSizePct: 10, allowExtended: false };
    const saved = await app.inject({ method: "PUT", url: "/api/v1/policies", headers: { ...mutationHeaders, cookie }, payload: tightened });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().policy).toMatchObject(tightened);

    const loosened = await app.inject({ method: "PUT", url: "/api/v1/policies", headers: { ...mutationHeaders, cookie },
      payload: { ...defaultUserPolicy, maxPaperOrderCents: 25_001 } });
    expect(loosened.statusCode).toBe(400);
    expect(loosened.json().error).toBe("POLICY_MAY_ONLY_TIGHTEN_PLATFORM_LIMITS");

    const exported = await app.inject({ method: "GET", url: "/api/v1/account/export", headers: { cookie } });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("sessionguard-account-export.json");
    expect(exported.json().user).toMatchObject({ id: user.id, address: user.address });
  });

  it("authenticates, validates, persists, and reads scoped kill switches", async () => {
    const previous = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "production-test-admin-token-longer-than-32-characters";
    try {
      const unauthorized = await app.inject({ method: "GET", url: "/api/v1/admin/kill-switch?scope=global" });
      expect(unauthorized.statusCode).toBe(401);
      const headers = { ...mutationHeaders, authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
      const invalid = await app.inject({ method: "PUT", url: "/api/v1/admin/kill-switch", headers,
        payload: { scope: "symbol:UNKNOWN", enabled: true } });
      expect(invalid.statusCode).toBe(400);
      const enabled = await app.inject({ method: "PUT", url: "/api/v1/admin/kill-switch", headers,
        payload: { scope: "symbol:RNVDAUSDT", enabled: true } });
      expect(enabled.json()).toEqual({ scope: "symbol:RNVDAUSDT", enabled: true });
      const read = await app.inject({ method: "GET", url: "/api/v1/admin/kill-switch?scope=symbol:RNVDAUSDT",
        headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` } });
      expect(read.json()).toEqual({ scope: "symbol:RNVDAUSDT", enabled: true });
    } finally {
      if (previous === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = previous;
    }
  });

  it("rejects unsupported symbols and never silently relabels failed Live Bitget data as replay", async () => {
    const invalid = await app.inject({ method: "GET", url: "/api/v1/market/snapshots/RMETAUSDT?mode=REPLAY" });
    expect(invalid.statusCode).toBe(400);
    const failedLive = await app.inject({ method: "GET", url: "/api/v1/market/snapshots/RNVDAUSDT?mode=LIVE_BITGET" });
    expect(failedLive.statusCode).toBe(503);
    expect(failedLive.json()).toMatchObject({ fallback: "REPLAY" });
  });
});
