import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeSDK } from "@opentelemetry/sdk-node";

function traceUrl() {
  if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, "");
  return base ? `${base}/v1/traces` : null;
}

function headers() {
  return Object.fromEntries((process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",").flatMap((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) return [];
    return [[decodeURIComponent(entry.slice(0, separator).trim()), decodeURIComponent(entry.slice(separator + 1).trim())]];
  }));
}

const endpoint = traceUrl();
const telemetrySdk = endpoint ? new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "sessionguard",
  traceExporter: new OTLPTraceExporter({ url: endpoint, headers: headers() }),
}) : null;

telemetrySdk?.start();

export async function shutdownTelemetry() {
  await telemetrySdk?.shutdown();
}
