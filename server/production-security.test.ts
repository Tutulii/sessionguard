import { Wallet } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { createSessionRecord } from "./coordinator-contract.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { validateProductionEnvironment } from "./production-config.js";
import { SiweAuthService } from "./siwe-auth.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
});

describe("production security gates", () => {
  it("rejects SIWE domain, chain, expiry, and session-lifetime attacks", async () => {
    const repository = new SqlitePlatformRepository(); const coordinator = new MemoryCoordinator(); await repository.init();
    const auth = new SiweAuthService(repository, coordinator, "https://sessionguard.test");
    const wallet = Wallet.createRandom();

    const domain = await auth.createChallenge(wallet.address);
    const tamperedDomain = domain.message.replaceAll("sessionguard.test", "attacker.invalid");
    await expect(auth.verify(tamperedDomain, await wallet.signMessage(tamperedDomain))).rejects.toThrow("SIWE_MESSAGE_MISMATCH");

    const chain = await auth.createChallenge(wallet.address);
    const tamperedChain = chain.message.replace("Chain ID: 42161", "Chain ID: 1");
    await expect(auth.verify(tamperedChain, await wallet.signMessage(tamperedChain))).rejects.toThrow("SIWE_MESSAGE_MISMATCH");

    const expiredAt = new Date(Date.now() - 11 * 60_000);
    const expired = await auth.createChallenge(wallet.address, expiredAt);
    await expect(auth.verify(expired.message, await wallet.signMessage(expired.message))).rejects.toThrow("SIWE_CHALLENGE_EXPIRED");

    const user = await repository.createOrLoginUser(wallet.address, 500);
    const idle = createSessionRecord(user);
    idle.lastSeenAt = new Date(Date.now() - 12 * 60 * 60_000 - 1).toISOString();
    await coordinator.saveSession(idle);
    expect(await auth.authenticate(idle.id)).toBeNull();
    const absolute = createSessionRecord(user, new Date(Date.now() - 7 * 86_400_000 - 1));
    absolute.lastSeenAt = new Date().toISOString();
    await coordinator.saveSession(absolute);
    expect(await auth.authenticate(absolute.id)).toBeNull();
    expect(auth.isFresh({ ...createSessionRecord(user), lastVerifiedAt: new Date(Date.now() - 5 * 60_000 - 1).toISOString() })).toBe(false);
    await repository.close();
  });

  it("fails startup closed unless every production dependency and strong secret is configured", () => {
    const keys = ["APP_ORIGIN", "DATABASE_URL", "REDIS_URL", "KMS_KEY_ID", "DECISION_SIGNING_KEY", "ADMIN_TOKEN", "METRICS_TOKEN",
      "RESEND_API_KEY", "EMAIL_FROM", "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_NAME", "TELEGRAM_WEBHOOK_SECRET", "VAPID_SUBJECT",
      "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "SENTRY_DSN", "OTEL_EXPORTER_OTLP_ENDPOINT"];
    for (const key of keys) delete process.env[key];
    expect(() => validateProductionEnvironment(true, false)).toThrow("Missing required production configuration");
    Object.assign(process.env, {
      APP_ORIGIN: "http://sessionguard.test", DATABASE_URL: "postgres://private/test", REDIS_URL: "rediss://private",
      KMS_KEY_ID: "kms-key", DECISION_SIGNING_KEY: "d".repeat(32), ADMIN_TOKEN: "a".repeat(32), METRICS_TOKEN: "m".repeat(32),
      RESEND_API_KEY: "resend", EMAIL_FROM: "alerts@sessionguard.test", TELEGRAM_BOT_TOKEN: "telegram",
      TELEGRAM_BOT_NAME: "SessionGuardBot", TELEGRAM_WEBHOOK_SECRET: "t".repeat(32), VAPID_SUBJECT: "mailto:security@sessionguard.test",
      VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_KEY: "private",
      SENTRY_DSN: "https://public@sentry.example/1", OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
    });
    expect(() => validateProductionEnvironment(true, false)).toThrow("APP_ORIGIN must use HTTPS");
    process.env.APP_ORIGIN = "https://sessionguard.test";
    expect(() => validateProductionEnvironment(true, false)).not.toThrow();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel.example";
    expect(() => validateProductionEnvironment(true, false)).toThrow("OTEL_EXPORTER_OTLP_ENDPOINT must use HTTPS");
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example";
    process.env.METRICS_TOKEN = process.env.ADMIN_TOKEN;
    expect(() => validateProductionEnvironment(true, false)).toThrow("must be independent");
  });

  it("permits the explicit hackathon profile without weakening database, Redis, or independent-secret gates", () => {
    for (const key of ["KMS_KEY_ID", "RESEND_API_KEY", "EMAIL_FROM", "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_NAME",
      "VAPID_SUBJECT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "SENTRY_DSN", "OTEL_EXPORTER_OTLP_ENDPOINT"]) {
      delete process.env[key];
    }
    Object.assign(process.env, {
      SESSIONGUARD_DEPLOYMENT_PROFILE: "HACKATHON",
      AGENT_RUNTIME_ENABLED: "0",
      APP_ORIGIN: "https://sessionguard.test",
      DATABASE_URL: "postgres://private/test",
      REDIS_URL: "rediss://private",
      LOCAL_KMS_MASTER_KEY: "k".repeat(32),
      DECISION_SIGNING_KEY: "d".repeat(32),
      ADMIN_TOKEN: "a".repeat(32),
      METRICS_TOKEN: "m".repeat(32),
      TELEGRAM_WEBHOOK_SECRET: "t".repeat(32),
    });
    expect(() => validateProductionEnvironment(true, false)).not.toThrow();
    delete process.env.LOCAL_KMS_MASTER_KEY;
    expect(() => validateProductionEnvironment(true, false)).toThrow("LOCAL_KMS_MASTER_KEY");
  });
});
