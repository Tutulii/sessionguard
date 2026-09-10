-- SessionGuard production schema. Runtime applies the equivalent idempotent SQL
-- exported by server/postgres-schema.ts and records this migration version.
-- This file is intentionally kept as a reviewable deployment artifact.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, address text NOT NULL UNIQUE, chain_id integer NOT NULL CHECK (chain_id = 42161), created_at timestamptz NOT NULL, last_login_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS wallets (address text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, chain_id integer NOT NULL CHECK (chain_id = 42161), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bitget_connections (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, envelope_json jsonb NOT NULL, execution_enabled boolean NOT NULL, last_validated_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS policies (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, policy_json jsonb NOT NULL, version text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS watchlists (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, symbols_json jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS market_anchors (symbol text NOT NULL, session_date date NOT NULL, price_micros bigint NOT NULL CHECK (price_micros > 0), reference_timestamp timestamptz NOT NULL, quality text NOT NULL CHECK (quality IN ('OBSERVED','DEGRADED')), captured_at timestamptz NOT NULL, PRIMARY KEY(symbol,session_date));
CREATE TABLE IF NOT EXISTS market_aggregates (id bigserial PRIMARY KEY, symbol text NOT NULL, received_at timestamptz NOT NULL, snapshot_json jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS market_aggregates_retention_idx ON market_aggregates(received_at);
CREATE TABLE IF NOT EXISTS portfolio_snapshots (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, captured_at timestamptz NOT NULL, snapshot_json jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS decisions_v1 (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL, symbol text NOT NULL, permission text NOT NULL CHECK (permission IN ('TRADE','ALERT_ONLY','BLOCK')), input_hash text NOT NULL, decision_json jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS decisions_v1_user_idx ON decisions_v1(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS paper_orders (id uuid PRIMARY KEY, decision_id uuid NOT NULL UNIQUE REFERENCES decisions_v1(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_order_id text NOT NULL UNIQUE, side text NOT NULL CHECK (side IN ('buy','sell')), notional_cents integer NOT NULL CHECK (notional_cents > 0), submitted_at timestamptz NOT NULL, receipt_json jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS paper_orders_usage_idx ON paper_orders(user_id,submitted_at);
CREATE TABLE IF NOT EXISTS notification_channels (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, type text NOT NULL CHECK (type IN ('IN_APP','TELEGRAM','EMAIL','WEB_PUSH')), label text NOT NULL, verified boolean NOT NULL, created_at timestamptz NOT NULL, destination_json jsonb);
CREATE TABLE IF NOT EXISTS notifications (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL, notification_json jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS notification_attempts (id uuid PRIMARY KEY, notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE, channel_id uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE, attempted_at timestamptz NOT NULL, attempt_json jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL, subject_id text, metadata_json jsonb NOT NULL, created_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS audit_retention_idx ON audit_events(created_at);
CREATE OR REPLACE FUNCTION sessionguard_protect_audit_events() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
      AND NEW.id = OLD.id AND NEW.action = OLD.action
      AND NEW.subject_id IS NOT DISTINCT FROM OLD.subject_id
      AND NEW.metadata_json = OLD.metadata_json AND NEW.created_at = OLD.created_at
    THEN RETURN NEW;
    END IF;
    RAISE EXCEPTION 'AUDIT_EVENTS_IMMUTABLE';
  END IF;
  IF OLD.created_at >= now() - interval '1 year' THEN RAISE EXCEPTION 'AUDIT_EVENTS_RETAINED'; END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION sessionguard_protect_audit_events();

INSERT INTO schema_migrations(version) VALUES ('0001-production-platform') ON CONFLICT DO NOTHING;
COMMIT;
