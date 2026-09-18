import { createHash, randomUUID } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import {
  AgentJobV1Schema,
  AgentOutcomeV1Schema,
  AgentRunTransitionV1Schema,
  AgentRunV1Schema,
  AgentSettingsV1Schema,
  AgentTriggerV1Schema,
  agentPolicy,
  defaultAgentSettings,
  terminalAgentRunStates,
  type AgentAssessmentV1,
  type AgentJobV1,
  type AgentMode,
  type AgentOutcomeV1,
  type AgentRunState,
  type AgentRunV1,
  type AgentSettingsV1,
  type AgentTriggerType,
  type OfficialEventV1,
} from "../shared/agent-types.js";
import type { ProductionSymbol } from "../shared/production-types.js";
import { replayScenarios } from "../shared/replays.js";
import { assembleAgentContext } from "./agent-context.js";
import { agentEligibility, type AgentGrantService } from "./agent-grant.js";
import type { AgentRepository, CollateralRiskState } from "./agent-repository.js";
import type { Coordinator } from "./coordinator.js";
import type { NotificationService } from "./notifications.js";
import type { PlatformRepository } from "./platform-repository.js";
import { ProductionOfficialEventWatcher, deterministicUuid, evidenceSegments, normalizeOfficialDocument } from "./production-events.js";
import type { ProductionMarketService } from "./production-market.js";
import { productionHash } from "./production-rules.js";
import type { ProductionTradingService } from "./production-trading.js";
import type { SessionGuardTelemetry } from "./telemetry.js";
import { ProductionQwenAnalyst, recordedReplayAssessment } from "./production-qwen.js";
import { cashCloseForDate, NEW_YORK_TZ } from "./session-engine.js";

function sha(value: string) { return createHash("sha256").update(value).digest("hex"); }
function utcDay(at: Date) { return at.toISOString().slice(0, 10); }
function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "AGENT_RUNTIME_FAILED";
  if (/aborted due to timeout|timed? ?out/i.test(message)) return "QWEN_TIMEOUT";
  const known = message.match(/^(MODEL_OUTPUT_INVALID|QWEN_HTTP_\d{3}|QWEN_TRANSPORT_FAILED|QWEN_EMPTY_RESPONSE|AGENT_[A-Z0-9_]+|ORDER_[A-Z0-9_]+|OUTCOME_[A-Z0-9_]+)/)?.[1];
  return known ?? (message.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 128) || "AGENT_RUNTIME_FAILED");
}
function pendingReceipt(status: string | undefined) { return ["RESERVED", "SUBMITTING", "RECONCILING"].includes(status ?? ""); }
function observationSources(outcome: AgentOutcomeV1): NonNullable<AgentOutcomeV1["observationSources"]> {
  return outcome.observationSources ?? { nextOpen: null, plus60m: null, cashClose: null };
}

export type AgentOrchestratorOptions = {
  runtimeEnabled: boolean;
  repository: AgentRepository;
  platformRepository: PlatformRepository;
  coordinator: Coordinator;
  market: ProductionMarketService;
  trading: ProductionTradingService;
  notifications: NotificationService;
  grantService: AgentGrantService;
  watcher: ProductionOfficialEventWatcher;
  qwen: ProductionQwenAnalyst | null;
  workerId?: string;
  now?: () => Date;
  telemetry?: SessionGuardTelemetry;
  replayOutcomeDelayMs?: number;
};

export class AgentOrchestrator {
  readonly workerId: string;
  private readonly now: () => Date;

