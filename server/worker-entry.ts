import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createProductionWorker } from "./production-worker.js";
import { shutdownTelemetry } from "./instrumentation.js";

function authorized(value: string | undefined, expected: string | undefined) {
  if (!value || !expected) return false;
  const token = value.replace(/^Bearer\s+/i, "");
  const left = Buffer.from(token); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const worker = await createProductionWorker();
const server = createServer(async (request, response) => {
  if (request.url === "/internal/health") {
    const health = await worker.health();
    response.writeHead(health.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(health));
    return;
  }
  if (request.url === "/internal/metrics") {
    if (!authorized(request.headers.authorization, process.env.METRICS_TOKEN)) {
      response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "METRICS_AUTH_REQUIRED" }));
      return;
    }
    response.writeHead(200, { "content-type": worker.metricsContentType(), "cache-control": "no-store" });
    response.end(await worker.metrics());
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "NOT_FOUND" }));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(Number(process.env.WORKER_METRICS_PORT ?? 9091), process.env.HOST ?? "0.0.0.0", resolve);
});

const stop = async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await worker.stop();
  await shutdownTelemetry();
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
await worker.run();
