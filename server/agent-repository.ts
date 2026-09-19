import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import {
  AgentGrantChallengeSchema,
  AgentGrantV1Schema,
  AgentJobV1Schema,
  AgentOutcomeV1Schema,
  AgentRunTransitionV1Schema,
  AgentRunV1Schema,
  AgentSettingsV1Schema,
  AgentTriggerV1Schema,
  OfficialEventV1Schema,
  assertAgentRunTransition,
  terminalAgentRunStates,
  type AgentGrantChallenge,
  type AgentGrantV1,
  type AgentJobV1,
  type AgentOutcomeV1,
  type AgentRunDetail,
  type AgentRunState,
  type AgentRunTransitionV1,
  type AgentRunV1,
  type AgentSettingsV1,
  type AgentTriggerV1,
  type OfficialEventV1,
} from "../shared/agent-types.js";
import type { ProductionSymbol } from "../shared/production-types.js";
import { agentSchemaSql, agentSchemaVersion } from "./agent-postgres-schema.js";

export type CursorPage<T> = { items: T[]; nextCursor: string | null };
export type AgentQueueStats = { runnable: number; leased: number; oldestRunnableAgeMs: number };
export type AgentExecutionReservation = { runId: string; userId: string; eventId: string | null; symbol: ProductionSymbol; side: "buy" | "sell"; notionalCents: number; createdAt: string };
export type AgentAutomaticUsage = { count: number; grossNewNotionalCents: number };
export type CollateralRiskState = {
  userId: string;
  settingsVersion: string;
  phase: "ARMED" | "ACTIVE";
  episodeKey: string;
  lastBandPct: number | null;
  updatedAt: string;
};
export type AgentRunPatch = Partial<Omit<AgentRunV1, "id" | "traceId" | "userId" | "triggerId" | "createdAt" | "state">>;

export interface AgentRepository {
  init(): Promise<void>;
  ready(): Promise<boolean>;
  saveOfficialEvent(event: OfficialEventV1): Promise<{ created: boolean; changed: boolean; event: OfficialEventV1 }>;
  getOfficialEvent(id: string): Promise<OfficialEventV1 | null>;
  listOfficialEvents(since: string, limit?: number): Promise<OfficialEventV1[]>;
  getSettings(userId: string): Promise<AgentSettingsV1 | null>;
  saveSettings(settings: AgentSettingsV1): Promise<void>;
  listEnabledSettings(): Promise<AgentSettingsV1[]>;
  getCollateralRiskState(userId: string): Promise<CollateralRiskState | null>;
  saveCollateralRiskState(state: CollateralRiskState): Promise<void>;
  saveGrantChallenge(challenge: AgentGrantChallenge): Promise<void>;
  consumeGrantChallenge(id: string, userId: string, now: Date): Promise<AgentGrantChallenge | null>;
  saveGrant(grant: AgentGrantV1): Promise<void>;
  getCurrentGrant(userId: string): Promise<AgentGrantV1 | null>;
  revokeCurrentGrant(userId: string, reason: string, now: Date): Promise<AgentGrantV1 | null>;
  listExpiringGrants(before: string): Promise<AgentGrantV1[]>;
  createRunBundle(trigger: AgentTriggerV1, run: AgentRunV1, job: AgentJobV1, transition: AgentRunTransitionV1): Promise<{ created: boolean; run: AgentRunV1 }>;
  getTrigger(userId: string, triggerId: string): Promise<AgentTriggerV1 | null>;
  getRun(userId: string, runId: string): Promise<AgentRunV1 | null>;
  listRuns(userId: string, limit: number, cursor?: string): Promise<CursorPage<AgentRunV1>>;
  listRecentRuns(userId: string, symbol: ProductionSymbol, since: string, limit?: number): Promise<AgentRunV1[]>;
  countQualifyingRuns(userId: string, since: string): Promise<number>;
  transitionRun(userId: string, runId: string, to: AgentRunState, reasonCode: string, patch?: AgentRunPatch,
    metadata?: AgentRunTransitionV1["metadata"], now?: Date): Promise<AgentRunV1>;
  getRunDetail(userId: string, runId: string): Promise<AgentRunDetail | null>;
  enqueueJob(job: AgentJobV1): Promise<boolean>;
  claimJob(workerId: string, now: Date, leaseMs: number): Promise<AgentJobV1 | null>;
  heartbeatJob(jobId: string, workerId: string, now: Date, leaseMs: number): Promise<boolean>;
  completeJob(jobId: string, workerId: string, now: Date): Promise<void>;
  retryJob(jobId: string, workerId: string, runAt: Date, errorCode: string, now: Date): Promise<void>;
  failJob(jobId: string, workerId: string, errorCode: string, now: Date): Promise<void>;
  heartbeatWorker(workerId: string, now: Date, metadata?: Record<string, unknown>): Promise<void>;
  latestWorkerHeartbeat(): Promise<string | null>;
  queueStats(now: Date): Promise<AgentQueueStats>;
  getOrCreateDailyEquityBaseline(userId: string, utcDate: string, equityCents: number, capturedAt: string): Promise<number>;
  reserveAutomaticExecution(reservation: AgentExecutionReservation, limits: { count: number; grossNewNotionalCents: number; cooldownMs: number }): Promise<{ created: boolean; usage: AgentAutomaticUsage }>;
  getAutomaticUsage(userId: string, since: string): Promise<AgentAutomaticUsage>;
  saveOutcome(outcome: AgentOutcomeV1): Promise<void>;
  getOutcome(runId: string, userId: string): Promise<AgentOutcomeV1 | null>;
  listOutcomes(userId: string, limit: number, cursor?: string): Promise<CursorPage<AgentOutcomeV1>>;
  exportUserData(userId: string): Promise<Record<string, unknown>>;
  deleteUserData(userId: string): Promise<void>;
  prune(now: Date): Promise<void>;
  close(): Promise<void>;
}

