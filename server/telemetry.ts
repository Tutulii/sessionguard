import * as Sentry from "@sentry/node";
import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export class SessionGuardTelemetry {
  readonly registry = new Registry();
  readonly tracer = trace.getTracer("sessionguard", "1.0.0");
  readonly requests = new Counter({ name: "sessionguard_http_requests_total", help: "HTTP requests", labelNames: ["method", "route", "status"], registers: [this.registry] });
  readonly duration = new Histogram({ name: "sessionguard_http_duration_seconds", help: "HTTP response duration", labelNames: ["method", "route"],
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5], registers: [this.registry] });
  readonly providerFresh = new Gauge({ name: "sessionguard_provider_fresh", help: "Provider freshness state", labelNames: ["provider", "symbol"], registers: [this.registry] });
  readonly notificationLatency = new Histogram({ name: "sessionguard_notification_delivery_seconds", help: "Notification enqueue-to-delivery latency",
    buckets: [1, 5, 15, 30, 60, 120, 300], registers: [this.registry] });
  readonly duplicateOrders = new Counter({ name: "sessionguard_duplicate_order_reservations_total", help: "Duplicate order reservation attempts", registers: [this.registry] });
  readonly workerLastSuccess = new Gauge({ name: "sessionguard_worker_last_success_unixtime", help: "Unix timestamp of the last completed worker tick", registers: [this.registry] });
  readonly agentTriggers = new Counter({ name: "sessionguard_agent_triggers_total", help: "Agent triggers created", labelNames: ["type", "source_mode"], registers: [this.registry] });
  readonly agentRuns = new Counter({ name: "sessionguard_agent_runs_total", help: "Agent runs by terminal state", labelNames: ["state", "reason"], registers: [this.registry] });
  readonly agentTransitions = new Counter({ name: "sessionguard_agent_transitions_total", help: "Agent run state transitions", labelNames: ["from", "to"], registers: [this.registry] });
  readonly agentQueueAge = new Gauge({ name: "sessionguard_agent_oldest_runnable_job_age_seconds", help: "Oldest runnable durable agent job age", registers: [this.registry] });
  readonly agentRunDuration = new Histogram({ name: "sessionguard_agent_run_duration_seconds", help: "Agent trigger to terminal decision duration", labelNames: ["state"], buckets: [1, 5, 15, 30, 60, 300], registers: [this.registry] });
  readonly qwenLatency = new Histogram({ name: "sessionguard_agent_qwen_latency_seconds", help: "Qwen assessment latency", labelNames: ["model"], buckets: [1, 5, 10, 15, 30], registers: [this.registry] });
  readonly qwenTokens = new Counter({ name: "sessionguard_agent_qwen_tokens_total", help: "Qwen token usage", labelNames: ["direction"], registers: [this.registry] });
  readonly qwenFailures = new Counter({ name: "sessionguard_agent_qwen_failures_total", help: "Qwen failures by bounded reason", labelNames: ["reason"], registers: [this.registry] });
  readonly agentPermissions = new Counter({ name: "sessionguard_agent_permissions_total", help: "Deterministic agent permissions", labelNames: ["permission", "action"], registers: [this.registry] });
  readonly agentDedupe = new Counter({ name: "sessionguard_agent_dedupe_suppressed_total", help: "Suppressed duplicate agent triggers/runs", registers: [this.registry] });
  readonly agentEligibility = new Gauge({ name: "sessionguard_agent_shadow_eligibility", help: "Users eligible for PAPER_AUTO", registers: [this.registry] });
  readonly agentGrants = new Counter({ name: "sessionguard_agent_grants_total", help: "Grant lifecycle events", labelNames: ["event"], registers: [this.registry] });
  readonly agentCapabilities = new Counter({ name: "sessionguard_agent_capabilities_total", help: "Agent capability issue/consume/reject", labelNames: ["event"], registers: [this.registry] });
  readonly agentOrders = new Counter({ name: "sessionguard_agent_orders_total", help: "Automatic Demo submissions and reconciliation", labelNames: ["event", "status"], registers: [this.registry] });
  readonly agentOutcomes = new Counter({ name: "sessionguard_agent_outcomes_total", help: "Agent outcome coverage and labels", labelNames: ["status"], registers: [this.registry] });
  readonly agentKillSwitch = new Gauge({ name: "sessionguard_agent_kill_switch", help: "Agent kill switch state", labelNames: ["scope"], registers: [this.registry] });
  readonly officialSourceDelay = new Histogram({ name: "sessionguard_agent_official_source_detection_delay_seconds", help: "Official publication to detection delay", labelNames: ["source"], buckets: [1, 10, 60, 300, 900, 3600], registers: [this.registry] });
  readonly officialSourcePolls = new Counter({ name: "sessionguard_agent_official_source_polls_total", help: "Official source polls", labelNames: ["source", "result"], registers: [this.registry] });
  readonly agentNotifications = new Counter({ name: "sessionguard_agent_notifications_total", help: "Agent notification outcomes", labelNames: ["result"], registers: [this.registry] });

  constructor(sentryDsn?: string, environment = process.env.NODE_ENV ?? "development") {
    collectDefaultMetrics({ register: this.registry, prefix: "sessionguard_" });
    if (sentryDsn) Sentry.init({ dsn: sentryDsn, environment, tracesSampleRate: 0.1, sendDefaultPii: false });
  }

  capture(error: unknown, context?: Record<string, unknown>) {
    if (process.env.SENTRY_DSN) Sentry.captureException(error, context ? { extra: context } : undefined);
  }

  async withSpan<T>(name: string, attributes: Attributes, work: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await work();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally { span.end(); }
    });
  }

  metrics() { return this.registry.metrics(); }
  contentType() { return this.registry.contentType; }
}
