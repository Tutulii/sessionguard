# SessionGuard AI Agent Production Audit

Audit date: 2026-09-11

This is the implementation-to-roadmap acceptance record for `AI_AGENT_PRODUCTION_PLAN.md`.

| Roadmap requirement | Implementation evidence | Verification |
|---|---|---|
| Fixed Bitget-only, Demo-only product boundary | `server/production-bitget.ts`, `server/production-trading.ts`, `scripts/agent-execution-scan.mjs` | `npm run security:agent-execution` |
| Durable triggers, queue, leases, recovery and dedupe | `server/agent-repository.ts`, `server/agent-orchestrator.ts`, `migrations/0002_agent_runtime.sql`, `migrations/0003_trigger_dedupe_state.sql` | repository, trigger, orchestrator, API, and execution integration suites |
| Official SEC/IR event ingestion with replay fallback | `server/production-events.ts`, `shared/replays.ts` | `server/production-events.test.ts`, replay fixtures |
| Sanitised Qwen analyst contract | `server/production-qwen.ts` | `server/production-qwen.test.ts` |
| Deterministic session/basis/gap/margin authorization and portfolio-aware risk sizing | `server/agent-guard.ts`, `server/production-trading.ts`, `shared/agent-types.ts` | `server/agent-guard.test.ts`, trigger and execution suites |
| Seven-day SIWE grant, exact scope, revocation and demotion | `server/agent-grant.ts`, `server/production-token.ts` | grant and token-security suites |
| Shadow qualification and PAPER_AUTO restrictions | `server/agent-grant.ts`, `server/agent-orchestrator.ts` | orchestrator, trigger and execution suites |
| Fresh revalidation, reservation, idempotent Demo submission and reconciliation | `server/production-trading.ts`, `server/agent-repository.ts` | `server/agent-execution.integration.test.ts` |
| Shared schemas, API routes, Postgres schema and migration | `shared/agent-types.ts`, `server/production-app.ts`, `server/agent-postgres-schema.ts`, migrations `0002` + `0003` | typecheck, migration contract, and CI PostgreSQL gate |
| Premium `/agent` experience with disclosures and accessible dialogs | `src/pages/AgentPage.tsx`, `src/agent.css`, `src/lib/production-api.ts` | production build and browser journey |
| Bitget-only outcome scoring and insufficient-data labels | `server/agent-orchestrator.ts`, `server/agent-repository.ts` | orchestrator and execution suites |
| Kill switches, failed-closed behavior, retention, export/delete | `server/agent-orchestrator.ts`, `server/production-app.ts`, repository retention/export methods | unit/integration suites and operations contract |
| Metrics, alerts, health and operational runbook | `server/telemetry.ts`, `ops/prometheus-rules.yml`, `OPERATIONS.md` | operations contract, typecheck |
| Security, dependency and execution-boundary gates | `scripts/secret-scan.mjs`, `scripts/agent-execution-scan.mjs`, CI workflow | `npm run security:secrets`, `npm run security:agent-execution`, `npm audit` |

## Final roadmap-to-code comparison

| Plan section | Result | Concrete evidence |
|---|---|---|
| 1–2. Objective and fixed boundaries | PASS | `agent.md`, versioned contracts, Demo-only adapter, and execution-path scan preserve Bitget-only, no-chatbot, no-live-money scope. |
| 3. Runtime architecture | PASS | Durable repository, orchestrator, worker schedules, leases, recovery, semantic event dedupe, threshold hysteresis, and collateral episodes are implemented and tested. |
| 4. Trusted ingestion and Qwen | PASS | SEC/IR watcher, SSRF/redirect/content controls, sanitized hashed context, tool-free structured Qwen validation, retry, grounding, and fail-closed tests are present. |
| 5. Authorization, grants, execution | PASS | Deterministic portfolio/market/event risk sizing under a $250 absolute ceiling, 24h/10-run eligibility, purpose-bound seven-day SIWE grant, single-use capability, fresh recheck, reservation, Demo submission, and reconciliation tests pass. |
| 6. State, APIs, storage, and `/agent` UI | PASS | Versioned schemas, explicit transition table, tenant routes/SSE, PostgreSQL + SQLite parity, migrations `0002`/`0003`, export/delete, responsive UI, and accessible control plane are implemented. |
| 7. Outcome scoring | PASS | Bitget-only observation windows, submitted/counterfactual scoring, MFE/MAE, avoided-loss/missed-upside wording, and insufficient-data behavior are tested. |
| 8. Security, reliability, observability | PASS | Independent fail-closed paths, kill switches, redaction, tenant isolation, audit events, metrics, alerts, runbooks, scans, and runtime-container hardening pass release gates. |
| 9. Verification | PASS | CI runs all 239 unit/contract/integration tests, real PostgreSQL/Redis checks, 20 applicable desktop/mobile journeys, migrations, builds, and security scans. |
| 10. Delivery and rollout controls | PASS (implementation) | Feature flags, staged caps, readiness/kill-switch procedures, rollback, restore, and operator gates are documented and wired. No external public rollout is falsely claimed. |
| 11. Final acceptance | PASS | Trusted triggers run without a click; Qwen remains proposal-only; non-trade paths cannot call the adapter; PAPER_AUTO is scoped and gated; replays remain local; all code release gates are green. |

