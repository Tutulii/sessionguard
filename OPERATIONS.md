# SessionGuard Production Operations

This runbook operates the paper-only, Bitget-only public beta defined in `PRODUCTION_PLAN.md` and its additive agent plan. It never authorizes live-money execution. Qwen proposes actions inside the event loop; deterministic policy alone grants or denies a short-lived Bitget Demo capability.

## Service topology

- Fly application region: Singapore (`sin`).
- Process groups: two `web` Machines and two `worker` Machines, each with 1 shared CPU and 512 MB RAM.
- Web: Fastify API, static React application, SIWE sessions, SSE, guard evaluation, and Demo order requests.
- Worker: Bitget snapshot/anchor collection, five-minute portfolio refresh, order reconciliation, notification delivery, and retention.
- State: HA managed PostgreSQL for tenant/evidence data; persistent HA Redis for sessions, atomic capabilities, locks, quote cache, notification queues, and fan-out; AWS KMS in `ap-southeast-1` for envelope keys.

`fly.toml` defines both process groups and keeps two web Machines warm. After the first deployment, explicitly establish and verify both group counts:

```bash
fly deploy --config fly.toml
fly scale count web=2 worker=2 --region sin
fly scale show
fly status
```

Do not set `SESSIONGUARD_ALLOW_LOCAL_INFRA=1` in Fly. SQLite, the memory coordinator, local KMS, and replay fixtures are test/local facilities only.

### Authorized hackathon deployment profile

The public hackathon demo uses `SESSIONGUARD_DEPLOYMENT_PROFILE=HACKATHON`: one 512 MB web Machine, one 512 MB worker Machine, a single-node Fly Postgres development cluster with 1 GB RAM and a 10 GB encrypted volume, and Upstash Redis pay-as-you-go with eviction, automatic plan upgrades, and ProdPack disabled. This profile is deliberately economical and is **not** the high-availability public-beta topology above.

The worker health check uses a five-second process heartbeat plus a three-minute stuck-tick threshold. A long official-source or Qwen scan remains healthy while it is making bounded progress, but a stalled tick, PostgreSQL failure, agent-database failure, or Redis failure still makes the check fail closed.

PostgreSQL and Redis remain mandatory and readiness still fails closed if either dependency is unavailable. Bitget execution remains Demo-only. Provider notifications and external Sentry/OTLP delivery are optional in this profile; in-app evidence, metrics endpoints, and structured logs remain available.

The profile encrypts each Bitget credential record with AES-256-GCM and wraps its per-record data key with an independent, high-entropy `LOCAL_KMS_MASTER_KEY` stored as a Fly secret. Audit records identify this provider as `FLY_SECRET_AES256_GCM`. It is a practical hackathon deployment boundary, not a claim of hardware-backed or independently managed AWS KMS. Move to the default profile, AWS KMS, managed HA PostgreSQL/Redis, and two Machines per process group before a real public beta.

For this profile, deploy and verify the economical process counts with:

```bash
fly deploy --config fly.toml
fly scale count web=1 worker=1 --region sin
fly status
```

## Required configuration

Set every required secret through the deployment secret store, never in `fly.toml`, an image layer, logs, screenshots, or CI output:

- `APP_ORIGIN`, `DATABASE_URL`, `REDIS_URL`
- `DECISION_SIGNING_KEY`, `ADMIN_TOKEN`, `METRICS_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` as four independent random values of at least 32 characters
- `KMS_KEY_ID`, KMS workload credentials/role, and `AWS_REGION=ap-southeast-1`
- `RESEND_API_KEY`, `EMAIL_FROM`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NAME`
- `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
- Runtime secrets/config: `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, and optional `OTEL_EXPORTER_OTLP_HEADERS`; pass the public browser DSN separately at image build time as `--build-arg VITE_SENTRY_DSN=...`

Keep `PUBLIC_BETA_USER_CAP` at or below 500. Startup fails closed if production infrastructure, delivery providers, or strong independent secrets are absent.

Rotate the decision key only after outstanding 90-second permissions expire. Rotate provider/admin/metrics/webhook secrets one at a time, verify probes, then revoke the old value. KMS key rotation does not require decrypting credentials in bulk because each record stores its encrypted data key.

## Release gate and rollout

Every release must pass the `production-gates` workflow: type checking, unit/integration/browser tests, real PostgreSQL migration and Redis contracts, secret/dependency scans, production build, Docker build, and high/critical container scan.

1. Internal: cap 10; validate security headers, restore, stale-quote behavior, replay isolation, duplicate-order metric, and all notification providers.
2. Alpha: cap 25 for at least three US cash sessions and one weekend; no unresolved critical incidents.
3. Beta: cap 100; run a restore exercise and validate p95 objectives under observed peak load.
4. Public beta: cap 500 only after all previous gates remain green.

Use rolling deploys. Migrations are additive/idempotent and run as the Fly release command. Do not combine a breaking schema removal with application rollout.

## Health, dashboards, and objectives

- Liveness: `GET /api/v1/health/live` proves the process can respond.
- Readiness: `GET /api/v1/health/ready` requires PostgreSQL and Redis.
- Web metrics: `GET /api/v1/metrics` with `Authorization: Bearer $METRICS_TOKEN`.
- Worker metrics: scrape the private worker port at `GET :9091/internal/metrics` with the same bearer token; its unauthenticated `/internal/health` endpoint is reserved for Fly checks.
- Synthetic: run `SESSIONGUARD_BASE_URL=https://<app> npm run synthetic:smoke` every minute from outside Fly.
- Errors: Sentry must have PII scrubbing enabled in addition to application redaction.
- Traces: send OTLP over TLS to a collector/backend; dashboards link request IDs, traces, provider freshness, and Sentry events.

