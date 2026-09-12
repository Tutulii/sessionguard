-- Canonicalize durable agent-job timestamps after PostgreSQL timestamptz casts.
-- Additive and idempotent; no run, transition, decision, or receipt is removed.
BEGIN;

UPDATE agent_jobs SET job_json=job_json || jsonb_build_object(
  'status',status,
  'runAt',to_char(run_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'attemptCount',attempt_count,'workerId',worker_id,
  'leaseExpiresAt',CASE WHEN lease_expires_at IS NULL THEN NULL ELSE to_char(lease_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
  'lastErrorCode',last_error_code,
  'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

INSERT INTO schema_migrations(version)
VALUES ('0004-canonical-job-timestamps')
ON CONFLICT DO NOTHING;

COMMIT;