**Implementation comparison result: 11/11 roadmap sections mapped, zero unresolved code gaps, zero TODO/FIXME placeholders, and zero live-money paths. External staged rollout remains an operator-controlled activity, not an unimplemented code feature.**

## Required verification commands

```text
npm run typecheck
npm test
npm run security:secrets
npm run security:agent-execution
npm run build
npm run test:e2e
```

On this Android/Termux host Playwright reports `Unsupported platform: android`; the browser suite is therefore executed on the Linux CI runner. The local synthetic smoke probe passed against a started server.

GitHub `production-gates` run [34550082271](https://github.com/Tutulii/sessionguard/actions/runs/34550082271) verified implementation commit `759fcce`: all 47 test files and 239 tests passed with PostgreSQL 18 and Redis 8 enabled; 20 applicable desktop/mobile Chromium journeys passed with four intentional cross-project skips; migrations `0001`, `0002`, and `0003` applied; the production image built; and Trivy reported zero high or critical findings.

## Dedupe hardening acceptance — 2026-09-11

| Acceptance condition | Code evidence | Test/runtime evidence |
|---|---|---|
| Same official filing or replay creates one decision | Event-scoped deterministic keys and legacy replay lookup in `server/agent-orchestrator.ts`; API returns `SKIPPED_DUPLICATE` | Orchestrator and production API duplicate tests |
| Amended content may create another decision | Content hash remains part of the event identity | Tape helper test preserves a changed content hash |
| Unchanged collateral risk never repeats hourly | Durable armed/active episode and worsening-band state in `server/agent-repository.ts` and `server/agent-orchestrator.ts` | Trigger tests cover hours, settings changes, worsening, recovery/re-arm, and legacy adoption |
| Existing evidence is not deleted | Console-only grouping in `src/lib/agent-run-tape.ts`; repository export remains complete | Tape tests and export/delete repository test |
| PostgreSQL rollout is additive | `migrations/0003_trigger_dedupe_state.sql` and matching runtime schema | Migration contract and CI migration checks |

Local runtime observation after migration: worker health remained current and the existing collateral-trigger count did not increase across repeated worker ticks while the risk state stayed unchanged.

Final local release gate: `npm run check` passed with 237 tests passing and 2 integration tests explicitly skipped without local PostgreSQL/Redis URLs, zero dependency vulnerabilities, a clean secret scan, a clean Demo-only execution-boundary scan, and a successful client/server production build. `npm run synthetic:smoke` passed against the running local stack. Linux CI enabled the external-service tests and passed all 239 tests plus the complete applicable browser, migration, container-build, and container-scan gates.


## Deterministic risk-sizing acceptance — 2026-09-11

| Amended plan requirement | Code and UI evidence | Test evidence | Result |
|---|---|---|---|
| $250 is an absolute ceiling, not a fixed order | agentPolicy.maxAutomaticOrderCents is 25,000 cents; defaultAgentSettings remains 10,000 cents; user, grant, policy, and context ceilings are intersected in server/agent-guard.ts | ceiling and default-boundary tests in server/agent-guard.test.ts and server/agent-types.test.ts | PASS |
| Size responds to Demo equity | BUY capacity is capped at 2% of current account equity | paired equity-size test | PASS |
| Existing single-name and aggregate exposure reduce headroom | 20% single-name and 40% aggregate headroom are calculated before multipliers | partial-headroom and zero-headroom tests | PASS |
| Collateral, spendable balance, and daily usage affect size | correlated −12% stress capacity, current spendable balance, and remaining signed daily new-notional are intersected | independent stress, balance, partial-daily, and exhausted-daily tests | PASS |
| Confidence affects size deterministically | threshold-to-full-confidence maps from 50% to 100%; below threshold still blocks | low/high confidence and confidence-gate tests | PASS |
| Bitget spread/liquidity affects size | multiplier declines from 100% toward 50% at the applicable spread limit; beyond-limit guard remains ALERT_ONLY | tight/wider spread comparison and spread alert test | PASS |
| Event risk affects size | filing-type multipliers and late/correction/suspension caution ceilings are deterministic | form-type and suspension-flag tests | PASS |
| Reductions remain reduce-only | original Qwen REDUCE request is checked against the held position before any smaller candidate can execute | oversized reduction and confidence/liquidity reduction tests | PASS |
| Sizing is persisted and explainable | AgentAuthorizationV1 carries a backward-compatible sizing record; the run drawer shows request → capacity → risk size, all capacity inputs, multipliers, and applied factors; authorization audit events include sizing | typecheck, production build, orchestrator persistence assertion | PASS |
| The computed amount is the only amount submitted | capability, fresh revalidation, automatic usage, and Demo adapter use the persisted allowed amount | ten concurrent consumers submitted exactly one 6,111-cent Demo order in integration testing | PASS |

Amended plan-to-code result: every deterministic sizing item in AI_AGENT_PRODUCTION_PLAN.md is implemented; no sizing gap remains. The full local npm run check passed 245 tests with two external-infrastructure tests explicitly skipped, zero dependency vulnerabilities, clean secret and Demo-only execution scans, and successful client/server production builds. npm run synthetic:smoke passed against the running local stack. The new browser source compiles in the production build; Playwright remains unavailable on the Android host and is intentionally left for the Linux CI runner.

No live-money execution path, live-equity redistribution feed, or chat-only trading surface is part of this implementation.
