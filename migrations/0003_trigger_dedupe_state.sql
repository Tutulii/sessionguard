-- Durable collateral-risk episode state for semantic trigger deduplication.
-- Additive and idempotent; existing run evidence remains immutable.
BEGIN;

CREATE TABLE IF NOT EXISTS agent_collateral_risk_states (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_version text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('ARMED','ACTIVE')),
  episode_key text NOT NULL,
  last_band_pct integer,
  updated_at timestamptz NOT NULL
);

INSERT INTO schema_migrations(version) VALUES ('0003-trigger-dedupe-state') ON CONFLICT DO NOTHING;
COMMIT;