  constructor(private readonly options: AgentOrchestratorOptions) {
    this.workerId = options.workerId ?? `agent-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.now = options.now ?? (() => new Date());
  }

  async settings(userId: string) { return await this.options.repository.getSettings(userId) ?? defaultAgentSettings(userId, this.now()); }

  async updateSettings(userId: string, update: Omit<AgentSettingsV1, "version" | "userId" | "policyVersion" | "settingsVersion" | "shadowStartedAt" | "eligibilityResetAt" | "createdAt" | "updatedAt">) {
    const now = this.now(); const previous = await this.settings(userId);
    if (update.mode === "PAPER_AUTO") throw new Error("PAPER_AUTO_REQUIRES_GRANT_VERIFICATION");
    if (previous.mode === "DISABLED" && update.mode !== "DISABLED" && update.mode !== "SHADOW") throw new Error("AGENT_FIRST_MODE_MUST_BE_SHADOW");
    if (previous.mode === "PAPER_AUTO") {
      const revoked = await this.options.repository.revokeCurrentGrant(userId, "MODE_LOWERED", now);
      if (revoked) await this.options.platformRepository.saveAudit(userId, "AGENT_GRANT_REVOKED", revoked.id, { reason: "MODE_LOWERED" });
    }
    const newlyEnabled = previous.mode === "DISABLED" && update.mode !== "DISABLED";
    const disabled = update.mode === "DISABLED";
    const next = AgentSettingsV1Schema.parse({ ...previous, ...update, userId, mode: update.mode,
      shadowStartedAt: newlyEnabled ? now.toISOString() : disabled ? null : previous.shadowStartedAt,
      eligibilityResetAt: disabled ? now.toISOString() : previous.eligibilityResetAt,
      settingsVersion: productionHash({ previous: previous.settingsVersion, update, at: now.toISOString() }).slice(0, 24),
      policyVersion: agentPolicy.version, updatedAt: now.toISOString() });
    await this.options.repository.saveSettings(next);
    await this.options.platformRepository.saveAudit(userId, "AGENT_SETTINGS_UPDATED", next.settingsVersion,
      { previousMode: previous.mode, mode: next.mode, symbols: next.symbols, shadowStartedAt: next.shadowStartedAt });
    await this.options.coordinator.publish(`agent:${userId}`, { type: "SETTINGS", settings: next });
    return next;
  }

  async status(userId: string) {
    const now = this.now(); const settings = await this.settings(userId);
    const [heartbeat, queue, connection, grant, eligibility, kills, marketStatus] = await Promise.all([
      this.options.repository.latestWorkerHeartbeat(), this.options.repository.queueStats(now),
      this.options.trading.connectionStatus(userId), this.options.repository.getCurrentGrant(userId),
      agentEligibility(this.options.repository, settings, now), this.killSwitches(userId),
      this.options.market.snapshot(settings.symbols[0], { mode: "LIVE_BITGET", now }).then((snapshot) => snapshot.session).catch(() => "MARKET_UNAVAILABLE" as const),
    ]);
    const remaining = grant ? new Date(grant.expiresAt).getTime() - now.getTime() : Infinity;
    const warning = !grant ? "NONE" as const : remaining <= 0 ? "EXPIRED" as const : remaining <= 60 * 60_000 ? "ONE_HOUR" as const
      : remaining <= 24 * 60 * 60_000 ? "24_HOURS" as const : "NONE" as const;
    const sharedHealth = await this.options.coordinator.cacheGet<{ qwen?: { status?: "HEALTHY" | "DEGRADED" | "DISABLED" }; source?: { status?: "HEALTHY" | "DEGRADED" } }>("agent:runtime-health");
    const qwen = sharedHealth?.qwen ?? this.options.qwen?.health();
    const source = sharedHealth?.source ?? this.options.watcher.health();
    const symbolKills = Object.fromEntries(await Promise.all(settings.symbols.map(async (symbol) =>
      [symbol, Boolean(await this.options.coordinator.cacheGet<boolean>(`kill:symbol:${symbol}`))] as const)));
    this.options.telemetry?.agentEligibility.set(eligibility.eligible ? 1 : 0);
    return {
      runtimeEnabled: this.options.runtimeEnabled, mode: settings.mode, settings,
      workerHeartbeatAt: heartbeat, workerHealthy: Boolean(heartbeat && now.getTime() - new Date(heartbeat).getTime() < 30_000),
      qwenHealth: !this.options.runtimeEnabled || !this.options.qwen ? "DISABLED" as const : qwen?.status ?? "DEGRADED" as const,
      bitgetHealth: marketStatus === "MARKET_UNAVAILABLE" ? "DEGRADED" as const : "HEALTHY" as const,
      sourceHealth: source.status, cashSession: marketStatus, queue, demo: connection,
      grant: { active: Boolean(grant && !grant.revokedAt && remaining > 0), expiresAt: grant?.expiresAt ?? null, warning },
      eligibility, killSwitches: { ...kills, symbols: symbolKills },
    };
  }

  async enqueueOfficialEvent(event: OfficialEventV1) {
    const results: AgentRunV1[] = [];
    for (const settings of await this.options.repository.listEnabledSettings()) {
      if (!settings.symbols.includes(event.symbol)) continue;
      results.push((await this.createRun({ settings, type: "OFFICIAL_EVENT", symbol: event.symbol, event,
        sourceMode: "LIVE_BITGET", analystOrigin: "QWEN", facts: { source: event.sourceType, contentHash: event.contentHash },
        dedupeSeed: event.contentHash, dedupeScope: "EVENT" })).run);
    }
    return results;
  }

  async pollOfficialEvents() {
    if (!this.options.runtimeEnabled) return [];
    const release = await this.options.coordinator.acquireLock("agent:official-source-poll", 110_000); if (!release) return [];
    try {
      const events = await this.options.watcher.poll();
      this.options.telemetry?.officialSourcePolls.inc({ source: "official", result: "success" });
      for (const event of events) {
        this.options.telemetry?.officialSourceDelay.observe({ source: event.sourceType }, Math.max(0, (new Date(event.detectedAt).getTime() - new Date(event.publishedAt).getTime()) / 1000));
        await this.enqueueOfficialEvent(event);
      }
      return events;
    } catch (error) {
      this.options.telemetry?.officialSourcePolls.inc({ source: "official", result: "error" });
      throw error;
    } finally { await release(); }
  }

  async scanDeterministicTriggers(now = this.now()) {
    if (!this.options.runtimeEnabled) return 0;
    let created = 0;
    for (const settings of await this.options.repository.listEnabledSettings()) {
      const portfolio = await this.options.platformRepository.getPortfolio(settings.userId).catch(() => null);
      if (portfolio && await this.scanCollateralRisk(settings, portfolio.collateralBufferPct, now)) created += 1;
      for (const symbol of settings.symbols) {
        try {
          const snapshot = await this.options.market.snapshot(symbol, { mode: "LIVE_BITGET", now });
          const priorKey = `agent:last-session:${settings.userId}:${symbol}`; const prior = await this.options.coordinator.cacheGet<string>(priorKey);
          if (prior && prior !== snapshot.session) {
            const result = await this.createRun({ settings, type: "SESSION_CHANGE", symbol, event: null,
              sourceMode: "LIVE_BITGET", analystOrigin: "QWEN", facts: { from: prior, to: snapshot.session },
              dedupeSeed: `${prior}:${snapshot.session}:${utcDay(now)}`, now });
            if (result.created) created += 1;
          }
          await this.options.coordinator.cacheSet(priorKey, snapshot.session, 7 * 86_400);
          const armKey = `agent:off-hours-armed:${settings.userId}:${symbol}`;
          const armed = (await this.options.coordinator.cacheGet<boolean>(armKey)) ?? true;
          const move = Math.abs(snapshot.offHoursMoveBps ?? 0);
          if (snapshot.session !== "CASH_OPEN" && armed && move >= settings.offHoursMoveThresholdBps) {
            const result = await this.createRun({ settings, type: "OFF_HOURS_MOVE", symbol, event: null,
              sourceMode: "LIVE_BITGET", analystOrigin: "QWEN", facts: { moveBps: snapshot.offHoursMoveBps ?? 0,
                thresholdBps: settings.offHoursMoveThresholdBps, session: snapshot.session },
              dedupeSeed: `${snapshot.session}:${snapshot.referenceTimestamp ?? utcDay(now)}`, now });
            if (result.created) created += 1;
            await this.options.coordinator.cacheSet(armKey, false, 7 * 86_400);
          } else if (!armed && move < settings.offHoursMoveThresholdBps * 0.75) {
            await this.options.coordinator.cacheSet(armKey, true, 7 * 86_400);
          }
          const etDay = formatInTimeZone(now, NEW_YORK_TZ, "i"); const etTime = formatInTimeZone(now, NEW_YORK_TZ, "HH:mm");
          if (etDay === "5" && etTime >= "15:45" && snapshot.session === "CASH_OPEN") {
            const result = await this.createRun({ settings, type: "PRE_WEEKEND_SWEEP", symbol, event: null,
              sourceMode: "LIVE_BITGET", analystOrigin: "QWEN", facts: { scheduled: "15:45 America/New_York" },
              dedupeSeed: formatInTimeZone(now, NEW_YORK_TZ, "yyyy-MM-dd"), now });
            if (result.created) created += 1;
          }
        } catch { /* independent symbol failure remains fail-closed and is surfaced by health metrics */ }
      }
    }
    return created;
  }

  private async collateralState(settings: AgentSettingsV1, now: Date): Promise<CollateralRiskState> {
    const stored = await this.options.repository.getCollateralRiskState(settings.userId);
    if (stored) {
      if (stored.settingsVersion === settings.settingsVersion) return stored;
      const carried = { ...stored, settingsVersion: settings.settingsVersion, updatedAt: now.toISOString() };
      await this.options.repository.saveCollateralRiskState(carried);
      return carried;
    }
    {
      const since = new Date(now.getTime() - 365 * 86_400_000).toISOString();
      const recent = (await this.options.repository.listRuns(settings.userId, 10_000)).items
        .filter((run) => run.createdAt >= since);
      let legacy: { band: number; dedupeKey: string } | null = null;
      for (const run of recent) {
        const trigger = await this.options.repository.getTrigger(settings.userId, run.triggerId);
        const value = trigger?.facts.collateralBandPct;
        if (trigger?.type === "COLLATERAL_RISK" && typeof value === "number" && Number.isFinite(value) &&
          value >= 0 && value <= 100 && (!legacy || value < legacy.band)) {
          legacy = { band: value, dedupeKey: trigger.dedupeKey };
        }
      }
      if (legacy) {
        const migrated: CollateralRiskState = { userId: settings.userId, settingsVersion: settings.settingsVersion,
          phase: "ACTIVE", episodeKey: sha(`legacy:${legacy.dedupeKey}`), lastBandPct: legacy.band, updatedAt: now.toISOString() };
        await this.options.repository.saveCollateralRiskState(migrated);
        return migrated;
      }
    }
    const armed: CollateralRiskState = { userId: settings.userId, settingsVersion: settings.settingsVersion,
      phase: "ARMED", episodeKey: sha(`initial:${settings.userId}:${settings.settingsVersion}`),
      lastBandPct: null, updatedAt: now.toISOString() };
    await this.options.repository.saveCollateralRiskState(armed);
    return armed;
  }

  private async scanCollateralRisk(settings: AgentSettingsV1, bufferPct: number, now: Date) {
    const release = await this.options.coordinator.acquireLock(`agent:collateral-risk:${settings.userId}`, 10_000);
    if (!release) return false;
    try {
      const triggerAtPct = Math.min(100, Math.max(settings.minCollateralBufferPct, 15) + 5);
      const rearmAbovePct = Math.min(100, triggerAtPct + 5);
      let state = await this.collateralState(settings, now);
      if (bufferPct > rearmAbovePct) {
        if (state.phase === "ACTIVE") {
          state = { ...state, phase: "ARMED", episodeKey: randomUUID(), lastBandPct: null, updatedAt: now.toISOString() };
          await this.options.repository.saveCollateralRiskState(state);
        }
        return false;
      }
      if (bufferPct > triggerAtPct) return false;

      const band = Math.floor(Math.max(0, bufferPct) / 2) * 2;
      const worsened = state.phase === "ACTIVE" && state.lastBandPct !== null && band < state.lastBandPct;
      if (state.phase === "ACTIVE" && !worsened) {
        this.options.telemetry?.agentDedupe.inc();
        return false;
      }
      const result = await this.createRun({ settings, type: "COLLATERAL_RISK", symbol: settings.symbols[0], event: null,
        sourceMode: "LIVE_BITGET", analystOrigin: "QWEN",
        facts: { collateralBandPct: band, triggerAtPct, rearmAbovePct, riskEpisode: state.episodeKey },
        dedupeSeed: `episode:${state.episodeKey}:band:${band}`, now });
      await this.options.repository.saveCollateralRiskState({ ...state, phase: "ACTIVE",
        lastBandPct: state.lastBandPct === null ? band : Math.min(state.lastBandPct, band), updatedAt: now.toISOString() });
      return result.created;
    } finally { await release(); }
  }

  async manualShadow(userId: string, symbol: ProductionSymbol, type: Exclude<AgentTriggerType, "OFFICIAL_EVENT" | "MANUAL_SHADOW" | "OUTCOME_DUE">) {
    const stored = await this.settings(userId); const settings = AgentSettingsV1Schema.parse({ ...stored, mode: "SHADOW" });
    return (await this.createRun({ settings, type: "MANUAL_SHADOW", symbol, event: null, sourceMode: "LIVE_BITGET",
      analystOrigin: "QWEN", facts: { requestedTrigger: type }, dedupeSeed: randomUUID() })).run;
  }

  async replay(userId: string, replayId: string, analystOrigin: "RECORDED" | "QWEN") {
    const scenario = replayScenarios.find((item) => item.id === replayId); if (!scenario) throw new Error("REPLAY_NOT_FOUND");
    const stored = await this.settings(userId); const settings = AgentSettingsV1Schema.parse({ ...stored, mode: "SHADOW" });
    const event = this.replayEvent(replayId);
    const since = new Date(this.now().getTime() - 365 * 86_400_000).toISOString();
    const recent = await this.options.repository.listRecentRuns(userId, scenario.snapshot.symbol, since, 10_000);
    for (const previous of recent) {
      if (previous.sourceMode !== "LOCAL_REPLAY") continue;
      const trigger = previous.context?.trigger ?? await this.options.repository.getTrigger(userId, previous.triggerId);
      const previousHash = previous.context?.event?.contentHash ??
        (typeof trigger?.facts.contentHash === "string" ? trigger.facts.contentHash : null);
      // A recorded fixture and a live-Qwen assessment are deliberately different
      // demo paths. Each one gets one durable run for a given fixture version;
      // clicking that same analyst again remains an exact duplicate.
      if (trigger?.replayId === replayId && previous.analystOrigin === analystOrigin && previous.state !== "FAILED_CLOSED" &&
        (!previousHash || previousHash === event.contentHash)) {
        this.options.telemetry?.agentDedupe.inc();
        return { ...previous, dedupeStatus: "SKIPPED_DUPLICATE" as const };
      }
    }
    const result = await this.createRun({ settings, type: "OFFICIAL_EVENT", symbol: scenario.snapshot.symbol, event,
      sourceMode: "LOCAL_REPLAY", analystOrigin, facts: { replayId, contentHash: event.contentHash,
        source: "RECORDED_OFFICIAL_FIXTURE", simulation: true },
      dedupeSeed: `replay:v2:${analystOrigin}:${event.accessionId}:${event.contentHash}`, dedupeScope: "EVENT", replayId });
    return { ...result.run, dedupeStatus: result.created ? "QUEUED" as const : "SKIPPED_DUPLICATE" as const };
  }

  async runOne(now = this.now()) {
    await this.options.repository.heartbeatWorker(this.workerId, now, { runtimeEnabled: this.options.runtimeEnabled });
    if (!this.options.runtimeEnabled) return false;
    const job = await this.options.repository.claimJob(this.workerId, now, agentPolicy.jobLeaseMs); if (!job) return false;
    const heartbeat = setInterval(() => void this.options.repository.heartbeatJob(job.id, this.workerId, this.now(), agentPolicy.jobLeaseMs), agentPolicy.jobHeartbeatMs);
    heartbeat.unref();
    try {
      if (job.kind === "PROCESS_RUN") await this.processRun(job);
      else if (job.kind.startsWith("OUTCOME_")) await this.processOutcome(job);
      else await this.options.grantService.maintain(now);
      await this.options.repository.completeJob(job.id, this.workerId, this.now());
    } catch (error) { await this.handleJobFailure(job, error); }
    finally { clearInterval(heartbeat); }
    return true;
  }

  async drain(limit = 100) { let count = 0; while (count < limit && await this.runOne()) count += 1; return count; }

  private async createRun(input: { settings: AgentSettingsV1; type: AgentTriggerType; symbol: ProductionSymbol;
    event: OfficialEventV1 | null; sourceMode: "LIVE_BITGET" | "LOCAL_REPLAY"; analystOrigin: "QWEN" | "RECORDED";
    facts: Record<string, string | number | boolean | null>; dedupeSeed: string; dedupeScope?: "POLICY" | "EVENT"; replayId?: string; now?: Date;
  }) {
    const now = input.now ?? this.now(); const at = now.toISOString();
    const policyScope = input.dedupeScope === "EVENT" ? "" : `:${input.settings.policyVersion}`;
    const dedupeKey = sha(`${input.settings.userId}:${input.type}:${input.symbol}:${input.dedupeSeed}${policyScope}`);
    const triggerId = deterministicUuid(`agent-trigger:${dedupeKey}`);
    const runId = deterministicUuid(`agent-run:${dedupeKey}`);
    const traceId = deterministicUuid(`agent-trace:${dedupeKey}`);
    const trigger = AgentTriggerV1Schema.parse({ version: 1, id: triggerId, userId: input.settings.userId,
      type: input.type, symbol: input.symbol, eventId: input.sourceMode === "LIVE_BITGET" ? input.event?.id ?? null : null,
      sourceMode: input.sourceMode, replayId: input.replayId ?? null, dedupeKey, facts: input.facts, createdAt: at });
    const modeAtStart: AgentMode = input.sourceMode === "LOCAL_REPLAY" || input.type === "MANUAL_SHADOW" ? "SHADOW" : input.settings.mode;
    const run = AgentRunV1Schema.parse({ version: 1, id: runId, traceId, userId: input.settings.userId, triggerId,
      eventId: trigger.eventId, symbol: input.symbol, sourceMode: input.sourceMode, analystOrigin: input.analystOrigin,
      modeAtStart, policyVersion: input.settings.policyVersion, settingsVersion: input.settings.settingsVersion,
      state: "QUEUED", qualifyingShadowRun: false, context: null, assessment: null, modelMetadata: null,
      authorization: null, receipt: null, failureCode: null, createdAt: at, updatedAt: at, terminalAt: null });
    const job = AgentJobV1Schema.parse({ id: randomUUID(), runId, userId: run.userId, kind: "PROCESS_RUN", status: "QUEUED",
      runAt: at, attemptCount: 0, workerId: null, leaseExpiresAt: null, lastErrorCode: null, createdAt: at, updatedAt: at });
    const transition = AgentRunTransitionV1Schema.parse({ version: 1, id: randomUUID(), runId, userId: run.userId, traceId,
      fromState: null, toState: "QUEUED", reasonCode: "TRIGGER_ACCEPTED", metadata: { triggerType: input.type }, createdAt: at });
    const result = await this.options.repository.createRunBundle(trigger, run, job, transition);
    if (result.created) {
      this.options.telemetry?.agentTriggers.inc({ type: input.type, source_mode: input.sourceMode });
      await this.options.platformRepository.saveAudit(run.userId, "AGENT_RUN_QUEUED", run.id,
        { traceId, triggerType: input.type, sourceMode: input.sourceMode, analystOrigin: input.analystOrigin });
      await this.options.coordinator.publish(`agent:${run.userId}`, { type: "RUN_TRANSITION", runId, traceId, state: "QUEUED" });
    } else { this.options.telemetry?.agentDedupe.inc(); }
    return result;
  }

  private async processRun(job: AgentJobV1) {
    let capability: { token: string; expiresAt: string } | null = null;
    for (let steps = 0; steps < 16; steps += 1) {
      const run = await this.options.repository.getRun(job.userId, job.runId); if (!run) throw new Error("AGENT_RUN_NOT_FOUND");
      if (terminalAgentRunStates.has(run.state) || run.state === "OUTCOME_PENDING") return;
      if (run.state === "QUEUED") { await this.transition(run, "CONTEXT_BUILDING", "CONTEXT_STARTED"); continue; }
      if (run.state === "CONTEXT_BUILDING") {
        const context = await this.buildContext(run); await this.transition(run, "CONTEXT_READY", "CONTEXT_VALIDATED", { context }); continue;
      }
      if (run.state === "CONTEXT_READY") { await this.transition(run, "ASSESSING", "MODEL_ASSESSMENT_STARTED"); continue; }
      if (run.state === "ASSESSING") {
        if (!run.context) throw new Error("AGENT_CONTEXT_MISSING");
        if (run.analystOrigin === "QWEN") await this.assertAnalysisAvailable(run.userId, run.symbol);
        const model = run.analystOrigin === "RECORDED" ? { assessment: recordedReplayAssessment(run.context.trigger.replayId ?? "", run.context), metadata: {
          provider: "QWEN" as const, model: "recorded-fixture", promptVersion: agentPolicy.promptVersion, latencyMs: 0,
          inputTokens: null, outputTokens: null, contextHash: run.context.contextHash,
          rawResponseHash: sha(`recorded:${run.context.trigger.replayId}:${run.context.contextHash}`),
        } } : await this.requireQwen().assess(run.context);
        this.options.telemetry?.qwenLatency.observe({ model: model.metadata.model }, model.metadata.latencyMs / 1000);
        if (model.metadata.inputTokens != null) this.options.telemetry?.qwenTokens.inc({ direction: "input" }, model.metadata.inputTokens);
        if (model.metadata.outputTokens != null) this.options.telemetry?.qwenTokens.inc({ direction: "output" }, model.metadata.outputTokens);
        await this.transition(run, "AUTHORIZING", "MODEL_ASSESSMENT_VALID", { assessment: model.assessment, modelMetadata: model.metadata }); continue;
      }
      if (run.state === "AUTHORIZING") {
        if (!run.context || !run.assessment) throw new Error("AGENT_ASSESSMENT_MISSING");
        const settings = await this.settingsForRun(run); const event = await this.eventForRun(run);
        const evaluationTime = run.sourceMode === "LOCAL_REPLAY"
          ? new Date(run.context.market.providerTimestamp) : this.now();
        const result = await this.options.trading.evaluateAgentProposal({ userId: run.userId, runId: run.id,
          context: run.context, assessment: run.assessment, settings, event, now: evaluationTime });
        capability = result.capability;
        const qualifying = run.sourceMode === "LIVE_BITGET" && run.analystOrigin === "QWEN" &&
          run.modeAtStart !== "PAPER_AUTO" && run.context.trigger.type !== "MANUAL_SHADOW";
        const target: AgentRunState = result.authorization.permission === "BLOCK" ? "BLOCKED"
          : result.authorization.permission === "ALERT_ONLY" ? "ALERTED"
            : run.modeAtStart === "PAPER_AUTO" ? "EXECUTION_READY" : "SHADOW_COMPLETE";
        this.options.telemetry?.agentPermissions.inc({ permission: result.authorization.permission, action: run.assessment.action });
        await this.transition(run, target, result.authorization.reasonCodes[0], { authorization: result.authorization,
          qualifyingShadowRun: qualifying });
        if ((target === "BLOCKED" || target === "ALERTED") && settings.notificationsEnabled &&
          (settings.mode === "ALERT_ONLY" || settings.mode === "PAPER_AUTO")) {
          await this.notifyDecision(run.userId, run.symbol, target, result.authorization.reasons[0]);
        }
        continue;
      }
      if (["BLOCKED", "ALERTED", "SHADOW_COMPLETE", "MONITORING"].includes(run.state)) { await this.ensureOutcome(run); continue; }
      if (run.state === "EXECUTION_READY") {
        capability ??= await this.options.trading.issueStoredAgentCapability(run.userId, run.id, this.now());
        await this.transition(run, "REVALIDATING", "FRESH_REVALIDATION_STARTED"); continue;
      }
      if (run.state === "REVALIDATING") {
        capability ??= await this.options.trading.issueStoredAgentCapability(run.userId, run.id, this.now());
        try {
          const receipt = await this.options.trading.executeAgentDecision({ userId: run.userId, runId: run.id,
            decisionToken: capability.token, now: this.now() });
          const submitting = await this.transition(run, "SUBMITTING", "DEMO_SUBMISSION_RECORDED", { receipt });
          await this.transition(submitting, pendingReceipt(receipt.status) ? "RECONCILING" : "MONITORING",
            pendingReceipt(receipt.status) ? "RECONCILIATION_REQUIRED" : "DEMO_RECEIPT_CONFIRMED", { receipt });
        } catch (error) {
          const code = errorCode(error);
          if (/RECONCILIATION_PENDING|RESPONSE_UNCERTAIN/.test(code)) {
            const receipt = await this.currentReceipt(run);
            const submitting = await this.transition(run, "SUBMITTING", "DEMO_RESPONSE_UNCERTAIN", { receipt });
            await this.transition(submitting, "RECONCILING", "CLIENT_ID_RECONCILIATION_REQUIRED", { receipt });
          } else if (/REVALIDATION|CHANGED|CASH_OPEN_REQUIRED|GRANT|KILLED|LIMIT|COOLDOWN|EVENT_ALREADY/.test(code)) {
            await this.transition(run, "BLOCKED", code, { failureCode: code });
          } else throw error;
        }
        continue;
      }
      if (run.state === "SUBMITTING") {
        const receipt = await this.currentReceipt(run);
        await this.transition(run, pendingReceipt(receipt?.status) ? "RECONCILING" : "MONITORING",
          pendingReceipt(receipt?.status) ? "RECOVERED_PENDING_SUBMISSION" : "RECOVERED_CONFIRMED_SUBMISSION", { receipt }); continue;
      }
      if (run.state === "RECONCILING") {
        await this.options.trading.reconcilePendingOrders({ userId: run.userId, decisionId: run.authorization?.guardDecision?.id, now: this.now() });
        const receipt = await this.currentReceipt(run); if (!receipt || pendingReceipt(receipt.status)) throw new Error("ORDER_RECONCILIATION_PENDING");
        await this.transition(run, "MONITORING", "DEMO_ORDER_RECONCILED", { receipt }); continue;
      }
    }
    throw new Error("AGENT_STATE_LOOP_LIMIT");
  }

  private async buildContext(run: AgentRunV1) {
    const trigger = await this.options.repository.getTrigger(run.userId, run.triggerId); if (!trigger) throw new Error("AGENT_TRIGGER_NOT_FOUND");
    const settings = await this.settingsForRun(run); const event = await this.eventForRun(run);
    const mode = run.sourceMode === "LOCAL_REPLAY" ? "REPLAY" as const : "LIVE_BITGET" as const;
    const [market, portfolio, recent, pending] = await Promise.all([
      this.options.market.snapshot(run.symbol, { mode, replayId: trigger.replayId ?? undefined, now: this.now() }),
      this.options.trading.portfolio(run.userId, mode, trigger.replayId ?? undefined),
      this.options.repository.listRecentRuns(run.userId, run.symbol, new Date(this.now().getTime() - 7 * 86_400_000).toISOString(), 10),
      this.options.platformRepository.listReconciliationOrders(500),
    ]);
    const baseline = await this.options.repository.getOrCreateDailyEquityBaseline(run.userId, utcDay(this.now()),
      portfolio.accountEquityCents, portfolio.capturedAt);
    return assembleAgentContext({ trigger, event, market, portfolio, settings, recentRuns: recent,
      outstandingOrder: pending.some((receipt) => receipt.userId === run.userId && pendingReceipt(receipt.status)),
      dailyBaselineEquityCents: baseline, now: this.now() });
  }

  private async settingsForRun(run: AgentRunV1) {
    const current = await this.options.repository.getSettings(run.userId);
    if (run.sourceMode === "LOCAL_REPLAY") {
      const replaySettings = current ?? defaultAgentSettings(run.userId, new Date(run.createdAt));
      if (replaySettings.settingsVersion !== run.settingsVersion || replaySettings.policyVersion !== run.policyVersion) {
        throw new Error("AGENT_SETTINGS_CHANGED_DURING_RUN");
      }
      return AgentSettingsV1Schema.parse({ ...replaySettings, mode: "SHADOW" });
    }
    if (!current || current.mode === "DISABLED") throw new Error("AGENT_DISABLED_DURING_RUN");
    if (current.settingsVersion !== run.settingsVersion || current.policyVersion !== run.policyVersion) throw new Error("AGENT_SETTINGS_CHANGED_DURING_RUN");
    return current;
  }

  private async eventForRun(run: AgentRunV1) {
    if (run.sourceMode === "LOCAL_REPLAY") return this.replayEvent(run.context?.trigger.replayId ?? (await this.options.repository.getTrigger(run.userId, run.triggerId))?.replayId ?? "");
    return run.eventId ? await this.options.repository.getOfficialEvent(run.eventId) : null;
  }

  private replayEvent(replayId: string) {
    const scenario = replayScenarios.find((item) => item.id === replayId); if (!scenario) throw new Error("REPLAY_NOT_FOUND");
    const normalizedText = normalizeOfficialDocument(`${scenario.event.headline}\n\n${scenario.event.summary}`);
    const contentHash = sha(normalizedText); const id = deterministicUuid(`replay:${scenario.id}`);
    return { version: 1 as const, id, versionId: deterministicUuid(`${id}:${contentHash}`), symbol: scenario.event.symbol,
      sourceType: "REPLAY_FIXTURE" as const, formType: (["8-K", "10-Q", "10-K", "6-K"].includes(scenario.event.formType ?? "")
        ? scenario.event.formType : "IR_RELEASE") as OfficialEventV1["formType"], accessionId: `replay-${scenario.id}`,
      canonicalUrl: scenario.event.sourceUrl, title: scenario.event.headline, publishedAt: scenario.event.publishedAt,
      effectiveAt: scenario.event.publishedAt, detectedAt: scenario.event.detectedAt, contentHash,
      documentHash: sha(`${scenario.id}:${normalizedText}`), normalizedText, evidence: evidenceSegments(normalizedText),
      cautionFlags: [], supersedesEventId: null, supersededByEventId: null } satisfies OfficialEventV1;
  }

  private async ensureOutcome(run: AgentRunV1) {
    if (!run.context || !run.assessment || !run.authorization) throw new Error("OUTCOME_INPUT_MISSING");
    const now = this.now(); const existing = await this.options.repository.getOutcome(run.id, run.userId);
    const replayOutcomeDelayMs = run.sourceMode === "LOCAL_REPLAY"
      ? Math.max(0, Math.min(this.options.replayOutcomeDelayMs ?? 0, 10 * 60_000)) : 0;
    if (existing) {
      if (run.state !== "OUTCOME_PENDING" && !terminalAgentRunStates.has(run.state)) await this.transition(run, "OUTCOME_PENDING", "OUTCOME_MONITORING_ACTIVE");
      return;
    }
    const start = replayOutcomeDelayMs > 0 ? new Date(now.getTime() + replayOutcomeDelayMs)
      : run.context.market.session === "CASH_OPEN" ? now : new Date(run.context.market.nextCashOpen);
    const cashCloseDueAt = run.sourceMode === "LOCAL_REPLAY" ? start
      : cashCloseForDate(start);
    const outcome = AgentOutcomeV1Schema.parse({ version: 1, id: randomUUID(), runId: run.id, userId: run.userId,
      symbol: run.symbol, status: "PENDING", decisionPriceMicros: run.context.market.rTokenPriceMicros,
      proposedNotionalCents: run.assessment.proposedNotionalCents, allowedNotionalCents: run.authorization.allowedNotionalCents,
      nextOpenPriceMicros: null, plus60mPriceMicros: null, cashClosePriceMicros: null,
      observationSources: { nextOpen: null, plus60m: null, cashClose: null }, pnlCents: null,
      mfeBps: null, maeBps: null, collateralBufferChangePct: null, eventSuperseded: false,
      observationDueAt: start.toISOString(), cashCloseDueAt: cashCloseDueAt.toISOString(), scoredAt: null, label: replayOutcomeDelayMs > 0
        ? "Local replay scheduler test waiting for its disclosed delay." : "Waiting for Bitget-only observation windows." });
    await this.options.repository.saveOutcome(outcome);
    const pending = await this.transition(run, "OUTCOME_PENDING", "OUTCOME_MONITORING_SCHEDULED");
    if (run.sourceMode === "LOCAL_REPLAY") {
      if (replayOutcomeDelayMs === 0) { await this.scoreReplayOutcome(pending, outcome); return; }
      await this.options.repository.enqueueJob(AgentJobV1Schema.parse({ id: randomUUID(), runId: run.id,
        userId: run.userId, kind: "OUTCOME_CLOSE", status: "QUEUED", runAt: start.toISOString(), attemptCount: 0,
        workerId: null, leaseExpiresAt: null, lastErrorCode: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }));
      return;
    }
    const close = cashCloseDueAt; const jobs: Array<[AgentJobV1["kind"], Date]> = [
      ["OUTCOME_NEXT_OPEN", new Date(start.getTime() + 5_000)], ["OUTCOME_60M", new Date(start.getTime() + 60 * 60_000)],
      ["OUTCOME_CLOSE", new Date(close.getTime() + 5_000)],
    ];
    for (const [kind, runAt] of jobs) await this.options.repository.enqueueJob(AgentJobV1Schema.parse({ id: randomUUID(), runId: run.id,
      userId: run.userId, kind, status: "QUEUED", runAt: runAt.toISOString(), attemptCount: 0, workerId: null,
      leaseExpiresAt: null, lastErrorCode: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }));
  }

  private async scoreReplayOutcome(run: AgentRunV1, outcome: ReturnType<typeof AgentOutcomeV1Schema.parse>) {
    const scenario = replayScenarios.find((item) => item.id === run.context?.trigger.replayId); if (!scenario) throw new Error("REPLAY_NOT_FOUND");
    const prices = scenario.outcome.samples.map((price) => Math.round(price * 1_000_000));
    const nextOpen = Math.round(scenario.outcome.nextOpenPrice * 1_000_000);
    const plus60m = Math.round(scenario.outcome.plus60mPrice * 1_000_000);
    const last = Math.round(scenario.outcome.cashClosePrice * 1_000_000);
    const side = run.assessment?.action === "REDUCE" ? -1 : 1; const pnl = Math.round((last / outcome.decisionPriceMicros - 1) * outcome.proposedNotionalCents * side);
    const excursions = prices.map((price) => (price / outcome.decisionPriceMicros - 1) * 10_000 * side);
    const status = pnl < 0 ? "AVOIDED_LOSS" : pnl > 0 ? "MISSED_UPSIDE" : "NEUTRAL";
    const scored = AgentOutcomeV1Schema.parse({ ...outcome, status, nextOpenPriceMicros: nextOpen,
      plus60mPriceMicros: plus60m, cashClosePriceMicros: last, observationSources: {
        nextOpen: "RECORDED_REPLAY", plus60m: "RECORDED_REPLAY", cashClose: "RECORDED_REPLAY",
      }, pnlCents: pnl,
      mfeBps: Math.max(...excursions), maeBps: Math.min(...excursions), scoredAt: this.now().toISOString(),
      label: status === "AVOIDED_LOSS" ? "Recorded replay fixture counterfactual: avoided loss" : status === "MISSED_UPSIDE" ? "Recorded replay fixture counterfactual: missed upside" : "Recorded replay fixture counterfactual: neutral" });
    await this.options.repository.saveOutcome(scored); this.options.telemetry?.agentOutcomes.inc({ status: scored.status }); await this.transition(run, "COMPLETED", "REPLAY_OUTCOME_SCORED");
  }

  private async processOutcome(job: AgentJobV1) {
    const run = await this.options.repository.getRun(job.userId, job.runId); if (!run?.context) throw new Error("OUTCOME_RUN_MISSING");
    const outcome = await this.options.repository.getOutcome(run.id, run.userId); if (!outcome) throw new Error("OUTCOME_MISSING");
    const now = this.now();
    if (run.sourceMode === "LOCAL_REPLAY") {
      if (job.kind !== "OUTCOME_CLOSE") throw new Error("REPLAY_OUTCOME_JOB_KIND_INVALID");
      await this.scoreReplayOutcome(run, outcome); return;
    }
    let patch: Partial<Pick<AgentOutcomeV1, "nextOpenPriceMicros" | "plus60mPriceMicros" | "cashClosePriceMicros" | "observationSources">>;
    if (job.kind === "OUTCOME_CLOSE") {
      const close = await this.options.market.completedCashSessionClose(run.symbol,
        cashCloseForDate(new Date(outcome.observationDueAt)), now);
      patch = { cashClosePriceMicros: close.priceMicros, observationSources: {
        ...observationSources(outcome), cashClose: "BITGET_COMPLETED_1M_CANDLE",
      } };
    } else if (job.kind === "OUTCOME_NEXT_OPEN" || job.kind === "OUTCOME_60M") {
      patch = await this.freshOutcomeQuote(run, job.kind, now);
    } else throw new Error("OUTCOME_JOB_KIND_INVALID");
    let updated = AgentOutcomeV1Schema.parse({ ...outcome, ...patch });
    if (job.kind === "OUTCOME_CLOSE") {
      updated = await this.recoverMissingOutcomeObservations(run, updated, now);
      const samples = [updated.nextOpenPriceMicros, updated.plus60mPriceMicros, updated.cashClosePriceMicros].filter((value): value is number => value !== null);
      if (samples.length < 3) {
        const missing = [
          updated.nextOpenPriceMicros === null ? "next-open" : null,
          updated.plus60mPriceMicros === null ? "+60-minute" : null,
          updated.cashClosePriceMicros === null ? "cash-close" : null,
        ].filter((value): value is string => value !== null);
        updated = AgentOutcomeV1Schema.parse({ ...updated, status: "INSUFFICIENT_DATA", scoredAt: now.toISOString(),
          label: `Missing ${missing.join(" and ")} Bitget ${missing.length === 1 ? "observation" : "observations"}; no interpolation was used.` });
      }
      else {
        const side = run.assessment?.action === "REDUCE" ? -1 : 1; const basis = run.receipt ? run.authorization?.allowedNotionalCents ?? 0 : run.assessment?.proposedNotionalCents ?? 0;
        const pnl = Math.round(((updated.cashClosePriceMicros! / updated.decisionPriceMicros) - 1) * basis * side);
        const moves = samples.map((price) => (price / updated.decisionPriceMicros - 1) * 10_000 * side);
        const event = run.eventId ? await this.options.repository.getOfficialEvent(run.eventId) : null;
        const eventChanged = Boolean(event && run.context.event && (event.versionId !== run.context.event.versionId || event.contentHash !== run.context.event.contentHash));
        const latestPortfolio = await this.options.platformRepository.getPortfolio(run.userId);
        const status = run.receipt ? "ESTIMATE_ONLY" : pnl < 0 ? "AVOIDED_LOSS" : pnl > 0 ? "MISSED_UPSIDE" : "NEUTRAL";
        updated = AgentOutcomeV1Schema.parse({ ...updated, status, pnlCents: pnl, mfeBps: Math.max(...moves), maeBps: Math.min(...moves),
          collateralBufferChangePct: latestPortfolio ? Math.round((latestPortfolio.collateralBufferPct - run.context.portfolioRisk.collateralBufferPct) * 10) / 10 : null,
          eventSuperseded: Boolean(event?.supersededByEventId || eventChanged), scoredAt: now.toISOString(), label: run.receipt
            ? "Estimate-only Demo mark-to-market; the provider receipt did not include a reconciled fill price."
            : status === "AVOIDED_LOSS" ? "Counterfactual: avoided loss" : status === "MISSED_UPSIDE" ? "Counterfactual: missed upside" : "Counterfactual: neutral" });
      }
      await this.options.repository.saveOutcome(updated);
      this.options.telemetry?.agentOutcomes.inc({ status: updated.status });
      if (run.state === "OUTCOME_PENDING") await this.transition(run, "COMPLETED", "OUTCOME_SCORED");
    } else await this.options.repository.saveOutcome(updated);
    await this.options.coordinator.publish(`agent:${run.userId}`, { type: "OUTCOME", runId: run.id, outcome: updated });
  }

  private async recoverMissingOutcomeObservations(run: AgentRunV1, outcome: AgentOutcomeV1, now: Date) {
    let updated = outcome;
    const due = new Date(outcome.observationDueAt).getTime();
    if (updated.nextOpenPriceMicros === null) {
      try {
        const recovered = await this.options.market.completedObservationCandle(run.symbol, new Date(due), now);
        updated = AgentOutcomeV1Schema.parse({ ...updated, nextOpenPriceMicros: recovered.priceMicros,
          observationSources: { ...observationSources(updated), nextOpen: recovered.source } });
      } catch (error) {
        this.options.telemetry?.capture(error, { job: "outcome-candle-recovery", symbol: run.symbol, point: "next-open" });
      }
    }
    if (updated.plus60mPriceMicros === null) {
      try {
        const recovered = await this.options.market.completedObservationCandle(run.symbol, new Date(due + 60 * 60_000), now);
        updated = AgentOutcomeV1Schema.parse({ ...updated, plus60mPriceMicros: recovered.priceMicros,
          observationSources: { ...observationSources(updated), plus60m: recovered.source } });
      } catch (error) {
        this.options.telemetry?.capture(error, { job: "outcome-candle-recovery", symbol: run.symbol, point: "+60-minute" });
      }
    }
    return updated;
  }

  private async freshOutcomeQuote(run: AgentRunV1, kind: "OUTCOME_NEXT_OPEN" | "OUTCOME_60M", now: Date) {
    const outcome = await this.options.repository.getOutcome(run.id, run.userId);
    if (!outcome) throw new Error("OUTCOME_MISSING");
    const due = new Date(outcome.observationDueAt).getTime();
    const expected = kind === "OUTCOME_NEXT_OPEN" ? due : due + 60 * 60_000;
    if (now.getTime() < expected) throw new Error("OUTCOME_OBSERVATION_WINDOW_NOT_OPEN");
    if (now.getTime() - expected <= 10 * 60_000) {
      try {
        const snapshot = await this.options.market.snapshot(run.symbol, { mode: "LIVE_BITGET", now, fresh: true });
        if (snapshot.quoteAgeMs <= 10_000 && snapshot.session === "CASH_OPEN") {
          const sources = observationSources(outcome);
          return kind === "OUTCOME_NEXT_OPEN"
            ? { nextOpenPriceMicros: snapshot.rTokenPriceMicros, observationSources: { ...sources, nextOpen: "LIVE_BITGET_QUOTE" as const } }
            : { plus60mPriceMicros: snapshot.rTokenPriceMicros, observationSources: { ...sources, plus60m: "LIVE_BITGET_QUOTE" as const } };
        }
      } catch (error) {
        this.options.telemetry?.capture(error, { job: "outcome-live-observation", symbol: run.symbol, point: kind });
      }
    }
    const recovered = await this.options.market.completedObservationCandle(run.symbol, new Date(expected), now);
    const sources = observationSources(outcome);
    return kind === "OUTCOME_NEXT_OPEN"
      ? { nextOpenPriceMicros: recovered.priceMicros, observationSources: { ...sources, nextOpen: recovered.source } }
      : { plus60mPriceMicros: recovered.priceMicros, observationSources: { ...sources, plus60m: recovered.source } };
  }

  private async transition(run: AgentRunV1, to: AgentRunState, reasonCode: string, patch: Parameters<AgentRepository["transitionRun"]>[4] = {}) {
    const updated = await this.options.repository.transitionRun(run.userId, run.id, to, reasonCode, patch, {}, this.now());
    this.options.telemetry?.agentTransitions.inc({ from: run.state, to });
    if (terminalAgentRunStates.has(to)) {
      this.options.telemetry?.agentRuns.inc({ state: to, reason: reasonCode });
      this.options.telemetry?.agentRunDuration.observe({ state: to }, Math.max(0, (new Date(updated.updatedAt).getTime() - new Date(run.createdAt).getTime()) / 1000));
    }
    await this.options.coordinator.publish(`agent:${run.userId}`, { type: "RUN_TRANSITION", runId: run.id,
      traceId: run.traceId, fromState: run.state, state: to, reasonCode, updatedAt: updated.updatedAt });
    if (patch.receipt) await this.options.coordinator.publish(`agent:${run.userId}`, { type: "RECEIPT", runId: run.id,
      traceId: run.traceId, receipt: patch.receipt });
    if (terminalAgentRunStates.has(to)) await this.options.platformRepository.saveAudit(run.userId, "AGENT_RUN_TERMINAL", run.id,
      { traceId: run.traceId, state: to, reasonCode });
    return updated;
  }

  private async currentReceipt(run: AgentRunV1) {
    const decisionId = run.authorization?.guardDecision?.id; return decisionId ? await this.options.platformRepository.getOrderByDecision(decisionId, run.userId) : null;
  }
  private async notifyDecision(userId: string, symbol: ProductionSymbol, state: "BLOCKED" | "ALERTED", body: string) {
    await this.options.notifications.emit(userId, { kind: "DECISION_BLOCKED", severity: state === "BLOCKED" ? "WARNING" : "INFO",
      title: `${symbol} agent ${state === "BLOCKED" ? "blocked" : "alert"}`, body }, `agent-decision:${userId}:${sha(body).slice(0, 16)}`);
  }
  private requireQwen() { if (!this.options.qwen) throw new Error("AGENT_UNAVAILABLE:QWEN_NOT_CONFIGURED"); return this.options.qwen; }
  private async killSwitches(userId: string) {
    const values = await Promise.all([this.options.coordinator.cacheGet<boolean>("kill:global"),
      this.options.coordinator.cacheGet<boolean>(`kill:user:${userId}`), this.options.coordinator.cacheGet<boolean>("kill:agent-runtime"),
      this.options.coordinator.cacheGet<boolean>("kill:agent-model"), this.options.coordinator.cacheGet<boolean>("kill:agent-provider")]);
    return { global: Boolean(values[0]), user: Boolean(values[1]), runtime: Boolean(values[2]), model: Boolean(values[3]), provider: Boolean(values[4]) };
  }

  private async assertAnalysisAvailable(userId: string, symbol: ProductionSymbol) {
    const base = await this.killSwitches(userId);
    const symbolKilled = Boolean(await this.options.coordinator.cacheGet<boolean>(`kill:symbol:${symbol}`));
    if (base.global || base.user || base.runtime || base.model || base.provider || symbolKilled) throw new Error("AGENT_ANALYSIS_KILLED");
  }

  private async handleJobFailure(job: AgentJobV1, error: unknown) {
    const code = errorCode(error); const now = this.now(); const noRetry = /MODEL_OUTPUT_INVALID|EVIDENCE_INVENTED|BINDING_INVALID|SETTINGS_CHANGED_DURING_RUN|DISABLED_DURING_RUN|REPLAY_NOT_FOUND|ILLEGAL_AGENT_TRANSITION|QWEN_HTTP_4(?!29)/.test(code);
    if (!noRetry && job.attemptCount <= 3) {
      const delays = [60_000, 5 * 60_000, 15 * 60_000];
      const baseDelay = delays[Math.min(delays.length - 1, Math.max(0, job.attemptCount - 1))];
      const jitter = Number.parseInt(sha(`${job.id}:${job.attemptCount}`).slice(0, 4), 16) % Math.max(1, Math.floor(baseDelay * 0.1));
      const runAt = new Date(now.getTime() + baseDelay + jitter);
      await this.options.repository.retryJob(job.id, this.workerId, runAt, code, now);
      await this.options.coordinator.publish(`agent:${job.userId}`, { type: "JOB_RETRY", runId: job.runId, error: code, runAt: runAt.toISOString() }); return;
    }
    const run = await this.options.repository.getRun(job.userId, job.runId);
    if (run && !terminalAgentRunStates.has(run.state)) {
      if (["BLOCKED", "ALERTED", "SHADOW_COMPLETE"].includes(run.state)) {
        const fallback = run.context && run.assessment && run.authorization ? AgentOutcomeV1Schema.parse({ version: 1,
          id: randomUUID(), runId: run.id, userId: run.userId, symbol: run.symbol, status: "INSUFFICIENT_DATA",
          decisionPriceMicros: run.context.market.rTokenPriceMicros, proposedNotionalCents: run.assessment.proposedNotionalCents,
          allowedNotionalCents: run.authorization.allowedNotionalCents, nextOpenPriceMicros: null, plus60mPriceMicros: null,
          cashClosePriceMicros: null, observationSources: { nextOpen: null, plus60m: null, cashClose: null }, pnlCents: null, mfeBps: null, maeBps: null, collateralBufferChangePct: null,
          eventSuperseded: false, observationDueAt: now.toISOString(), scoredAt: now.toISOString(),
          label: "Insufficient data after outcome monitoring failure." }) : null;
        if (fallback) await this.options.repository.saveOutcome(fallback);
        await this.transition(run, "COMPLETED", "OUTCOME_INSUFFICIENT_DATA", { failureCode: code });
      } else {
        try { await this.transition(run, "FAILED_CLOSED", code, { failureCode: code }); }
        catch { /* a concurrent terminal transition wins */ }
      }
    }
    if (run && (run.modeAtStart === "ALERT_ONLY" || run.modeAtStart === "PAPER_AUTO")) {
      const settings = await this.options.repository.getSettings(run.userId);
      if (settings?.notificationsEnabled) await this.options.notifications.emit(run.userId, {
        kind: "DECISION_BLOCKED", severity: "WARNING", title: run.symbol + " agent unavailable",
        body: "The run failed closed before any Demo order: " + code + ".",
      }, "agent-failed:" + run.id);
    }
    await this.options.repository.failJob(job.id, this.workerId, code, now);
  }
}
