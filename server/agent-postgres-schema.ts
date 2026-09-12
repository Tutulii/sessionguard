export const agentSchemaVersion = "0004-canonical-job-timestamps";

export const agentSchemaSql = `
CREATE TABLE IF NOT EXISTS official_events (
  id uuid PRIMARY KEY,
  symbol text NOT NULL CHECK (symbol IN ('RNVDAUSDT','RTSLAUSDT','RORCLUSDT')),
  source_type text NOT NULL CHECK (source_type IN ('SEC_EDGAR','ISSUER_IR')),
  accession_id text NOT NULL,
  current_version_id uuid NOT NULL,
  current_content_hash text NOT NULL,
  superseded_by_event_id uuid,
  detected_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(source_type,accession_id)
);
CREATE TABLE IF NOT EXISTS official_event_versions (
  version_id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES official_events(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  document_hash text NOT NULL,
  published_at timestamptz NOT NULL,
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(event_id,content_hash)
);
ALTER TABLE official_events DROP CONSTRAINT IF EXISTS official_events_current_version_fk;
ALTER TABLE official_events ADD CONSTRAINT official_events_current_version_fk
  FOREIGN KEY(current_version_id) REFERENCES official_event_versions(version_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX IF NOT EXISTS official_events_symbol_detected_idx ON official_events(symbol,detected_at DESC);

CREATE TABLE IF NOT EXISTS agent_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('DISABLED','SHADOW','ALERT_ONLY','PAPER_AUTO')),
  settings_version text NOT NULL,
  shadow_started_at timestamptz,
  settings_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_settings_enabled_idx ON agent_settings(mode,updated_at);

CREATE TABLE IF NOT EXISTS agent_collateral_risk_states (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_version text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('ARMED','ACTIVE')),
  episode_key text NOT NULL,
  last_band_pct integer,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_grant_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nonce text NOT NULL UNIQUE,
  scope_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  challenge_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  grant_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_grants_one_active_idx ON agent_grants(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_grants_expiry_idx ON agent_grants(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_triggers (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id uuid REFERENCES official_events(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  trigger_type text NOT NULL,
  source_mode text NOT NULL CHECK (source_mode IN ('LIVE_BITGET','LOCAL_REPLAY')),
  dedupe_key text NOT NULL UNIQUE,
  trigger_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY,
  trace_id uuid NOT NULL UNIQUE,
  trigger_id uuid UNIQUE REFERENCES agent_triggers(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id uuid REFERENCES official_events(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  source_mode text NOT NULL CHECK (source_mode IN ('LIVE_BITGET','LOCAL_REPLAY')),
  mode_at_start text NOT NULL,
  state text NOT NULL,
  qualifying_shadow_run boolean NOT NULL DEFAULT false,
  run_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  terminal_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_runs_user_cursor_idx ON agent_runs(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS agent_runs_eligibility_idx ON agent_runs(user_id,qualifying_shadow_run,created_at);
CREATE INDEX IF NOT EXISTS agent_runs_symbol_recent_idx ON agent_runs(user_id,symbol,created_at DESC);
CREATE TABLE IF NOT EXISTS agent_run_transitions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trace_id uuid NOT NULL,
  to_state text NOT NULL,
  transition_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(run_id,to_state,created_at)
);
CREATE INDEX IF NOT EXISTS agent_transitions_run_idx ON agent_run_transitions(run_id,created_at,id);

CREATE TABLE IF NOT EXISTS agent_jobs (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED','LEASED','COMPLETED','FAILED')),
  run_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  worker_id text,
  lease_expires_at timestamptz,
  last_error_code text,
  job_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(run_id,kind,run_at)
);
CREATE INDEX IF NOT EXISTS agent_jobs_claim_idx ON agent_jobs(status,run_at,lease_expires_at);
-- Timestamp parameters shared with timestamptz columns are rendered by
-- PostgreSQL with a space and offset when cast back to text. Canonicalize the
-- durable JSON projection so strict ISO schema parsing survives leases,
-- retries, completion, and upgrades from earlier releases.
UPDATE agent_jobs SET job_json=job_json || jsonb_build_object(
  'status',status,
  'runAt',to_char(run_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'attemptCount',attempt_count,'workerId',worker_id,
  'leaseExpiresAt',CASE WHEN lease_expires_at IS NULL THEN NULL ELSE to_char(lease_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
  'lastErrorCode',last_error_code,
  'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);


CREATE TABLE IF NOT EXISTS agent_daily_equity_baselines (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  utc_date date NOT NULL,
  equity_cents integer NOT NULL CHECK (equity_cents > 0),
  captured_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,utc_date)
);
CREATE TABLE IF NOT EXISTS agent_execution_reservations (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id uuid REFERENCES official_events(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  notional_cents integer NOT NULL CHECK (notional_cents > 0),
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_execution_one_event_idx ON agent_execution_reservations(user_id,event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_execution_daily_idx ON agent_execution_reservations(user_id,created_at);
CREATE INDEX IF NOT EXISTS agent_execution_symbol_cooldown_idx ON agent_execution_reservations(user_id,symbol,created_at DESC);

CREATE TABLE IF NOT EXISTS agent_outcomes (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL,
  observation_due_at timestamptz NOT NULL,
  outcome_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_outcomes_user_cursor_idx ON agent_outcomes(user_id,observation_due_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS agent_outcomes_due_idx ON agent_outcomes(status,observation_due_at);

CREATE TABLE IF NOT EXISTS agent_worker_heartbeats (
  worker_id text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL,
  metadata_json jsonb NOT NULL
);
`;
