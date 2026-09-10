import { Wallet } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistentDemoConnectInput, PortfolioSnapshot } from "../shared/production-types.js";
import { MemoryCoordinator } from "./coordinator.js";
import { LocalDataKeyManager } from "./envelope-vault.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { createProductionApp } from "./production-app.js";
import type { DemoTradingAdapter, PortfolioPrices } from "./production-bitget.js";

describe("production account lifecycle", () => {
  let app: Awaited<ReturnType<typeof createProductionApp>> | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it("deletes the encrypted credential immediately and invalidates the wallet session", async () => {
    const repository = new SqlitePlatformRepository();
    const adapter: DemoTradingAdapter = {
      validate: vi.fn(async () => ({ executionEnabled: true })),
      portfolio: vi.fn(async (userId: string, _credentials: PersistentDemoConnectInput, _prices: PortfolioPrices): Promise<PortfolioSnapshot> => ({
        userId, accountEquityCents: 100_000, availableBalanceCents: 100_000, collateralBufferPct: 100,
        positions: [], openOrderCount: 0, source: "BITGET_DEMO", capturedAt: new Date().toISOString(),
      })),
      placeOrder: vi.fn(async () => ({ orderId: "unused", raw: {} })), reconcile: vi.fn(async () => null),
    };
    const origin = "http://localhost"; const mutation = { origin, "x-sessionguard-request": "1" };
    app = await createProductionApp({ production: false, appOrigin: origin, repository, coordinator: new MemoryCoordinator(),
      keyManager: new LocalDataKeyManager("account-lifecycle-key-longer-than-32-characters"), tradingAdapter: adapter });
    const wallet = Wallet.createRandom();
    const nonce = await app.inject({ method: "POST", url: "/api/v1/auth/nonce", headers: mutation,
      payload: { address: wallet.address, chainId: 42161 } });
    const challenge = nonce.json<{ message: string }>();
    const verified = await app.inject({ method: "POST", url: "/api/v1/auth/verify", headers: mutation,
      payload: { message: challenge.message, signature: await wallet.signMessage(challenge.message) } });
    const cookieHeader = verified.headers["set-cookie"]!;
    const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader).split(";", 1)[0];
    const userId = verified.json<{ user: { id: string } }>().user.id;
    await app.inject({ method: "PUT", url: "/api/v1/connections/bitget-demo", headers: { ...mutation, cookie },
      payload: { apiKey: "account-demo-key", secretKey: "account-demo-secret", passphrase: "account-pass" } });
    expect(await repository.getConnection(userId)).not.toBeNull();

    const deleted = await app.inject({ method: "DELETE", url: "/api/v1/account", headers: { ...mutation, cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, backupExpiryDays: 35 });
    expect(await repository.getUser(userId)).toBeNull();
    expect(await repository.getConnection(userId)).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });
});
