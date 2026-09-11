# SessionGuard

SessionGuard is deterministic risk infrastructure for Bitget rTokens. It prevents traders—and future automated callers—from treating a 24/7 rToken quote as if it were current US cash-market price discovery.

The production beta is intentionally narrow: rNVDA, rTSLA, and rORCL; Bitget-only market data; local replay or Bitget Demo execution; and a hard cap of 500 wallet-authenticated users. SessionGuard includes an event-driven Qwen proposal agent, not a chatbot. The model has no order tool: deterministic policy can grant only a short-lived Demo capability. There is no licensed US-equity feed or live-money order path.

## Product boundary

- The current price is the Bitget rToken last price.
- The reference is the final usable Bitget rToken candle from the last completed US cash session. It is always labelled `BITGET_CASH_SESSION_ANCHOR`; it is not an official stock close or an independent underlying-stock price.
- Live source failures remain failures. The UI may offer a clearly disclosed replay, but it never relabels replay data as Live Bitget.
- Replay permissions can create only `LOCAL_REPLAY` simulations. Live permissions can submit only through an SDK client configured with `paperTrading: true`.
- Deterministic server code—not a model—returns `TRADE`, `ALERT_ONLY`, or `BLOCK`.

## Judge journey

1. Open `/` and choose **Run the Sunday replay**.
2. The control room labels the source `STATIC REPLAY DATA`. Press **Play replay** to advance the recorded Bitget fixture tick by tick; price, movement, timestamp, chart cursor, and event context update together.
3. Pause, scrub, reset, or choose **Decision point**. The deterministic guard remains locked until the final authoritative frame, so the visible market state always matches the evaluated fixture.
4. Sign an Arbitrum SIWE challenge. The signature moves no funds and grants no transaction permission.
5. Choose **Run deterministic guard**. The server blocks the Sunday exposure increase, allows `$0`, records `CASH_MARKET_DARK`, and creates an in-app receipt.
6. Select **Cash market pass**, reach its decision point, run the guard, and choose **Simulate allowed order**. The one-use permission produces a local replay receipt and sends nothing to Bitget.

## Production architecture

```text
React/Vite dashboard
        │ SIWE session + /api/v1
        ▼
Fastify web instances ─── PostgreSQL (tenant data, receipts, audit)
        │                 Redis (sessions, locks, limits, cache, jobs, SSE)
        │
        ├── Bitget public ticker/candles
        ├── deterministic session/portfolio/risk gate
        └── KMS envelope vault ── Bitget SDK (Demo/paper only)

Worker instances
        ├── market and anchor refresh
        ├── five-minute Demo portfolio refresh
        ├── session/off-hours alerts
        ├── notification delivery/retry/dead-letter
        └── retention and reconciliation
```

Important implementation entry points:

- `server/production-app.ts` — versioned API, origin/tenant enforcement, health, metrics, and secure static serving.
- `server/production-market.ts` and `server/production-session.ts` — Bitget-only snapshots, anchors, freshness, holidays, early closes, and New York time.
- `server/production-rules.ts` — versioned fail-closed rules and integer money/gap calculations.
- `server/production-trading.ts` — pre-execution revalidation, one-use tokens, idempotent Demo orders, and replay isolation.
- `server/envelope-vault.ts` — per-record AES-256-GCM encryption with an AWS KMS data key.
- `server/postgres-repository.ts` and `server/redis-coordinator.ts` — production persistence and distributed coordination.
- `server/production-worker.ts` — background market, portfolio, alert, delivery, retention, and reconciliation work.
- `src/pages/ProductionDashboardPage.tsx` and `src/components/ReplayMarketTimeline.tsx` — responsive control room and deterministic tick-by-tick replay player with reduced-motion handling.

The earlier hackathon prototype remains in compatibility files for historical tests, but the deployed entry points are `createProductionApp`, `createProductionWorker`, and `ProductionDashboardPage`. The event-driven agent design in `ADVANCED_AGENT_ARCHITECTURE.md` and `AI_AGENT_PRODUCTION_PLAN.md` is part of this runtime.