const sqliteAgentSchema = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS official_events (
    id TEXT PRIMARY KEY, symbol TEXT NOT NULL, source_type TEXT NOT NULL, accession_id TEXT NOT NULL,
    current_version_id TEXT NOT NULL, current_content_hash TEXT NOT NULL, superseded_by_event_id TEXT,
    detected_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source_type,accession_id)
  );
  CREATE TABLE IF NOT EXISTS official_event_versions (
    version_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, content_hash TEXT NOT NULL,
    document_hash TEXT NOT NULL, published_at TEXT NOT NULL, event_json TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(event_id,content_hash)
  );
  CREATE INDEX IF NOT EXISTS official_events_symbol_detected_idx ON official_events(symbol,detected_at DESC);
  CREATE TABLE IF NOT EXISTS agent_settings (
    user_id TEXT PRIMARY KEY, mode TEXT NOT NULL, settings_version TEXT NOT NULL,
    shadow_started_at TEXT, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_settings_enabled_idx ON agent_settings(mode,updated_at);
  CREATE TABLE IF NOT EXISTS agent_collateral_risk_states (
    user_id TEXT PRIMARY KEY, settings_version TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('ARMED','ACTIVE')),
    episode_key TEXT NOT NULL, last_band_pct INTEGER, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_grant_challenges (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, scope_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL, consumed_at TEXT, challenge_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_grants (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, message_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
    revoked_at TEXT, grant_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_grants_one_active_idx ON agent_grants(user_id) WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS agent_grants_expiry_idx ON agent_grants(expires_at) WHERE revoked_at IS NULL;
  CREATE TABLE IF NOT EXISTS agent_triggers (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT, symbol TEXT NOT NULL, trigger_type TEXT NOT NULL,
    source_mode TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, trigger_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY, trace_id TEXT NOT NULL UNIQUE, trigger_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
    event_id TEXT, symbol TEXT NOT NULL, source_mode TEXT NOT NULL, mode_at_start TEXT NOT NULL, state TEXT NOT NULL,
    qualifying_shadow_run INTEGER NOT NULL DEFAULT 0, run_json TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, terminal_at TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_runs_user_cursor_idx ON agent_runs(user_id,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS agent_runs_eligibility_idx ON agent_runs(user_id,qualifying_shadow_run,created_at);
  CREATE INDEX IF NOT EXISTS agent_runs_symbol_recent_idx ON agent_runs(user_id,symbol,created_at DESC);
  CREATE TABLE IF NOT EXISTS agent_run_transitions (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, user_id TEXT NOT NULL, trace_id TEXT NOT NULL,
    to_state TEXT NOT NULL, transition_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(run_id,to_state,created_at)
  );
  CREATE INDEX IF NOT EXISTS agent_transitions_run_idx ON agent_run_transitions(run_id,created_at,id);
  CREATE TABLE IF NOT EXISTS agent_jobs (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
    run_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, worker_id TEXT, lease_expires_at TEXT,
    last_error_code TEXT, job_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(run_id,kind,run_at)
  );
  CREATE INDEX IF NOT EXISTS agent_jobs_claim_idx ON agent_jobs(status,run_at,lease_expires_at);
  CREATE TABLE IF NOT EXISTS agent_daily_equity_baselines (
    user_id TEXT NOT NULL, utc_date TEXT NOT NULL, equity_cents INTEGER NOT NULL, captured_at TEXT NOT NULL,
    PRIMARY KEY(user_id,utc_date)
  );
  CREATE TABLE IF NOT EXISTS agent_execution_reservations (
    run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL,
    notional_cents INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_execution_one_event_idx ON agent_execution_reservations(user_id,event_id) WHERE event_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS agent_execution_daily_idx ON agent_execution_reservations(user_id,created_at);
  CREATE INDEX IF NOT EXISTS agent_execution_symbol_cooldown_idx ON agent_execution_reservations(user_id,symbol,created_at DESC);
  CREATE TABLE IF NOT EXISTS agent_outcomes (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, status TEXT NOT NULL,
    observation_due_at TEXT NOT NULL, outcome_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_outcomes_user_cursor_idx ON agent_outcomes(user_id,observation_due_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS agent_outcomes_due_idx ON agent_outcomes(status,observation_due_at);
  CREATE TABLE IF NOT EXISTS agent_worker_heartbeats (worker_id TEXT PRIMARY KEY, heartbeat_at TEXT NOT NULL, metadata_json TEXT NOT NULL);
`;

function parse<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function cursorParts(cursor?: string) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { at: string; id: string };
    if (!value.at || !value.id || Number.isNaN(new Date(value.at).getTime())) return null;
    return value;
  } catch { return null; }
}

function nextCursor(items: Array<{ id: string; createdAt?: string; observationDueAt?: string }>, limit: number) {
  if (items.length < limit) return null;
  const last = items[items.length - 1];
  return Buffer.from(JSON.stringify({ at: last.createdAt ?? last.observationDueAt, id: last.id })).toString("base64url");
}

function mergeRun(run: AgentRunV1, to: AgentRunState, patch: AgentRunPatch, now: Date): AgentRunV1 {
  assertAgentRunTransition(run.state, to);
  const terminalAt = terminalAgentRunStates.has(to) ? now.toISOString() : (patch.terminalAt ?? run.terminalAt);
  return AgentRunV1Schema.parse({ ...run, ...patch, state: to, updatedAt: now.toISOString(), terminalAt });
}

function orderedTransitions(items: AgentRunTransitionV1[]) {
  const remaining = [...items]; const ordered: AgentRunTransitionV1[] = []; let prior: AgentRunState | null = null;
  while (remaining.length) {
    const index = remaining.findIndex((item) => item.fromState === prior);
    if (index < 0) return [...ordered, ...remaining.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))];
    const [next] = remaining.splice(index, 1); ordered.push(next); prior = next.toState;
  }
  return ordered;
}

function revisedGrant(grant: AgentGrantV1, reason: string, now: Date) {
  return AgentGrantV1Schema.parse({ ...grant, revokedAt: now.toISOString(), revokedReason: reason });
}

function assertRunBundle(trigger: AgentTriggerV1, run: AgentRunV1, job: AgentJobV1, transition: AgentRunTransitionV1) {
  AgentTriggerV1Schema.parse(trigger);
  AgentRunV1Schema.parse(run);
  AgentJobV1Schema.parse(job);
  AgentRunTransitionV1Schema.parse(transition);
  if (run.triggerId !== trigger.id || job.runId !== run.id || transition.runId !== run.id ||
    run.userId !== trigger.userId || job.userId !== run.userId || transition.userId !== run.userId ||
    run.traceId !== transition.traceId || run.symbol !== trigger.symbol || run.eventId !== trigger.eventId ||
    run.sourceMode !== trigger.sourceMode || run.state !== "QUEUED" || run.qualifyingShadowRun || transition.fromState !== null ||
    transition.toState !== "QUEUED" || job.kind !== "PROCESS_RUN" || job.status !== "QUEUED") {
    throw new Error("AGENT_RUN_BUNDLE_BINDING_INVALID");
  }
}

function assertCollateralRiskState(state: CollateralRiskState) {
  const validBand = state.lastBandPct === null || (Number.isInteger(state.lastBandPct) && state.lastBandPct >= 0 && state.lastBandPct <= 100);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state.userId) ||
    !state.settingsVersion || state.settingsVersion.length > 128 || !["ARMED", "ACTIVE"].includes(state.phase) ||
    !state.episodeKey || state.episodeKey.length > 128 || !validBand || Number.isNaN(new Date(state.updatedAt).getTime())) {
    throw new Error("AGENT_COLLATERAL_STATE_INVALID");
  }
}

function assertExecutionReservation(reservation: AgentExecutionReservation, limits: { count: number; grossNewNotionalCents: number; cooldownMs: number }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservation.runId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservation.userId) ||
    !Number.isInteger(reservation.notionalCents) || reservation.notionalCents <= 0 ||
    !Number.isInteger(limits.count) || limits.count < 1 || !Number.isInteger(limits.grossNewNotionalCents) ||
    limits.grossNewNotionalCents < 1 || !Number.isFinite(limits.cooldownMs) || limits.cooldownMs < 0 ||
    Number.isNaN(new Date(reservation.createdAt).getTime())) throw new Error("AGENT_EXECUTION_RESERVATION_INVALID");
}

export class SqliteAgentRepository implements AgentRepository {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  async init() { this.db.exec(sqliteAgentSchema); }
  async ready() { return Boolean(this.db.prepare("SELECT 1 AS ok").get()); }

  async saveOfficialEvent(event: OfficialEventV1) {
    OfficialEventV1Schema.parse(event);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT id,current_content_hash,current_version_id FROM official_events WHERE source_type=? AND accession_id=?")
        .get(event.sourceType, event.accessionId) as { id: string; current_content_hash: string; current_version_id: string } | undefined;
      if (row?.current_content_hash === event.contentHash) {
        const stored = this.readOfficialEvent(row.id);
        this.db.exec("COMMIT");
        return { created: false, changed: false, event: stored ?? event };
      }
      const storedEvent = row ? { ...event, id: row.id,
        cautionFlags: [...new Set([...event.cautionFlags, "CORRECTION" as const])] } : event;
      if (!row) {
        this.db.prepare("INSERT INTO official_events VALUES(?,?,?,?,?,?,?,?,?)").run(storedEvent.id, storedEvent.symbol,
          storedEvent.sourceType, storedEvent.accessionId, storedEvent.versionId, storedEvent.contentHash,
          storedEvent.supersededByEventId, storedEvent.detectedAt, storedEvent.detectedAt);
      } else {
        this.db.prepare("UPDATE official_events SET symbol=?,current_version_id=?,current_content_hash=?,superseded_by_event_id=?,updated_at=? WHERE id=?")
          .run(storedEvent.symbol, storedEvent.versionId, storedEvent.contentHash, storedEvent.supersededByEventId,
            storedEvent.detectedAt, row.id);
      }
      this.db.prepare("INSERT OR IGNORE INTO official_event_versions VALUES(?,?,?,?,?,?,?)")
        .run(storedEvent.versionId, storedEvent.id, storedEvent.contentHash, storedEvent.documentHash,
          storedEvent.publishedAt, JSON.stringify(storedEvent), storedEvent.detectedAt);
      const persisted = this.readOfficialEvent(storedEvent.id);
      this.db.exec("COMMIT");
      return { created: !row, changed: Boolean(row), event: persisted ?? storedEvent };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async getOfficialEvent(id: string) { return this.readOfficialEvent(id); }

  async listOfficialEvents(since: string, limit = 100) {
    const rows = this.db.prepare(`SELECT v.event_json FROM official_events e JOIN official_event_versions v
      ON v.version_id=e.current_version_id WHERE e.detected_at>=? ORDER BY e.detected_at LIMIT ?`).all(since, limit) as Array<{ event_json: string }>;
    return rows.map((row) => OfficialEventV1Schema.parse(parse(row.event_json)));
  }

  async getSettings(userId: string) {
    const row = this.db.prepare("SELECT settings_json FROM agent_settings WHERE user_id=?").get(userId) as { settings_json: string } | undefined;
    return row ? AgentSettingsV1Schema.parse(parse(row.settings_json)) : null;
  }

  async saveSettings(settings: AgentSettingsV1) {
    AgentSettingsV1Schema.parse(settings);
    this.db.prepare(`INSERT INTO agent_settings VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
      mode=excluded.mode,settings_version=excluded.settings_version,shadow_started_at=excluded.shadow_started_at,
      settings_json=excluded.settings_json,updated_at=excluded.updated_at`).run(settings.userId, settings.mode,
      settings.settingsVersion, settings.shadowStartedAt, JSON.stringify(settings), settings.updatedAt);
  }

  async listEnabledSettings() {
    const rows = this.db.prepare("SELECT settings_json FROM agent_settings WHERE mode<>'DISABLED' ORDER BY updated_at")
      .all() as Array<{ settings_json: string }>;
    return rows.map((row) => AgentSettingsV1Schema.parse(parse(row.settings_json)));
  }

  async getCollateralRiskState(userId: string) {
    const row = this.db.prepare(`SELECT settings_version,phase,episode_key,last_band_pct,updated_at
      FROM agent_collateral_risk_states WHERE user_id=?`).get(userId) as {
        settings_version: string; phase: "ARMED" | "ACTIVE"; episode_key: string;
        last_band_pct: number | null; updated_at: string;
      } | undefined;
    return row ? { userId, settingsVersion: row.settings_version, phase: row.phase,
      episodeKey: row.episode_key, lastBandPct: row.last_band_pct, updatedAt: row.updated_at } : null;
  }

  async saveCollateralRiskState(state: CollateralRiskState) {
    assertCollateralRiskState(state);
    this.db.prepare(`INSERT INTO agent_collateral_risk_states VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET settings_version=excluded.settings_version,phase=excluded.phase,
      episode_key=excluded.episode_key,last_band_pct=excluded.last_band_pct,updated_at=excluded.updated_at`)
      .run(state.userId, state.settingsVersion, state.phase, state.episodeKey, state.lastBandPct, state.updatedAt);
  }

  async saveGrantChallenge(challenge: AgentGrantChallenge) {
    AgentGrantChallengeSchema.parse(challenge);
    this.db.prepare("INSERT INTO agent_grant_challenges VALUES(?,?,?,?,?,?,?,?)").run(challenge.id, challenge.userId,
      challenge.nonce, challenge.scopeHash, challenge.expiresAt, challenge.consumedAt, JSON.stringify(challenge), challenge.createdAt);
  }

  async consumeGrantChallenge(id: string, userId: string, now: Date) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT challenge_json,expires_at,consumed_at FROM agent_grant_challenges WHERE id=? AND user_id=?")
        .get(id, userId) as { challenge_json: string; expires_at: string; consumed_at: string | null } | undefined;
      if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= now.getTime()) { this.db.exec("COMMIT"); return null; }
      const consumed = AgentGrantChallengeSchema.parse({ ...parse<AgentGrantChallenge>(row.challenge_json), consumedAt: now.toISOString() });
      this.db.prepare("UPDATE agent_grant_challenges SET consumed_at=?,challenge_json=? WHERE id=? AND consumed_at IS NULL")
        .run(consumed.consumedAt, JSON.stringify(consumed), id);
      this.db.exec("COMMIT");
      return consumed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async saveGrant(grant: AgentGrantV1) {
    AgentGrantV1Schema.parse(grant);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT id,grant_json FROM agent_grants WHERE user_id=? AND revoked_at IS NULL").get(grant.userId) as
        { id: string; grant_json: string } | undefined;
      if (current) {
        const revoked = revisedGrant(parse(current.grant_json), "RENEWED", new Date(grant.issuedAt));
        this.db.prepare("UPDATE agent_grants SET revoked_at=?,grant_json=? WHERE id=?").run(revoked.revokedAt, JSON.stringify(revoked), current.id);
      }
      this.db.prepare("INSERT INTO agent_grants VALUES(?,?,?,?,?,?,?)").run(grant.id, grant.userId, grant.messageHash,
        grant.expiresAt, grant.revokedAt, JSON.stringify(grant), grant.issuedAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async getCurrentGrant(userId: string) { return this.readCurrentGrant(userId); }

  async revokeCurrentGrant(userId: string, reason: string, now: Date) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const grant = this.readCurrentGrant(userId);
      if (!grant) { this.db.exec("COMMIT"); return null; }
      const revoked = revisedGrant(grant, reason, now);
      this.db.prepare("UPDATE agent_grants SET revoked_at=?,grant_json=? WHERE id=? AND revoked_at IS NULL")
        .run(revoked.revokedAt, JSON.stringify(revoked), grant.id);
      this.db.exec("COMMIT");
      return revoked;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async listExpiringGrants(before: string) {
    const rows = this.db.prepare("SELECT grant_json FROM agent_grants WHERE revoked_at IS NULL AND expires_at<=? ORDER BY expires_at")
      .all(before) as Array<{ grant_json: string }>;
    return rows.map((row) => AgentGrantV1Schema.parse(parse(row.grant_json)));
  }

  async createRunBundle(trigger: AgentTriggerV1, run: AgentRunV1, job: AgentJobV1, transition: AgentRunTransitionV1) {
    assertRunBundle(trigger, run, job, transition);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(`SELECT r.run_json FROM agent_triggers t JOIN agent_runs r ON r.trigger_id=t.id
        WHERE t.dedupe_key=?`).get(trigger.dedupeKey) as { run_json: string } | undefined;
      if (existing) { this.db.exec("COMMIT"); return { created: false, run: AgentRunV1Schema.parse(parse(existing.run_json)) }; }
      this.db.prepare("INSERT INTO agent_triggers VALUES(?,?,?,?,?,?,?,?,?)").run(trigger.id, trigger.userId, trigger.eventId,
        trigger.symbol, trigger.type, trigger.sourceMode, trigger.dedupeKey, JSON.stringify(trigger), trigger.createdAt);
      this.insertRun(run);
      this.insertTransition(transition);
      this.insertJob(job);
      this.db.exec("COMMIT");
      return { created: true, run };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async getTrigger(userId: string, triggerId: string) {
    const row = this.db.prepare("SELECT trigger_json FROM agent_triggers WHERE id=? AND user_id=?").get(triggerId, userId) as { trigger_json: string } | undefined;
    return row ? parse<AgentTriggerV1>(row.trigger_json) : null;
  }

  async getRun(userId: string, runId: string) { return this.readRun(userId, runId); }

  async listRuns(userId: string, limit: number, cursor?: string) {
    const after = cursorParts(cursor);
    const rows = (after
      ? this.db.prepare(`SELECT run_json FROM agent_runs WHERE user_id=? AND (created_at<? OR (created_at=? AND id<?))
          ORDER BY created_at DESC,id DESC LIMIT ?`).all(userId, after.at, after.at, after.id, limit)
      : this.db.prepare("SELECT run_json FROM agent_runs WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?").all(userId, limit)) as Array<{ run_json: string }>;
    const items = rows.map((row) => AgentRunV1Schema.parse(parse(row.run_json)));
    return { items, nextCursor: nextCursor(items, limit) };
  }

  async listRecentRuns(userId: string, symbol: ProductionSymbol, since: string, limit = 100) {
    const rows = this.db.prepare("SELECT run_json FROM agent_runs WHERE user_id=? AND symbol=? AND created_at>=? ORDER BY created_at DESC LIMIT ?")
      .all(userId, symbol, since, limit) as Array<{ run_json: string }>;
    return rows.map((row) => AgentRunV1Schema.parse(parse(row.run_json)));
  }

  async countQualifyingRuns(userId: string, since: string) {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE user_id=? AND qualifying_shadow_run=1 AND created_at>=?")
      .get(userId, since) as { count: number };
    return Number(row.count);
  }

  async transitionRun(userId: string, runId: string, to: AgentRunState, reasonCode: string, patch: AgentRunPatch = {},
    metadata: AgentRunTransitionV1["metadata"] = {}, now = new Date()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readRun(userId, runId);
      if (!current) throw new Error("AGENT_RUN_NOT_FOUND");
      if (patch.qualifyingShadowRun && (current.sourceMode !== "LIVE_BITGET" || current.analystOrigin !== "QWEN" ||
        current.modeAtStart === "PAPER_AUTO" || !["SHADOW_COMPLETE", "ALERTED", "BLOCKED"].includes(to))) {
        throw new Error("AGENT_QUALIFYING_RUN_INVALID");
      }
      const updated = mergeRun(current, to, patch, now);
      const transition = AgentRunTransitionV1Schema.parse({ version: 1, id: crypto.randomUUID(), runId, userId,
        traceId: current.traceId, fromState: current.state, toState: to, reasonCode, metadata, createdAt: now.toISOString() });
      this.db.prepare(`UPDATE agent_runs SET state=?,qualifying_shadow_run=?,run_json=?,updated_at=?,terminal_at=?
        WHERE id=? AND user_id=? AND state=?`).run(updated.state, updated.qualifyingShadowRun ? 1 : 0,
        JSON.stringify(updated), updated.updatedAt, updated.terminalAt, runId, userId, current.state);
      const changed = this.db.prepare("SELECT changes() AS count").get() as { count: number };
      if (changed.count !== 1) throw new Error("AGENT_RUN_CONCURRENT_TRANSITION");
      this.insertTransition(transition);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async getRunDetail(userId: string, runId: string) {
    const run = await this.getRun(userId, runId);
    if (!run) return null;
    const rows = this.db.prepare("SELECT transition_json FROM agent_run_transitions WHERE run_id=? AND user_id=? ORDER BY created_at,id")
      .all(runId, userId) as Array<{ transition_json: string }>;
    return { ...run, transitions: orderedTransitions(rows.map((row) => AgentRunTransitionV1Schema.parse(parse(row.transition_json)))),
      outcome: await this.getOutcome(runId, userId) };
  }

  async enqueueJob(job: AgentJobV1) {
    AgentJobV1Schema.parse(job);
    const result = this.db.prepare("INSERT OR IGNORE INTO agent_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(job.id, job.runId,
      job.userId, job.kind, job.status, job.runAt, job.attemptCount, job.workerId, job.leaseExpiresAt, job.lastErrorCode,
      JSON.stringify(job), job.createdAt, job.updatedAt);
    return result.changes === 1;
  }

  async claimJob(workerId: string, now: Date, leaseMs: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const at = now.toISOString();
      this.db.prepare(`UPDATE agent_jobs SET status='QUEUED',worker_id=NULL,lease_expires_at=NULL,updated_at=?,
        job_json=json_set(job_json,'$.status','QUEUED','$.workerId',NULL,'$.leaseExpiresAt',NULL,'$.updatedAt',?)
        WHERE status='LEASED' AND lease_expires_at<=?`).run(at, at, at);
      const row = this.db.prepare("SELECT * FROM agent_jobs WHERE status='QUEUED' AND run_at<=? ORDER BY run_at,id LIMIT 1")
        .get(at) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return null; }
      const job = AgentJobV1Schema.parse(parse(row.job_json));
      const leased = AgentJobV1Schema.parse({ ...job, status: "LEASED", attemptCount: job.attemptCount + 1, workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(), updatedAt: at });
      this.db.prepare("UPDATE agent_jobs SET status=?,attempt_count=?,worker_id=?,lease_expires_at=?,job_json=?,updated_at=? WHERE id=? AND status='QUEUED'")
        .run(leased.status, leased.attemptCount, workerId, leased.leaseExpiresAt, JSON.stringify(leased), at, leased.id);
      this.db.exec("COMMIT");
      return leased;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async heartbeatJob(jobId: string, workerId: string, now: Date, leaseMs: number) {
    const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const row = this.db.prepare("SELECT job_json FROM agent_jobs WHERE id=? AND worker_id=? AND status='LEASED'")
      .get(jobId, workerId) as { job_json: string } | undefined;
    if (!row) return false;
    const job = AgentJobV1Schema.parse({ ...parse<AgentJobV1>(row.job_json), leaseExpiresAt: expiresAt, updatedAt: now.toISOString() });
    return this.db.prepare("UPDATE agent_jobs SET lease_expires_at=?,updated_at=?,job_json=? WHERE id=? AND worker_id=? AND status='LEASED'")
      .run(expiresAt, job.updatedAt, JSON.stringify(job), jobId, workerId).changes === 1;
  }

  async completeJob(jobId: string, workerId: string, now: Date) { this.finishJob(jobId, workerId, "COMPLETED", null, now); }
  async retryJob(jobId: string, workerId: string, runAt: Date, errorCode: string, now: Date) {
    const row = this.db.prepare("SELECT job_json FROM agent_jobs WHERE id=? AND worker_id=? AND status='LEASED'").get(jobId, workerId) as { job_json: string } | undefined;
    if (!row) throw new Error("AGENT_JOB_LEASE_LOST");
    const job = AgentJobV1Schema.parse({ ...parse<AgentJobV1>(row.job_json), status: "QUEUED", runAt: runAt.toISOString(),
      workerId: null, leaseExpiresAt: null, lastErrorCode: errorCode, updatedAt: now.toISOString() });
    this.db.prepare("UPDATE agent_jobs SET status='QUEUED',run_at=?,worker_id=NULL,lease_expires_at=NULL,last_error_code=?,job_json=?,updated_at=? WHERE id=? AND worker_id=? AND status='LEASED'")
      .run(job.runAt, errorCode, JSON.stringify(job), job.updatedAt, jobId, workerId);
  }
  async failJob(jobId: string, workerId: string, errorCode: string, now: Date) { this.finishJob(jobId, workerId, "FAILED", errorCode, now); }

  async heartbeatWorker(workerId: string, now: Date, metadata: Record<string, unknown> = {}) {
    this.db.prepare(`INSERT INTO agent_worker_heartbeats VALUES(?,?,?) ON CONFLICT(worker_id) DO UPDATE SET
      heartbeat_at=excluded.heartbeat_at,metadata_json=excluded.metadata_json`).run(workerId, now.toISOString(), JSON.stringify(metadata));
  }
  async latestWorkerHeartbeat() {
    const row = this.db.prepare("SELECT heartbeat_at FROM agent_worker_heartbeats ORDER BY heartbeat_at DESC LIMIT 1").get() as { heartbeat_at: string } | undefined;
    return row?.heartbeat_at ?? null;
  }
  async queueStats(now: Date) {
    const row = this.db.prepare(`SELECT SUM(CASE WHEN status='QUEUED' AND run_at<=? THEN 1 ELSE 0 END) AS runnable,
      SUM(CASE WHEN status='LEASED' THEN 1 ELSE 0 END) AS leased,
      MIN(CASE WHEN status='QUEUED' AND run_at<=? THEN run_at END) AS oldest FROM agent_jobs`).get(now.toISOString(), now.toISOString()) as
      { runnable: number | null; leased: number | null; oldest: string | null };
    return { runnable: Number(row.runnable ?? 0), leased: Number(row.leased ?? 0),
      oldestRunnableAgeMs: row.oldest ? Math.max(0, now.getTime() - new Date(row.oldest).getTime()) : 0 };
  }

  async getOrCreateDailyEquityBaseline(userId: string, utcDate: string, equityCents: number, capturedAt: string) {
    this.db.prepare("INSERT OR IGNORE INTO agent_daily_equity_baselines VALUES(?,?,?,?)").run(userId, utcDate, equityCents, capturedAt);
    const row = this.db.prepare("SELECT equity_cents FROM agent_daily_equity_baselines WHERE user_id=? AND utc_date=?").get(userId, utcDate) as { equity_cents: number };
    return Number(row.equity_cents);
  }
  async reserveAutomaticExecution(reservation: AgentExecutionReservation, limits: { count: number; grossNewNotionalCents: number; cooldownMs: number }) {
    assertExecutionReservation(reservation, limits);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const runRow = this.db.prepare("SELECT run_json FROM agent_runs WHERE id=? AND user_id=?").get(reservation.runId, reservation.userId) as { run_json: string } | undefined;
      const run = runRow ? AgentRunV1Schema.parse(parse(runRow.run_json)) : null;
      if (!run || run.symbol !== reservation.symbol || run.eventId !== reservation.eventId) throw new Error("AGENT_EXECUTION_RUN_BINDING_INVALID");
      const since = new Date(Date.UTC(new Date(reservation.createdAt).getUTCFullYear(), new Date(reservation.createdAt).getUTCMonth(), new Date(reservation.createdAt).getUTCDate())).toISOString();
      const existing = this.db.prepare("SELECT run_id FROM agent_execution_reservations WHERE run_id=?").get(reservation.runId);
      const usageRow = this.db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN side='buy' THEN notional_cents ELSE 0 END),0) AS gross FROM agent_execution_reservations WHERE user_id=? AND created_at>=?").get(reservation.userId, since) as { count: number; gross: number };
      const current = { count: Number(usageRow.count), grossNewNotionalCents: Number(usageRow.gross) };
      if (existing) { this.db.exec("COMMIT"); return { created: false, usage: current }; }
      if (current.count >= limits.count) throw new Error("AGENT_DAILY_ORDER_LIMIT");
      if (reservation.side === "buy" && current.grossNewNotionalCents + reservation.notionalCents > limits.grossNewNotionalCents) throw new Error("AGENT_DAILY_NOTIONAL_LIMIT");
      if (reservation.eventId && this.db.prepare("SELECT 1 FROM agent_execution_reservations WHERE user_id=? AND event_id=?").get(reservation.userId, reservation.eventId)) throw new Error("AGENT_EVENT_ALREADY_ACTIONED");
      const cooldown = new Date(new Date(reservation.createdAt).getTime() - limits.cooldownMs).toISOString();
      if (this.db.prepare("SELECT 1 FROM agent_execution_reservations WHERE user_id=? AND symbol=? AND created_at>=?").get(reservation.userId, reservation.symbol, cooldown)) throw new Error("AGENT_SYMBOL_COOLDOWN");
      this.db.prepare("INSERT INTO agent_execution_reservations VALUES(?,?,?,?,?,?,?)").run(reservation.runId, reservation.userId,
        reservation.eventId, reservation.symbol, reservation.side, reservation.notionalCents, reservation.createdAt);
      this.db.exec("COMMIT");
      return { created: true, usage: { count: current.count + 1, grossNewNotionalCents: current.grossNewNotionalCents + (reservation.side === "buy" ? reservation.notionalCents : 0) } };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async getAutomaticUsage(userId: string, since: string) {
    const row = this.db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN side='buy' THEN notional_cents ELSE 0 END),0) AS gross FROM agent_execution_reservations WHERE user_id=? AND created_at>=?").get(userId, since) as { count: number; gross: number };
    return { count: Number(row.count), grossNewNotionalCents: Number(row.gross) };
  }

  async saveOutcome(outcome: AgentOutcomeV1) {
    AgentOutcomeV1Schema.parse(outcome);
    const run = this.readRun(outcome.userId, outcome.runId); if (!run) throw new Error("AGENT_OUTCOME_TENANT_MISMATCH");
    const now = outcome.scoredAt ?? new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO agent_outcomes VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      status=excluded.status,observation_due_at=excluded.observation_due_at,outcome_json=excluded.outcome_json,updated_at=excluded.updated_at
      WHERE agent_outcomes.user_id=excluded.user_id`)
      .run(outcome.id, outcome.runId, outcome.userId, outcome.status, outcome.observationDueAt, JSON.stringify(outcome), now, now);
    if (result.changes !== 1) throw new Error("AGENT_OUTCOME_TENANT_MISMATCH");
  }
  async getOutcome(runId: string, userId: string) {
    const row = this.db.prepare("SELECT outcome_json FROM agent_outcomes WHERE run_id=? AND user_id=?").get(runId, userId) as { outcome_json: string } | undefined;
    return row ? AgentOutcomeV1Schema.parse(parse(row.outcome_json)) : null;
  }
  async listOutcomes(userId: string, limit: number, cursor?: string) {
    const after = cursorParts(cursor);
    const rows = (after
      ? this.db.prepare(`SELECT outcome_json FROM agent_outcomes WHERE user_id=? AND (observation_due_at<? OR (observation_due_at=? AND id<?))
          ORDER BY observation_due_at DESC,id DESC LIMIT ?`).all(userId, after.at, after.at, after.id, limit)
      : this.db.prepare("SELECT outcome_json FROM agent_outcomes WHERE user_id=? ORDER BY observation_due_at DESC,id DESC LIMIT ?").all(userId, limit)) as Array<{ outcome_json: string }>;
    const items = rows.map((row) => AgentOutcomeV1Schema.parse(parse(row.outcome_json)));
    return { items, nextCursor: nextCursor(items, limit) };
  }

  async exportUserData(userId: string) {
    const settings = await this.getSettings(userId);
    const grants = (this.db.prepare("SELECT grant_json FROM agent_grants WHERE user_id=? ORDER BY created_at").all(userId) as Array<{ grant_json: string }>)
      .map((row) => ({ ...AgentGrantV1Schema.parse(parse(row.grant_json)), messageHash: "[REDACTED]" }));
    const challenges = (this.db.prepare("SELECT challenge_json FROM agent_grant_challenges WHERE user_id=? ORDER BY created_at").all(userId) as Array<{ challenge_json: string }>)
      .map((row) => { const challenge = AgentGrantChallengeSchema.parse(parse(row.challenge_json)); return { id: challenge.id,
        scope: challenge.scope, scopeHash: challenge.scopeHash, grantExpiresAt: challenge.grantExpiresAt,
        expiresAt: challenge.expiresAt, createdAt: challenge.createdAt, consumedAt: challenge.consumedAt }; });
    const triggers = (this.db.prepare("SELECT trigger_json FROM agent_triggers WHERE user_id=? ORDER BY created_at").all(userId) as Array<{ trigger_json: string }>)
      .map((row) => AgentTriggerV1Schema.parse(parse(row.trigger_json)));
    const runs = (await this.listRuns(userId, 10_000)).items;
    const runDetails = await Promise.all(runs.map((run) => this.getRunDetail(userId, run.id)));
    const jobs = (this.db.prepare("SELECT job_json FROM agent_jobs WHERE user_id=? ORDER BY created_at").all(userId) as Array<{ job_json: string }>)
      .map((row) => AgentJobV1Schema.parse(parse(row.job_json)));
    const outcomes = (await this.listOutcomes(userId, 10_000)).items;
    const dailyEquityBaselines = this.db.prepare("SELECT utc_date,equity_cents,captured_at FROM agent_daily_equity_baselines WHERE user_id=? ORDER BY utc_date").all(userId);
    const executionReservations = this.db.prepare("SELECT run_id,event_id,symbol,side,notional_cents,created_at FROM agent_execution_reservations WHERE user_id=? ORDER BY created_at").all(userId);
    const collateralRiskState = await this.getCollateralRiskState(userId);
    return { settings, grants, grantChallenges: challenges, triggers, runs: runDetails.filter(Boolean), jobs,
      outcomes, dailyEquityBaselines, executionReservations, collateralRiskState };
  }
  async deleteUserData(userId: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["agent_outcomes", "agent_execution_reservations", "agent_daily_equity_baselines", "agent_jobs", "agent_run_transitions", "agent_runs", "agent_triggers",
        "agent_collateral_risk_states", "agent_grants", "agent_grant_challenges", "agent_settings"]) this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async prune(now: Date) {
    const thirty = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const year = new Date(now.getTime() - 365 * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM agent_daily_equity_baselines WHERE captured_at<?").run(thirty);
    this.db.prepare("DELETE FROM agent_grant_challenges WHERE expires_at<?").run(now.toISOString());
    this.db.prepare("DELETE FROM agent_jobs WHERE status IN ('COMPLETED','FAILED') AND updated_at<?").run(thirty);
    this.db.prepare("DELETE FROM agent_triggers WHERE created_at<? AND id NOT IN (SELECT trigger_id FROM agent_runs WHERE state NOT IN ('COMPLETED','FAILED_CLOSED','DEDUPLICATED','EXPIRED'))").run(thirty);
    this.db.prepare("DELETE FROM official_event_versions WHERE created_at<? AND version_id NOT IN (SELECT current_version_id FROM official_events)").run(thirty);
    this.db.prepare("DELETE FROM official_events WHERE updated_at<? AND id NOT IN (SELECT event_id FROM agent_runs WHERE state NOT IN ('COMPLETED','FAILED_CLOSED','DEDUPLICATED','EXPIRED') AND event_id IS NOT NULL)").run(thirty);
    this.db.prepare("DELETE FROM official_event_versions WHERE event_id NOT IN (SELECT id FROM official_events)").run();
    this.db.prepare("DELETE FROM agent_outcomes WHERE updated_at<?").run(year);
    this.db.prepare("DELETE FROM agent_runs WHERE terminal_at<?").run(year);
    this.db.prepare("DELETE FROM agent_grants WHERE COALESCE(revoked_at,expires_at)<?").run(year);
  }
  async close() { this.db.close(); }

  private readOfficialEvent(id: string) {
    const row = this.db.prepare(`SELECT v.event_json FROM official_events e JOIN official_event_versions v
      ON v.version_id=e.current_version_id WHERE e.id=?`).get(id) as { event_json: string } | undefined;
    return row ? OfficialEventV1Schema.parse(parse(row.event_json)) : null;
  }
  private readCurrentGrant(userId: string) {
    const row = this.db.prepare("SELECT grant_json FROM agent_grants WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(userId) as { grant_json: string } | undefined;
    return row ? AgentGrantV1Schema.parse(parse(row.grant_json)) : null;
  }
  private readRun(userId: string, runId: string) {
    const row = this.db.prepare("SELECT run_json FROM agent_runs WHERE id=? AND user_id=?").get(runId, userId) as { run_json: string } | undefined;
    return row ? AgentRunV1Schema.parse(parse(row.run_json)) : null;
  }

  private insertRun(run: AgentRunV1) {
    this.db.prepare("INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(run.id, run.traceId, run.triggerId,
      run.userId, run.eventId, run.symbol, run.sourceMode, run.modeAtStart, run.state, run.qualifyingShadowRun ? 1 : 0,
      JSON.stringify(run), run.createdAt, run.updatedAt, run.terminalAt);
  }
  private insertTransition(transition: AgentRunTransitionV1) {
    this.db.prepare("INSERT INTO agent_run_transitions VALUES(?,?,?,?,?,?,?)").run(transition.id, transition.runId,
      transition.userId, transition.traceId, transition.toState, JSON.stringify(transition), transition.createdAt);
  }
  private insertJob(job: AgentJobV1) {
    this.db.prepare("INSERT INTO agent_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(job.id, job.runId, job.userId, job.kind,
      job.status, job.runAt, job.attemptCount, job.workerId, job.leaseExpiresAt, job.lastErrorCode, JSON.stringify(job), job.createdAt, job.updatedAt);
  }
  private finishJob(jobId: string, workerId: string, status: "COMPLETED" | "FAILED", errorCode: string | null, now: Date) {
    const row = this.db.prepare("SELECT job_json FROM agent_jobs WHERE id=? AND worker_id=? AND status='LEASED'").get(jobId, workerId) as { job_json: string } | undefined;
    if (!row) throw new Error("AGENT_JOB_LEASE_LOST");
    const job = AgentJobV1Schema.parse({ ...parse<AgentJobV1>(row.job_json), status, workerId: null,
      leaseExpiresAt: null, lastErrorCode: errorCode, updatedAt: now.toISOString() });
    this.db.prepare("UPDATE agent_jobs SET status=?,worker_id=NULL,lease_expires_at=NULL,last_error_code=?,job_json=?,updated_at=? WHERE id=? AND worker_id=? AND status='LEASED'")
      .run(status, errorCode, JSON.stringify(job), job.updatedAt, jobId, workerId);
  }
}

function iso(value: unknown) { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }

export class PostgresAgentRepository implements AgentRepository {
  readonly pool: Pool;
  constructor(connectionString: string, options: { max?: number; ssl?: boolean } = {}) {
    this.pool = new Pool({ connectionString, max: options.max ?? 10, idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000, ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}) });
    // Prevent an idle connection terminated during a database restart from
    // becoming an uncaught EventEmitter error. Individual operations continue
    // to reject, so agent execution and readiness still fail closed.
    this.pool.on("error", () => undefined);
  }
  async init() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock($1)", [8675310]);
      await client.query(agentSchemaSql);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING", [agentSchemaVersion]);
      await client.query("COMMIT");
    } catch (error) { await this.rollback(client); throw error; } finally { client.release(); }
  }
  async ready() { try { return (await this.pool.query("SELECT 1 FROM agent_jobs LIMIT 1")).rowCount !== null; } catch { return false; } }

  async saveOfficialEvent(event: OfficialEventV1) {
    OfficialEventV1Schema.parse(event); const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = (await client.query("SELECT * FROM official_events WHERE source_type=$1 AND accession_id=$2 FOR UPDATE", [event.sourceType, event.accessionId])).rows[0];
      if (existing?.current_content_hash === event.contentHash) {
        const stored = await this.pgEvent(client, String(existing.id)); await client.query("COMMIT");
        return { created: false, changed: false, event: stored ?? event };
      }
      const storedEvent = existing ? { ...event, id: String(existing.id),
        cautionFlags: [...new Set([...event.cautionFlags, "CORRECTION" as const])] } : event;
      if (!existing) await client.query(`INSERT INTO official_events(id,symbol,source_type,accession_id,current_version_id,current_content_hash,
        superseded_by_event_id,detected_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [storedEvent.id,
        storedEvent.symbol, storedEvent.sourceType, storedEvent.accessionId, storedEvent.versionId, storedEvent.contentHash,
        storedEvent.supersededByEventId, storedEvent.detectedAt]);
      else await client.query(`UPDATE official_events SET symbol=$1,current_version_id=$2,current_content_hash=$3,
        superseded_by_event_id=$4,updated_at=$5 WHERE id=$6`, [storedEvent.symbol, storedEvent.versionId, storedEvent.contentHash,
        storedEvent.supersededByEventId, storedEvent.detectedAt, storedEvent.id]);
      await client.query(`INSERT INTO official_event_versions(version_id,event_id,content_hash,document_hash,published_at,event_json,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id,content_hash) DO NOTHING`, [storedEvent.versionId, storedEvent.id, storedEvent.contentHash,
        storedEvent.documentHash, storedEvent.publishedAt, storedEvent, storedEvent.detectedAt]);
      const persisted = await this.pgEvent(client, storedEvent.id);
      await client.query("COMMIT"); return { created: !existing, changed: Boolean(existing), event: persisted ?? storedEvent };
    } catch (error) { await this.rollback(client); throw error; } finally { client.release(); }
  }
  async getOfficialEvent(id: string) { return this.pgEvent(this.pool, id); }
  async listOfficialEvents(since: string, limit = 100) {
    const rows = (await this.pool.query(`SELECT v.event_json FROM official_events e JOIN official_event_versions v
      ON v.version_id=e.current_version_id WHERE e.detected_at>=$1 ORDER BY e.detected_at LIMIT $2`, [since, limit])).rows;
    return rows.map((row) => OfficialEventV1Schema.parse(parse(row.event_json)));
  }

  async getSettings(userId: string) {
    const row = (await this.pool.query("SELECT settings_json FROM agent_settings WHERE user_id=$1", [userId])).rows[0];
    return row ? AgentSettingsV1Schema.parse(parse(row.settings_json)) : null;
  }
  async saveSettings(settings: AgentSettingsV1) {
    AgentSettingsV1Schema.parse(settings);
    await this.pool.query(`INSERT INTO agent_settings(user_id,mode,settings_version,shadow_started_at,settings_json,updated_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,
      settings_version=excluded.settings_version,shadow_started_at=excluded.shadow_started_at,
      settings_json=excluded.settings_json,updated_at=excluded.updated_at`, [settings.userId, settings.mode,
      settings.settingsVersion, settings.shadowStartedAt, settings, settings.updatedAt]);
  }
  async listEnabledSettings() {
    return (await this.pool.query("SELECT settings_json FROM agent_settings WHERE mode<>'DISABLED' ORDER BY updated_at")).rows
      .map((row) => AgentSettingsV1Schema.parse(parse(row.settings_json)));
  }

  async getCollateralRiskState(userId: string) {
    const row = (await this.pool.query(`SELECT settings_version,phase,episode_key,last_band_pct,updated_at
      FROM agent_collateral_risk_states WHERE user_id=$1`, [userId])).rows[0];
    return row ? { userId, settingsVersion: String(row.settings_version), phase: row.phase as "ARMED" | "ACTIVE",
      episodeKey: String(row.episode_key), lastBandPct: row.last_band_pct === null ? null : Number(row.last_band_pct),
      updatedAt: iso(row.updated_at) } : null;
  }

  async saveCollateralRiskState(state: CollateralRiskState) {
    assertCollateralRiskState(state);
    await this.pool.query(`INSERT INTO agent_collateral_risk_states(user_id,settings_version,phase,episode_key,last_band_pct,updated_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET settings_version=excluded.settings_version,
      phase=excluded.phase,episode_key=excluded.episode_key,last_band_pct=excluded.last_band_pct,updated_at=excluded.updated_at`,
    [state.userId, state.settingsVersion, state.phase, state.episodeKey, state.lastBandPct, state.updatedAt]);
  }

  async saveGrantChallenge(challenge: AgentGrantChallenge) {
    AgentGrantChallengeSchema.parse(challenge);
    await this.pool.query(`INSERT INTO agent_grant_challenges(id,user_id,nonce,scope_hash,expires_at,consumed_at,challenge_json,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [challenge.id, challenge.userId, challenge.nonce, challenge.scopeHash,
      challenge.expiresAt, challenge.consumedAt, challenge, challenge.createdAt]);
  }
  async consumeGrantChallenge(id: string, userId: string, now: Date) {
    const result = await this.pool.query(`UPDATE agent_grant_challenges SET consumed_at=$3,
      challenge_json=jsonb_set(challenge_json,'{consumedAt}',to_jsonb($4::text)) WHERE id=$1 AND user_id=$2
      AND consumed_at IS NULL AND expires_at>$3 RETURNING challenge_json`, [id, userId, now.toISOString(), now.toISOString()]);
    return result.rows[0] ? AgentGrantChallengeSchema.parse(parse(result.rows[0].challenge_json)) : null;
  }
  async saveGrant(grant: AgentGrantV1) {
    AgentGrantV1Schema.parse(grant); const client = await this.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [grant.userId]);
      const current = (await client.query("SELECT id,grant_json FROM agent_grants WHERE user_id=$1 AND revoked_at IS NULL FOR UPDATE", [grant.userId])).rows[0];
      if (current) { const revoked = revisedGrant(parse(current.grant_json), "RENEWED", new Date(grant.issuedAt));
        await client.query("UPDATE agent_grants SET revoked_at=$1,grant_json=$2 WHERE id=$3", [revoked.revokedAt, revoked, current.id]); }
      await client.query(`INSERT INTO agent_grants(id,user_id,message_hash,expires_at,revoked_at,grant_json,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [grant.id, grant.userId, grant.messageHash, grant.expiresAt, grant.revokedAt, grant, grant.issuedAt]);
      await client.query("COMMIT");
    } catch (error) { await this.rollback(client); throw error; } finally { client.release(); }
  }
  async getCurrentGrant(userId: string) {
    const row = (await this.pool.query("SELECT grant_json FROM agent_grants WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", [userId])).rows[0];
    return row ? AgentGrantV1Schema.parse(parse(row.grant_json)) : null;
  }
  async revokeCurrentGrant(userId: string, reason: string, now: Date) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT id,grant_json FROM agent_grants WHERE user_id=$1 AND revoked_at IS NULL FOR UPDATE", [userId])).rows[0];
      if (!row) { await client.query("COMMIT"); return null; }
      const revoked = revisedGrant(parse(row.grant_json), reason, now);
      await client.query("UPDATE agent_grants SET revoked_at=$1,grant_json=$2 WHERE id=$3", [revoked.revokedAt, revoked, row.id]);
      await client.query("COMMIT"); return revoked;
    } catch (error) { await this.rollback(client); throw error; } finally { client.release(); }
  }
  async listExpiringGrants(before: string) {
    return (await this.pool.query("SELECT grant_json FROM agent_grants WHERE revoked_at IS NULL AND expires_at<=$1 ORDER BY expires_at", [before])).rows
      .map((row) => AgentGrantV1Schema.parse(parse(row.grant_json)));
  }

  async createRunBundle(trigger: AgentTriggerV1, run: AgentRunV1, job: AgentJobV1, transition: AgentRunTransitionV1) {
    assertRunBundle(trigger, run, job, transition);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(`INSERT INTO agent_triggers(id,user_id,event_id,symbol,trigger_type,source_mode,dedupe_key,trigger_json,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`, [trigger.id,
        trigger.userId, trigger.eventId, trigger.symbol, trigger.type, trigger.sourceMode, trigger.dedupeKey, trigger, trigger.createdAt]);
      if (!inserted.rows[0]) {
        const existing = (await client.query(`SELECT r.run_json FROM agent_triggers t JOIN agent_runs r ON r.trigger_id=t.id
          WHERE t.dedupe_key=$1`, [trigger.dedupeKey])).rows[0];
        await client.query("COMMIT");
        if (!existing) throw new Error("AGENT_RUN_DEDUPE_IN_PROGRESS");
        return { created: false, run: AgentRunV1Schema.parse(parse(existing.run_json)) };
      }
      await client.query(`INSERT INTO agent_runs(id,trace_id,trigger_id,user_id,event_id,symbol,source_mode,mode_at_start,state,
        qualifying_shadow_run,run_json,created_at,updated_at,terminal_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [run.id, run.traceId, run.triggerId, run.userId, run.eventId, run.symbol, run.sourceMode, run.modeAtStart, run.state,
        run.qualifyingShadowRun, run, run.createdAt, run.updatedAt, run.terminalAt]);
      await client.query(`INSERT INTO agent_run_transitions(id,run_id,user_id,trace_id,to_state,transition_json,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [transition.id, transition.runId, transition.userId, transition.traceId,
        transition.toState, transition, transition.createdAt]);
      await this.pgInsertJob(client, job); await client.query("COMMIT"); return { created: true, run };
    } catch (error) { await this.rollback(client); throw error; } finally { client.release(); }
  }
  async getTrigger(userId: string, triggerId: string) {
    const row = (await this.pool.query("SELECT trigger_json FROM agent_triggers WHERE id=$1 AND user_id=$2", [triggerId, userId])).rows[0];
    return row ? parse<AgentTriggerV1>(row.trigger_json) : null;
  }

  async getRun(userId: string, runId: string) {
    const row = (await this.pool.query("SELECT run_json FROM agent_runs WHERE id=$1 AND user_id=$2", [runId, userId])).rows[0];
    return row ? AgentRunV1Schema.parse(parse(row.run_json)) : null;
  }
  async listRuns(userId: string, limit: number, cursor?: string) {
    const after = cursorParts(cursor);
    const result = after
      ? await this.pool.query(`SELECT run_json FROM agent_runs WHERE user_id=$1 AND (created_at<$2 OR (created_at=$2 AND id<$3))
          ORDER BY created_at DESC,id DESC LIMIT $4`, [userId, after.at, after.id, limit])
      : await this.pool.query("SELECT run_json FROM agent_runs WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2", [userId, limit]);
    const items = result.rows.map((row) => AgentRunV1Schema.parse(parse(row.run_json)));
    return { items, nextCursor: nextCursor(items, limit) };
  }
  async listRecentRuns(userId: string, symbol: ProductionSymbol, since: string, limit = 100) {
    return (await this.pool.query(`SELECT run_json FROM agent_runs WHERE user_id=$1 AND symbol=$2 AND created_at>=$3
      ORDER BY created_at DESC LIMIT $4`, [userId, symbol, since, limit])).rows.map((row) => AgentRunV1Schema.parse(parse(row.run_json)));
  }
  async countQualifyingRuns(userId: string, since: string) {
    const row = (await this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM agent_runs
      WHERE user_id=$1 AND qualifying_shadow_run=true AND created_at>=$2`, [userId, since])).rows[0];
    return Number(row?.count ?? 0);
  }
  async transitionRun(userId: string, runId: string, to: AgentRunState, reasonCode: string, patch: AgentRunPatch = {},
    metadata: AgentRunTransitionV1["metadata"] = {}, now = new Date()) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT run_json FROM agent_runs WHERE id=$1 AND user_id=$2 FOR UPDATE", [runId, userId])).rows[0];
      if (!row) throw new Error("AGENT_RUN_NOT_FOUND");
      const current = AgentRunV1Schema.parse(parse(row.run_json));
      if (patch.qualifyingShadowRun && (current.sourceMode !== "LIVE_BITGET" || current.analystOrigin !== "QWEN" ||
        current.modeAtStart === "PAPER_AUTO" || !["SHADOW_COMPLETE", "ALERTED", "BLOCKED"].includes(to))) {
        throw new Error("AGENT_QUALIFYING_RUN_INVALID");
      }
      const updated = mergeRun(current, to, patch, now);
      const transition = AgentRunTransitionV1Schema.parse({ version: 1, id: crypto.randomUUID(), runId, userId,
        traceId: current.traceId, fromState: current.state, toState: to, reasonCode, metadata, createdAt: now.toISOString() });
      await client.query(`UPDATE agent_runs SET state=$1,qualifying_shadow_run=$2,run_json=$3,updated_at=$4,terminal_at=$5
        WHERE id=$6 AND user_id=$7`, [updated.state, updated.qualifyingShadowRun, updated, updated.updatedAt, updated.terminalAt, runId, userId]);
      await client.query(`INSERT INTO agent_run_transitions(id,run_id,user_id,trace_id,to_state,transition_json,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [transition.id, runId, userId, current.traceId, to, transition, transition.createdAt]);
      await client.query("COMMIT"); return updated;
    } catch (error) { await this.rollback(client); throw error; } finally { client.release(); }
  }
  async getRunDetail(userId: string, runId: string) {
    const run = await this.getRun(userId, runId); if (!run) return null;
    const transitions = (await this.pool.query("SELECT transition_json FROM agent_run_transitions WHERE run_id=$1 AND user_id=$2 ORDER BY created_at,id", [runId, userId])).rows
      .map((row) => AgentRunTransitionV1Schema.parse(parse(row.transition_json)));
    return { ...run, transitions: orderedTransitions(transitions), outcome: await this.getOutcome(runId, userId) };
  }

  async enqueueJob(job: AgentJobV1) { AgentJobV1Schema.parse(job); return Boolean((await this.pgInsertJob(this.pool, job)).rowCount); }
  async claimJob(workerId: string, now: Date, leaseMs: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE agent_jobs SET status='QUEUED',worker_id=NULL,lease_expires_at=NULL,updated_at=$1,
        job_json=job_json || jsonb_build_object('status','QUEUED','workerId',NULL,'leaseExpiresAt',NULL,'updatedAt',$2::text)
        WHERE status='LEASED' AND lease_expires_at<=$1`, [now.toISOString(), now.toISOString()]);
      const row = (await client.query(`SELECT * FROM agent_jobs WHERE status='QUEUED' AND run_at<=$1
        ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [now.toISOString()])).rows[0];
      if (!row) { await client.query("COMMIT"); return null; }
      const job = AgentJobV1Schema.parse(parse(row.job_json));
      const leased = AgentJobV1Schema.parse({ ...job, status: "LEASED", attemptCount: job.attemptCount + 1, workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(), updatedAt: now.toISOString() });
      await client.query(`UPDATE agent_jobs SET status='LEASED',attempt_count=$1,worker_id=$2,lease_expires_at=$3,
        job_json=$4,updated_at=$5 WHERE id=$6`, [leased.attemptCount, workerId, leased.leaseExpiresAt, leased, leased.updatedAt, leased.id]);
      await client.query("COMMIT"); return leased;
    } catch (error) { await this.rollback(client); throw error; } finally { client.release(); }
  }
  async heartbeatJob(jobId: string, workerId: string, now: Date, leaseMs: number) {
    const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const result = await this.pool.query(`UPDATE agent_jobs SET lease_expires_at=$1,updated_at=$2,
      job_json=job_json || jsonb_build_object('leaseExpiresAt',$5::text,'updatedAt',$6::text)
      WHERE id=$3 AND worker_id=$4 AND status='LEASED'`,
      [expiresAt, now.toISOString(), jobId, workerId, expiresAt, now.toISOString()]);
    return result.rowCount === 1;
  }
  async completeJob(jobId: string, workerId: string, now: Date) { await this.pgFinishJob(jobId, workerId, "COMPLETED", null, now); }
  async retryJob(jobId: string, workerId: string, runAt: Date, errorCode: string, now: Date) {
    const result = await this.pool.query(`UPDATE agent_jobs SET status='QUEUED',run_at=$1,worker_id=NULL,lease_expires_at=NULL,
      last_error_code=$2,updated_at=$3,job_json=job_json || jsonb_build_object('status','QUEUED','runAt',$6::text,
      'workerId',NULL,'leaseExpiresAt',NULL,'lastErrorCode',$2,'updatedAt',$7::text) WHERE id=$4 AND worker_id=$5 AND status='LEASED'`,
      [runAt.toISOString(), errorCode, now.toISOString(), jobId, workerId, runAt.toISOString(), now.toISOString()]);
    if (result.rowCount !== 1) throw new Error("AGENT_JOB_LEASE_LOST");
  }
  async failJob(jobId: string, workerId: string, errorCode: string, now: Date) { await this.pgFinishJob(jobId, workerId, "FAILED", errorCode, now); }
  async heartbeatWorker(workerId: string, now: Date, metadata: Record<string, unknown> = {}) {
    await this.pool.query(`INSERT INTO agent_worker_heartbeats(worker_id,heartbeat_at,metadata_json) VALUES($1,$2,$3)
      ON CONFLICT(worker_id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,metadata_json=excluded.metadata_json`, [workerId, now.toISOString(), metadata]);
  }
  async latestWorkerHeartbeat() {
    const row = (await this.pool.query("SELECT heartbeat_at FROM agent_worker_heartbeats ORDER BY heartbeat_at DESC LIMIT 1")).rows[0];
    return row ? iso(row.heartbeat_at) : null;
  }
  async queueStats(now: Date) {
    const row = (await this.pool.query(`SELECT COUNT(*) FILTER(WHERE status='QUEUED' AND run_at<=$1)::text AS runnable,
      COUNT(*) FILTER(WHERE status='LEASED')::text AS leased,
      MIN(run_at) FILTER(WHERE status='QUEUED' AND run_at<=$1) AS oldest FROM agent_jobs`, [now.toISOString()])).rows[0];
    return { runnable: Number(row?.runnable ?? 0), leased: Number(row?.leased ?? 0),
      oldestRunnableAgeMs: row?.oldest ? Math.max(0, now.getTime() - new Date(row.oldest).getTime()) : 0 };
  }

  async getOrCreateDailyEquityBaseline(userId: string, utcDate: string, equityCents: number, capturedAt: string) {
    const row = (await this.pool.query("INSERT INTO agent_daily_equity_baselines(user_id,utc_date,equity_cents,captured_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,utc_date) DO UPDATE SET user_id=excluded.user_id RETURNING equity_cents", [userId, utcDate, equityCents, capturedAt])).rows[0];
    return Number(row.equity_cents);
  }
  async reserveAutomaticExecution(reservation: AgentExecutionReservation, limits: { count: number; grossNewNotionalCents: number; cooldownMs: number }) {
    assertExecutionReservation(reservation, limits);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [reservation.userId]);
      const boundRun = (await client.query("SELECT user_id,event_id,symbol FROM agent_runs WHERE id=$1 AND user_id=$2", [reservation.runId, reservation.userId])).rows[0];
      if (!boundRun || boundRun.symbol !== reservation.symbol || (boundRun.event_id ?? null) !== reservation.eventId) throw new Error("AGENT_EXECUTION_RUN_BINDING_INVALID");
      const existing = (await client.query("SELECT run_id FROM agent_execution_reservations WHERE run_id=$1", [reservation.runId])).rows[0];
      const since = new Date(Date.UTC(new Date(reservation.createdAt).getUTCFullYear(), new Date(reservation.createdAt).getUTCMonth(), new Date(reservation.createdAt).getUTCDate())).toISOString();
      const usageRow = (await client.query("SELECT COUNT(*)::text AS count,COALESCE(SUM(CASE WHEN side='buy' THEN notional_cents ELSE 0 END),0)::text AS gross FROM agent_execution_reservations WHERE user_id=$1 AND created_at>=$2", [reservation.userId, since])).rows[0];
      const current = { count: Number(usageRow?.count ?? 0), grossNewNotionalCents: Number(usageRow?.gross ?? 0) };
      if (existing) { await client.query("COMMIT"); return { created: false, usage: current }; }
      if (current.count >= limits.count) throw new Error("AGENT_DAILY_ORDER_LIMIT");
      if (reservation.side === "buy" && current.grossNewNotionalCents + reservation.notionalCents > limits.grossNewNotionalCents) throw new Error("AGENT_DAILY_NOTIONAL_LIMIT");
      if (reservation.eventId && (await client.query("SELECT 1 FROM agent_execution_reservations WHERE user_id=$1 AND event_id=$2", [reservation.userId, reservation.eventId])).rows[0]) throw new Error("AGENT_EVENT_ALREADY_ACTIONED");
      const cooldown = new Date(new Date(reservation.createdAt).getTime() - limits.cooldownMs).toISOString();
      if ((await client.query("SELECT 1 FROM agent_execution_reservations WHERE user_id=$1 AND symbol=$2 AND created_at>=$3", [reservation.userId, reservation.symbol, cooldown])).rows[0]) throw new Error("AGENT_SYMBOL_COOLDOWN");
      await client.query("INSERT INTO agent_execution_reservations(run_id,user_id,event_id,symbol,side,notional_cents,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [reservation.runId, reservation.userId, reservation.eventId, reservation.symbol, reservation.side, reservation.notionalCents, reservation.createdAt]);
      await client.query("COMMIT");
      return { created: true, usage: { count: current.count + 1, grossNewNotionalCents: current.grossNewNotionalCents + (reservation.side === "buy" ? reservation.notionalCents : 0) } };
    } catch (error) { await this.rollback(client); throw error; } finally { client.release(); }
  }
  async getAutomaticUsage(userId: string, since: string) {
    const row = (await this.pool.query("SELECT COUNT(*)::text AS count,COALESCE(SUM(CASE WHEN side='buy' THEN notional_cents ELSE 0 END),0)::text AS gross FROM agent_execution_reservations WHERE user_id=$1 AND created_at>=$2", [userId, since])).rows[0];
    return { count: Number(row?.count ?? 0), grossNewNotionalCents: Number(row?.gross ?? 0) };
  }

  async saveOutcome(outcome: AgentOutcomeV1) {
    AgentOutcomeV1Schema.parse(outcome); const updated = outcome.scoredAt ?? new Date().toISOString();
    const result = await this.pool.query(`INSERT INTO agent_outcomes(id,run_id,user_id,status,observation_due_at,outcome_json,created_at,updated_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$7 WHERE EXISTS(SELECT 1 FROM agent_runs WHERE id=$2 AND user_id=$3)
      ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,observation_due_at=excluded.observation_due_at,
      outcome_json=excluded.outcome_json,updated_at=excluded.updated_at WHERE agent_outcomes.user_id=excluded.user_id RETURNING id`,
      [outcome.id, outcome.runId, outcome.userId, outcome.status, outcome.observationDueAt, outcome, updated]);
    if (result.rowCount !== 1) throw new Error("AGENT_OUTCOME_TENANT_MISMATCH");
  }
  async getOutcome(runId: string, userId: string) {
    const row = (await this.pool.query("SELECT outcome_json FROM agent_outcomes WHERE run_id=$1 AND user_id=$2", [runId, userId])).rows[0];
    return row ? AgentOutcomeV1Schema.parse(parse(row.outcome_json)) : null;
  }
  async listOutcomes(userId: string, limit: number, cursor?: string) {
    const after = cursorParts(cursor);
    const result = after
      ? await this.pool.query(`SELECT outcome_json FROM agent_outcomes WHERE user_id=$1 AND
          (observation_due_at<$2 OR (observation_due_at=$2 AND id<$3)) ORDER BY observation_due_at DESC,id DESC LIMIT $4`, [userId, after.at, after.id, limit])
      : await this.pool.query("SELECT outcome_json FROM agent_outcomes WHERE user_id=$1 ORDER BY observation_due_at DESC,id DESC LIMIT $2", [userId, limit]);
    const items = result.rows.map((row) => AgentOutcomeV1Schema.parse(parse(row.outcome_json)));
    return { items, nextCursor: nextCursor(items, limit) };
  }

  async exportUserData(userId: string) {
    const settings = await this.getSettings(userId);
    const grants = (await this.pool.query("SELECT grant_json FROM agent_grants WHERE user_id=$1 ORDER BY created_at", [userId])).rows
      .map((row) => ({ ...AgentGrantV1Schema.parse(parse(row.grant_json)), messageHash: "[REDACTED]" }));
    const challenges = (await this.pool.query("SELECT challenge_json FROM agent_grant_challenges WHERE user_id=$1 ORDER BY created_at", [userId])).rows
      .map((row) => { const challenge = AgentGrantChallengeSchema.parse(parse(row.challenge_json)); return { id: challenge.id,
        scope: challenge.scope, scopeHash: challenge.scopeHash, grantExpiresAt: challenge.grantExpiresAt,
        expiresAt: challenge.expiresAt, createdAt: challenge.createdAt, consumedAt: challenge.consumedAt }; });
    const triggers = (await this.pool.query("SELECT trigger_json FROM agent_triggers WHERE user_id=$1 ORDER BY created_at", [userId])).rows
      .map((row) => AgentTriggerV1Schema.parse(parse(row.trigger_json)));
    const runs = (await this.listRuns(userId, 10_000)).items;
    const runDetails = await Promise.all(runs.map((run) => this.getRunDetail(userId, run.id)));
    const jobs = (await this.pool.query("SELECT job_json FROM agent_jobs WHERE user_id=$1 ORDER BY created_at", [userId])).rows
      .map((row) => AgentJobV1Schema.parse(parse(row.job_json)));
    const outcomes = (await this.listOutcomes(userId, 10_000)).items;
    const dailyEquityBaselines = (await this.pool.query("SELECT utc_date,equity_cents,captured_at FROM agent_daily_equity_baselines WHERE user_id=$1 ORDER BY utc_date", [userId])).rows;
    const executionReservations = (await this.pool.query("SELECT run_id,event_id,symbol,side,notional_cents,created_at FROM agent_execution_reservations WHERE user_id=$1 ORDER BY created_at", [userId])).rows;
    const collateralRiskState = await this.getCollateralRiskState(userId);
    return { settings, grants, grantChallenges: challenges, triggers, runs: runDetails.filter(Boolean), jobs,
      outcomes, dailyEquityBaselines, executionReservations, collateralRiskState };
  }
  async deleteUserData(userId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const table of ["agent_outcomes", "agent_execution_reservations", "agent_daily_equity_baselines", "agent_jobs", "agent_run_transitions", "agent_runs", "agent_triggers",
        "agent_collateral_risk_states", "agent_grants", "agent_grant_challenges", "agent_settings"]) await client.query(`DELETE FROM ${table} WHERE user_id=$1`, [userId]);
      await client.query("COMMIT");
    } catch (error) { await this.rollback(client); throw error; } finally { client.release(); }
  }
  async prune(now: Date) {
    const thirty = new Date(now.getTime() - 30 * 86_400_000); const year = new Date(now.getTime() - 365 * 86_400_000);
    await this.pool.query("DELETE FROM agent_daily_equity_baselines WHERE captured_at<$1", [thirty]);
    await this.pool.query("DELETE FROM agent_grant_challenges WHERE expires_at<$1", [now]);
    await this.pool.query("DELETE FROM agent_jobs WHERE status IN ('COMPLETED','FAILED') AND updated_at<$1", [thirty]);
    await this.pool.query("DELETE FROM agent_triggers WHERE created_at<$1 AND id NOT IN(SELECT trigger_id FROM agent_runs WHERE state NOT IN ('COMPLETED','FAILED_CLOSED','DEDUPLICATED','EXPIRED'))", [thirty]);
    await this.pool.query("DELETE FROM official_event_versions WHERE created_at<$1 AND version_id NOT IN(SELECT current_version_id FROM official_events)", [thirty]);
    await this.pool.query("DELETE FROM official_events WHERE updated_at<$1 AND id NOT IN(SELECT event_id FROM agent_runs WHERE state NOT IN ('COMPLETED','FAILED_CLOSED','DEDUPLICATED','EXPIRED') AND event_id IS NOT NULL)", [thirty]);
    await this.pool.query("DELETE FROM agent_outcomes WHERE updated_at<$1", [year]);
    await this.pool.query("DELETE FROM agent_runs WHERE terminal_at<$1", [year]);
    await this.pool.query("DELETE FROM agent_grants WHERE COALESCE(revoked_at,expires_at)<$1", [year]);
  }
  async close() { await this.pool.end(); }

  private async pgEvent(client: Pick<Pool, "query"> | Pick<PoolClient, "query">, id: string) {
    const row = (await client.query(`SELECT v.event_json FROM official_events e JOIN official_event_versions v
      ON v.version_id=e.current_version_id WHERE e.id=$1`, [id])).rows[0];
    return row ? OfficialEventV1Schema.parse(parse(row.event_json)) : null;
  }
  private pgInsertJob(client: Pick<Pool, "query"> | Pick<PoolClient, "query">, job: AgentJobV1) {
    return client.query(`INSERT INTO agent_jobs(id,run_id,user_id,kind,status,run_at,attempt_count,worker_id,lease_expires_at,
      last_error_code,job_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(run_id,kind,run_at) DO NOTHING`, [job.id, job.runId, job.userId, job.kind, job.status, job.runAt,
      job.attemptCount, job.workerId, job.leaseExpiresAt, job.lastErrorCode, job, job.createdAt, job.updatedAt]);
  }
  private async pgFinishJob(jobId: string, workerId: string, status: "COMPLETED" | "FAILED", errorCode: string | null, now: Date) {
    const result = await this.pool.query(`UPDATE agent_jobs SET status=$1,worker_id=NULL,lease_expires_at=NULL,last_error_code=$2,
      updated_at=$3,job_json=job_json || jsonb_build_object('status',$1::text,'workerId',NULL,'leaseExpiresAt',NULL,
      'lastErrorCode',$2::text,'updatedAt',$6::text) WHERE id=$4 AND worker_id=$5 AND status='LEASED'`,
      [status, errorCode, now.toISOString(), jobId, workerId, now.toISOString()]);
    if (result.rowCount !== 1) throw new Error("AGENT_JOB_LEASE_LOST");
  }
  private async rollback(client: PoolClient) { try { await client.query("ROLLBACK"); } catch { /* discard unusable connection */ } }
}
