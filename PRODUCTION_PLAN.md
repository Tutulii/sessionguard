# SessionGuard Production Public-Beta Plan — Excluding AI Agent

## Summary

- Use only Bitget rToken prices: the current Bitget rToken last price and the last Bitget rToken candle from the completed US cash session.
- Label the reference `BITGET_CASH_SESSION_ANCHOR`; never call it an official stock close, Nasdaq price, or premium to the underlying stock.
- If Bitget Live is unavailable, switch visibly to `REPLAY`. Replay may simulate locally but must never submit a Bitget Demo order.
- Target a paper-only public beta capped at 500 users and support only rNVDA, rTSLA, and rORCL.
- Exclude the AI agent/orchestrator, chatbot, live-money trading, licensed equity feeds, additional rTokens, and native mobile applications.
- At completion, compare every requirement in this document with code and test evidence in `PRODUCTION_AUDIT.md`; close every gap before declaring completion.

## Production implementation

### Platform and identity

- Retain React/Vite/TypeScript and Fastify, separating Fly.io into `web` and `worker` process groups with two running instances each in Singapore.
- Replace production SQLite with HA managed PostgreSQL; retain SQLite only for isolated tests and replay fixtures.
- Use Redis for authenticated sessions, distributed locks, rate limiting, quote cache, SSE fan-out, and notification jobs.
- Add Arbitrum SIWE authentication on chain ID `42161`, with a single-use ten-minute nonce, strict domain/URI/chain/signature/timestamp validation, secure HttpOnly sessions with 12-hour idle and seven-day absolute expiry, and fresh signature confirmation before sensitive credential actions.
- Maintain unique users separately from wallet addresses and enforce tenant ownership on every database query.

### Bitget data and session service

- Maintain an explicit symbol map for rNVDA/NVDA, rTSLA/TSLA, and rORCL/ORCL.
- Use Bitget public rToken ticker and candle data only.
- Calculate US sessions in `America/New_York`, including daylight-saving changes, holidays, and early closes, with states `CASH_OPEN`, `EXTENDED`, `WEEKEND`, `HOLIDAY`, and `MARKET_UNAVAILABLE`.
- At cash close plus two minutes, persist the final Bitget candle inside that cash session. A candle up to 30 minutes before close may be `DEGRADED`; otherwise the anchor is `MISSING`.
- Replace “basis” in production UI and APIs with `offHoursMoveBps` against the Bitget cash-session anchor.
- Block permission generation when live quotes are older than ten seconds, a required anchor is missing, the symbol is unavailable, or portfolio information is stale.
- Do not claim to detect Nasdaq halts. Bitget unavailability or stale data becomes `MARKET_UNAVAILABLE`.
- Record provider timestamp, receive timestamp, source, freshness, data mode, and reference quality with every decision.

### Portfolio, deterministic guard, and paper execution

- Accept Bitget Demo credentials only, force paper-trading headers on all private calls, and implement no live-money order path.
- Store credentials with per-record AES-256-GCM envelope encryption backed by a managed KMS key. Never place plaintext credentials in PostgreSQL, Redis, analytics, errors, or logs.
- Synchronize balances, rToken holdings, collateral exposure, open Demo orders, and receipts every five minutes, every 15 seconds while the dashboard is active, and immediately before permission or execution.
- Enforce versioned hard rules: $250 cash-session maximum; 25% extended maximum; 10% earnings-window maximum; no weekend/holiday exposure increases; fresh-data-only reduce orders; block on missing/stale inputs or failed −8% collateral stress; and operational limits of $1,000 gross new notional and 20 submitted paper orders per user per day.
- Users may only tighten platform rules.
- Issue a short-lived decision token only for `TRADE`, binding it to the user, wallet session, symbol, side, amount, maximum slippage, policy version, input hashes, nonce, and expiry.
- Consume tokens atomically once, use deterministic client order IDs, reconcile uncertain responses before retrying, and provide global, user, and symbol kill switches.

### Alerts and product experience

- Provide verified in-app, Telegram, email, and web-push channels.
- Queue, deduplicate, retry, and audit notifications; exhausted jobs enter a dead-letter queue.
- Alert on session transitions, large off-hours moves, failed stress checks, blocked decisions, credential problems, and submitted or reconciled paper orders.
- Preserve the premium animated dashboard while adding wallet onboarding, Bitget Demo connection, real portfolio and collateral, tighten-only settings, notification setup/history, paginated receipts, export/deletion, reduced motion, and WCAG 2.2 AA behavior.
- Display persistent source labels: `LIVE BITGET`, `REPLAY`, `BITGET DEMO SUBMITTED`, or `LOCAL REPLAY SIMULATION`.

## Interfaces and storage

- Version endpoints under `/api/v1`: auth nonce/verify/me/logout; Bitget Demo connections; market snapshots/stream; portfolio; policies; guard evaluation; paper orders; decisions; notification channels/inbox; and live/ready health.
- Standardize `DataMode = LIVE_BITGET | REPLAY`, `ReferenceKind = BITGET_CASH_SESSION_ANCHOR`, `ReferenceQuality = OBSERVED | DEGRADED | MISSING`, `Permission = TRADE | ALERT_ONLY | BLOCK`, and `ExecutionMode = BITGET_DEMO | LOCAL_REPLAY`.
- A market snapshot exposes the current rToken price, anchor price, off-hours movement, session, freshness, source, and data mode.
- A guard decision exposes permission, stable reason codes, gap scenarios, policy version, input hash, expiry, and an optional signed token.
- PostgreSQL persists users, wallets, encrypted Bitget connections, policies and versions, watchlists, anchors, portfolio snapshots, decisions, Demo receipts, notification channels/attempts, and immutable audit events.
- Retain market aggregates for 30 days, notification attempts for 90 days, and decisions/order/audit receipts for one year. Delete credentials immediately on disconnect or account deletion; expire backups within 35 days.

## Verification, delivery, and operations

- Cover DST, holidays, early closes, anchors, movement/gap math, permission rules, tighten-only validation, SIWE replay/domain/chain/session attacks, tenant isolation, secret handling, concurrent token use, duplicate-order prevention, upstream failures, notification retries, complete browser journeys, accessibility, responsive layouts, and reduced motion.
- CI runs type checking, unit/integration/E2E tests, migration checks, dependency and secret scanning, container scanning, and production builds.
- Production objectives are 99.9% API availability, cached API p95 below 300 ms, notification enqueue-to-provider p95 below 60 seconds, zero duplicate paper submissions, RPO within five minutes, and RTO within 30 minutes.
- Add structured logs, OpenTelemetry telemetry, frontend/backend error reporting, provider-health dashboards, synthetic checks, and incident, kill-switch, and restore runbooks.
- Roll out from internal users to 25-user alpha, 100-user beta, and capped 500-user public beta only after security, restore, freshness, and duplicate-order gates pass.

## Locked assumptions

- The public demo is Bitget-only with no commercial US-equity feed or redistribution expense.
- The Bitget cash-session anchor is a risk reference, not an independent underlying-stock price.
- Replay is clearly disclosed and cannot silently submit Bitget Demo orders.
- All execution is paper/Demo-only.
- A future advanced agent consumes these APIs and permissions, but no agent loop or chatbot is part of this plan.