## Run locally

Node.js 24 is recommended because isolated local mode uses Node's built-in SQLite module.

```bash
npm ci
npm run dev
```

The Vite UI runs on `http://127.0.0.1:5173` and proxies `/api` to Fastify on port `8787`. Replay market data works without provider credentials. Wallet signing requires an injected EVM wallet on Arbitrum One.

For a production-style local build with explicitly allowed test infrastructure:

```bash
npm run build
SESSIONGUARD_ALLOW_LOCAL_INFRA=1 \
APP_ORIGIN=http://127.0.0.1:8787 \
DECISION_SIGNING_KEY=replace-with-at-least-32-characters \
LOCAL_KMS_MASTER_KEY=replace-with-another-32-character-key \
npm start
```

`SESSIONGUARD_ALLOW_LOCAL_INFRA` must never be enabled in the public deployment.

## Production configuration

Copy `.env.example` as a reference; do not commit a populated environment file. Public production requires:

- `APP_ORIGIN`, `DATABASE_URL`, and `REDIS_URL`.
- `DECISION_SIGNING_KEY`, `ADMIN_TOKEN`, and `METRICS_TOKEN` as independent high-entropy secrets.
- `KMS_KEY_ID` and workload access to AWS KMS in `AWS_REGION`.
- Resend email configuration, Telegram bot/webhook secrets, and a complete VAPID key set.
- `SENTRY_DSN` and a TLS `OTEL_EXPORTER_OTLP_ENDPOINT` are required at runtime for backend error reporting and traces. Supply the public `VITE_SENTRY_DSN` as a Docker/Fly build argument so frontend failures are reported too.

For the production image, pass the browser DSN during the build: `fly deploy --build-arg VITE_SENTRY_DSN=https://<public-sentry-dsn>`. A Sentry DSN is public routing metadata, but all provider credentials remain runtime secrets.

Bitget Demo keys belong to each user and are entered at runtime. They are validated, envelope-encrypted, and stored per tenant; they are never shared server environment variables.

The deployed hackathon demo uses the explicit `HACKATHON` profile documented in `OPERATIONS.md`: PostgreSQL and Redis remain mandatory, but external notification/observability providers are optional and credential data-key wrapping uses a high-entropy Fly secret instead of AWS KMS. This is a cost-controlled demo topology, not the HA public-beta topology.

## API surface

All application endpoints are versioned under `/api/v1`:

- Authentication: `/auth/nonce`, `/auth/verify`, `/auth/me`, `/auth/logout`.
- Market: `/market/snapshots/:symbol`, `/market/stream`, `/replays`.
- Account: `/connections/bitget-demo`, `/portfolio`, `/policies`, `/account/export`, `/account`.
- Guard and evidence: `/guard/evaluate`, `/paper-orders`, `/decisions`, `/decisions/export`.
- Alerts: `/notifications/channels`, `/notifications/inbox`, `/notifications/stream`, verification and Telegram webhook routes.
- Operations: `/health/live`, `/health/ready`, `/metrics`, and `/admin/kill-switch`.

Mutations require the `x-sessionguard-request: 1` same-origin guard. Private routes require the secure HttpOnly SIWE session. Credential/channel/account mutations additionally require a signature-verified session less than five minutes old.

## Verification

```bash
npm run check
npm run test:e2e
npm audit --audit-level=moderate
```

CI also applies the PostgreSQL migration against a service database, exercises Redis coordination, scans the container, checks for committed secret patterns, and runs Chromium journeys at desktop and mobile sizes.

See `PRODUCTION_PLAN.md` for the locked plan, `OPERATIONS.md` for deployment/runbooks/SLOs, and `PRODUCTION_AUDIT.md` for the final requirement-to-evidence comparison.

Hackathon context: [Bitget AI Hackathon](https://www.bitget.com/activity-hub/hackathon) and [rules handbook](https://bitget-ai.gitbook.io/bitgetai_hackathons2).