Required objectives and pages:

Agent-specific telemetry is exposed on the same authenticated metrics endpoints. The `sessionguard_agent_*` series cover trigger/run/transition states, queue age, Qwen latency and tokens, permission distributions, dedupe, eligibility, grants, capabilities, Demo submissions/reconciliation, outcome coverage, source polling/delay, notifications, and kill switches. Never label a counterfactual as realized P&L.


| Signal | Objective | Page condition |
|---|---:|---:|
| API availability | 99.9% over 30 days | 5xx ratio >0.1% for 10 minutes |
| Cached API latency | p95 <300 ms | p95 >300 ms for 10 minutes |
| Alert enqueue-to-provider | p95 <60 s | p95 >60 s for 10 minutes |
| Bitget freshness | quote age ≤10 s | `sessionguard_provider_fresh == 0` for 30 seconds |
| Duplicate Demo submissions | zero | any increase pages immediately |
| Worker heartbeat | <30 s old | absent/stale for 30 seconds |
| Recovery | RPO ≤5 min, RTO ≤30 min | restore drill violates either |

Import `ops/grafana-dashboard.json` and load `ops/prometheus-rules.yml` into the metrics backend. Dashboards must separate provider failure (`MARKET_UNAVAILABLE`) from application failure; Bitget failure is expected to fail closed and must never silently switch a user to replay.

## Kill-switch runbook

Activate before investigating any suspected duplicate, authorization bypass, wrong environment, or Demo/provider ambiguity. Mutation calls require the admin bearer token, same-origin header, and configured origin.

```bash
curl -X PUT "$APP_ORIGIN/api/v1/admin/kill-switch" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Origin: $APP_ORIGIN" \
  -H "x-sessionguard-request: 1" \
  -H "content-type: application/json" \
  --data '{"scope":"global","enabled":true}'
```

Scopes are `global`, `user:<uuid>`, and `symbol:RNVDAUSDT|RTSLAUSDT|RORCLUSDT`. Read a scope with `GET /api/v1/admin/kill-switch?scope=<scope>` and the same bearer token. Every mutation creates an immutable audit event. Disable only after pending orders have reconciled by deterministic `clientOid`, the cause is fixed, and an incident commander approves.

## Incident playbooks

### Bitget stale or unavailable

1. Confirm provider freshness and upstream status; do not weaken the ten-second threshold.
2. Verify guard results are `BLOCK`/`MARKET_UNAVAILABLE` and Live is not relabelled Replay.
3. Keep Demo execution closed. Offer the visibly labelled local replay only.
4. Recover automatically; validate a fresh ticker and correct cash-session anchor before resolving.

### Suspected duplicate or uncertain Demo response

1. Activate global or symbol kill switch immediately.
2. Inspect `RECONCILING` receipts and query Bitget Demo using the stored deterministic `clientOid`.
3. Never retry an uncertain submission blindly. The worker reconciles; unresolved items page after ten minutes and block the same user/symbol.
4. A non-zero duplicate counter is a severity-one event even if no financial funds are at risk.

### PostgreSQL or Redis failure

1. Readiness must fail and new permissions must fail closed.
2. PostgreSQL: fail over managed HA, verify migration version and immutable-audit trigger, then compare latest receipt time to confirm RPO.
3. Redis: fail over to the persistent replica, verify sessions/locks/one-use keys/job sorted sets, and keep the global kill switch active until uncertain orders reconcile.
4. Restore traffic only when both readiness dependencies are healthy and the synthetic replay contract passes.

### Credential or notification-provider failure

1. Credential decrypt/validation failure blocks execution and emits a credential warning without logging plaintext.
2. Delivery failures retry with bounded backoff; exhausted jobs move to dead letter. Repair the provider before replaying dead letters.
3. Never copy decrypted destinations or Bitget credentials into tickets. Use channel/order/user UUIDs.

## Backup and restore

- Configure managed PostgreSQL continuous recovery/snapshots for an RPO of five minutes or better, encrypted with provider-managed keys.
- Configure persistent Redis HA with AOF/failover appropriate to the five-minute RPO; test recovery of sessions, one-use keys, notification jobs, and kill switches.
- Set all database and cache backup retention to no more than 35 days so deleted credentials age out within the promised window.
- Quarterly, restore PostgreSQL and Redis into an isolated private environment, revoke outbound provider access, run migration/readiness/integration checks, reconcile counts/hashes, and record measured RPO/RTO.
- Credentials are deleted from the primary store immediately on disconnect/account deletion. Never restore a backup into production without applying the post-backup deletion ledger or forcing credential reconnection.

## Rollback

1. Activate the global kill switch if the release can affect permissions or Demo execution.
2. Inspect `fly releases` and deploy the previous known-good image/config.
3. Do not reverse an additive migration; the prior application must tolerate it. Restore data only for confirmed corruption, not ordinary code rollback.
4. Run live/ready probes, the synthetic smoke, one weekend block replay, one cash-open local simulation, and order reconciliation.
5. Remove the switch only after dashboards and error reporting are clean.

## Retention and privacy

- Market aggregates: 30 days.
- Notifications and delivery attempts: 90 days.
- Decisions, paper receipts, and audit evidence: one year.
- Audit evidence cannot be updated and cannot be deleted before retention expiry; account deletion can only null the owning foreign key.
- Account deletion removes the wallet/user, encrypted credential record, policies, positions, decisions, receipts, channels, and inbox from primary PostgreSQL, invalidates the active session, and reports the 35-day backup expiry.
