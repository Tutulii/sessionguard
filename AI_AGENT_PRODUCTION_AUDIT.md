# SessionGuard AI Agent Production Audit

Audit date: 2026-09-11

This is the implementation-to-roadmap acceptance record for `AI_AGENT_PRODUCTION_PLAN.md`.

| Roadmap requirement | Implementation evidence | Verification |
|---|---|---|
| Fixed Bitget-only, Demo-only product boundary | `server/production-bitget.ts`, `server/production-trading.ts`, `scripts/agent-execution-scan.mjs` | `npm run security:agent-execution` |
| Durable triggers, queue, leases, recovery and dedupe | `server/agent-repository.ts`, `server/agent-orchestrator.ts`, `migrations/0002_agent_runtime.sql`, `migrations/0003_trigger_dedupe_state.sql` | repository, trigger, orchestrator, API, and execution integration suites |
| Official SEC/IR event ingestion with replay fallback | `server/production-events.ts`, `shared/replays.ts` | `server/production-events.test.ts`, replay fixtures |
| Sanitised Qwen analyst contract | `server/production-qwen.ts` | `server/production-qwen.test.ts` |
| Deterministic session/basis/gap/margin authorization | `server/agent-guard.ts`, `server/production-trading.ts` | `server/agent-guard.test.ts`, trigger and execution suites |
| Seven-day SIWE grant, exact scope, revocation and demotion | `server/agent-grant.ts`, `server/production-token.ts` | grant and token-security suites |
| Shadow qualification and PAPER_AUTO restrictions | `server/agent-grant.ts`, `server/agent-orchestrator.ts` | orchestrator, trigger and execution suites |
| Fresh revalidation, reservation, idempotent Demo submission and reconciliation | `server/production-trading.ts`, `server/agent-repository.ts` | `server/agent-execution.integration.test.ts` |
| Shared schemas, API routes, Postgres schema and migration | `shared/agent-types.ts`, `server/production-app.ts`, `server/agent-postgres-schema.ts`, migrations `0002` + `0003` | typecheck, migration contract, and CI PostgreSQL gate |
| Premium `/agent` experience with disclosures and accessible dialogs | `src/pages/AgentPage.tsx`, `src/agent.css`, `src/lib/production-api.ts` | production build and browser journey |
| Bitget-only outcome scoring and insufficient-data labels | `server/agent-orchestrator.ts`, `server/agent-repository.ts` | orchestrator and execution suites |
| Kill switches, failed-closed behavior, retention, export/delete | `server/agent-orchestrator.ts`, `server/production-app.ts`, repository retention/export methods | unit/integration suites and operations contract |
| Metrics, alerts, health and operational runbook | `server/telemetry.ts`, `ops/prometheus-rules.yml`, `OPERATIONS.md` | operations contract, typecheck |
| Security, dependency and execution-boundary gates | `scripts/secret-scan.mjs`, `scripts/agent-execution-scan.mjs`, CI workflow | `npm run security:secrets`, `npm run security:agent-execution`, `npm audit` |

## Required verification commands

```text
npm run typecheck
npm test
npm run security:secrets
npm run security:agent-execution
npm run build
npm run test:e2e
```

On this Android/Termux host Playwright reports `Unsupported platform: android`; the browser suite is CI-only. The local synthetic smoke probe passed against a started server.

The CI workflow additionally applies and verifies migrations `0001`, `0002`, and `0003`, checks agent tables including durable collateral episode state, builds the production image, and runs Trivy.

## Dedupe hardening acceptance — 2026-09-11

| Acceptance condition | Code evidence | Test/runtime evidence |
|---|---|---|
| Same official filing or replay creates one decision | Event-scoped deterministic keys and legacy replay lookup in `server/agent-orchestrator.ts`; API returns `SKIPPED_DUPLICATE` | Orchestrator and production API duplicate tests |
| Amended content may create another decision | Content hash remains part of the event identity | Tape helper test preserves a changed content hash |
| Unchanged collateral risk never repeats hourly | Durable armed/active episode and worsening-band state in `server/agent-repository.ts` and `server/agent-orchestrator.ts` | Trigger tests cover hours, settings changes, worsening, recovery/re-arm, and legacy adoption |
| Existing evidence is not deleted | Console-only grouping in `src/lib/agent-run-tape.ts`; repository export remains complete | Tape tests and export/delete repository test |
| PostgreSQL rollout is additive | `migrations/0003_trigger_dedupe_state.sql` and matching runtime schema | Migration contract and CI migration checks |

Local runtime observation after migration: worker health remained current and the existing collateral-trigger count did not increase across repeated worker ticks while the risk state stayed unchanged.

Final local release gate: `npm run check` passed with 236 tests passing and 2 explicitly skipped, zero high dependency vulnerabilities, a clean secret scan, a clean Demo-only execution-boundary scan, and a successful client/server production build. `npm run synthetic:smoke` passed against the running local stack. Playwright remains CI-only because its runtime rejects Android before test discovery.

No live-money execution path, live-equity redistribution feed, or chat-only trading surface is part of this implementation.
