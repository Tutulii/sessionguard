# SessionGuard Production Contract

## Objective

Implement every requirement in `PRODUCTION_PLAN.md` and `AI_AGENT_PRODUCTION_PLAN.md`. Compare the completed codebase with both plans line by line, implement every missing item, and record verifiable evidence in `PRODUCTION_AUDIT.md` and `AI_AGENT_PRODUCTION_AUDIT.md` before declaring completion.

## Non-negotiable boundaries

1. Paper and Bitget Demo execution only; there is no live-money order path.
2. Market prices come only from Bitget. `BITGET_CASH_SESSION_ANCHOR` is never represented as an official underlying-stock close.
3. Replay is visibly labelled and can execute only a local simulation.
4. Persistent credentials are encrypted with per-record AES-256-GCM envelope encryption; plaintext is never persisted, cached in Redis, or logged.
5. Wallet ownership and tenant authorization protect all private resources.
6. Users may tighten platform risk limits but never loosen them.
7. The AI agent is a durable event-driven permission loop, not a chatbot; it is included in this production phase and remains Bitget Demo-only.

## Working rules

1. Continue through implementation, migrations, tests, operations documentation, responsive review, and the final plan comparison.
2. Preserve the premium animated frontend and the deterministic permission-layer thesis.
3. Keep existing prototype compatibility routes through the beta unless they violate a production boundary.
4. Treat unavailable infrastructure or provider credentials as configuration-dependent integration gates, not permission to silently weaken behavior.
5. If the user asks a question during implementation, answer it gently and resume work.
6. Do not mark this contract complete while any plan item or required check lacks evidence.

## Production checklist

- [x] Versioned production interfaces and source-truthful shared contracts.
- [x] SIWE wallet authentication, durable sessions, and tenant authorization.
- [x] PostgreSQL production repository, migrations, and retention jobs.
- [x] Redis sessions, locks, caching, fan-out, limits, and durable notification queue.
- [x] KMS-backed persistent Bitget Demo credential vault.
- [x] Bitget-only live snapshots and persisted cash-session anchors.
- [x] Portfolio synchronization and freshness enforcement.
- [x] Versioned deterministic risk policy with tighten-only preferences.
- [x] Atomic decision-token consumption, idempotent Demo orders, and reconciliation.
- [x] In-app, Telegram, email, and web-push notification channels.
- [x] Production dashboard workflows, data labels, accessibility, and reduced motion.
- [x] Fly web/worker topology, CI security gates, telemetry, and runbooks.
- [x] Unit, integration, E2E, security, failure, load, and production-build checks pass.
- [x] `PRODUCTION_AUDIT.md` and `AI_AGENT_PRODUCTION_AUDIT.md` map every requirement to code and test evidence with no gaps.

## Baseline

The original hackathon prototype and its audit remain recorded in `IMPLEMENTATION_PLAN.md` and `IMPLEMENTATION_AUDIT.md`. That baseline was complete on 2026-09-09, but its single-user SQLite and ephemeral-vault assumptions are superseded by this production contract.

## Status

**COMPLETE — production and AI-agent plans passed final comparison and release verification on 2026-09-10. See `PRODUCTION_AUDIT.md` and `AI_AGENT_PRODUCTION_AUDIT.md`.**
