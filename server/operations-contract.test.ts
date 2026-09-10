import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { LocalDataKeyManager } from "./envelope-vault.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { createProductionApp } from "./production-app.js";

const previous = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
});

describe("production observability and deployment artifacts", () => {
  it("protects production metrics and emits hardened response headers", async () => {
    process.env.SESSIONGUARD_ALLOW_LOCAL_INFRA = "1";
    process.env.METRICS_TOKEN = "operations-metrics-token-longer-than-32-characters";
    const app = await createProductionApp({
      production: true,
      staticRoot: new URL("../public", import.meta.url).pathname,
      appOrigin: "http://localhost",
      logger: false,
      repository: new SqlitePlatformRepository(),
      coordinator: new MemoryCoordinator(),
      keyManager: new LocalDataKeyManager("operations-local-kms-key-longer-than-32-characters"),
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/v1/metrics" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/v1/metrics", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
      const metrics = await app.inject({ method: "GET", url: "/api/v1/metrics",
        headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}` } });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.body).toContain("sessionguard_http_requests_total");

      const live = await app.inject({ method: "GET", url: "/api/v1/health/live" });
      expect(live.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(live.headers["strict-transport-security"]).toContain("max-age=31536000");
    } finally { await app.close(); }
  });

  it("keeps Fly, Docker, alert, and dashboard telemetry wiring reviewable", () => {
    const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const fly = readFileSync(new URL("../fly.toml", import.meta.url), "utf8");
    const rules = readFileSync(new URL("../ops/prometheus-rules.yml", import.meta.url), "utf8");
    const dashboard = JSON.parse(readFileSync(new URL("../ops/grafana-dashboard.json", import.meta.url), "utf8")) as {
      uid: string; panels: Array<{ title: string }>;
    };

    expect(docker).toContain("ARG VITE_SENTRY_DSN");
    expect(docker).toContain('CMD ["node", "--import", "./dist-server/server/instrumentation.js"');
    expect(fly).toContain('web = "node --import ./dist-server/server/instrumentation.js');
    expect(fly).toContain('worker = "node --import ./dist-server/server/instrumentation.js');
    expect(fly).toContain('min_machines_running = 2');
    expect(rules).toContain("SessionGuardDuplicateOrderAttempt");
    expect(rules).toContain("SessionGuardWorkerStale");
    expect(dashboard.uid).toBe("sessionguard-production");
    expect(dashboard.panels).toHaveLength(9);
    expect(dashboard.panels.map((panel) => panel.title)).toContain("Bitget provider freshness · 1=fresh");
  });
});
