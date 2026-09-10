# SessionGuard AI Agent Production Plan

## 1. Objective and completion contract

Build an always-on, event-driven agent for the existing SessionGuard public beta. The agent must observe trusted events and Bitget rToken state, let Qwen independently propose an action and size, pass that proposal through SessionGuard's deterministic permission engine, and either refuse, alert, or submit a Bitget Demo order without requiring a dashboard click.

The governing boundary is:

> Qwen decides what it wants to do. Deterministic SessionGuard code decides what it is allowed to do. Only the Bitget Demo adapter can execute it.

This plan is additive to `PRODUCTION_PLAN.md`. It supersedes the SQLite and in-process-MVP assumptions in `ADVANCED_AGENT_ARCHITECTURE.md`, but preserves its safety thesis. The existing web/worker topology, PostgreSQL, Redis, KMS credential vault, wallet identity, deterministic guard, notification channels, Bitget-only prices, and paper-only executor remain the foundation.

Implementation is complete only when every requirement below is mapped to code and passing evidence in `AI_AGENT_PRODUCTION_AUDIT.md`. At that point—and not before—update `agent.md` to include the agent runtime and mark the combined contract complete.

## 2. Fixed product decisions

- Build all staged modes: `SHADOW`, `ALERT_ONLY`, and `PAPER_AUTO`. Existing users remain `DISABLED` until they explicitly opt in; the first enabled mode is always `SHADOW`.
- Permit `PAPER_AUTO` only after at least 24 elapsed hours in shadow mode and 10 qualifying live shadow runs.
- Require a purpose-specific SIWE signature for a renewable seven-day background-execution grant.
- Permit autonomous Demo submission only while the US cash session is `CASH_OPEN`. Extended, weekend, holiday, stale, and unavailable states may produce an alert or block, never an automatic order.
- Allow only SEC EDGAR, explicitly allow-listed issuer investor-relations feeds, Bitget public market data, the user's Bitget Demo portfolio, and the deterministic US session calendar as inputs. Do not ingest social media, Telegram tips, general news, or commercial US-equity prices.
- Build the experience on a separate premium `/agent` page. It is a run console and control surface, not a chatbot.
- Continue supporting only rNVDA, rTSLA, and rORCL and never add live-money execution.

## 3. Runtime architecture

```text
SEC EDGAR / allow-listed issuer IR        Bitget rToken market + Demo portfolio
                  |                                      |
          Official-event watcher                  Existing market worker
                  |                                      |
          Normalize, hash, dedupe            Session / basis / risk triggers
                  +-------------------+------------------+
                                      |
                           PostgreSQL durable trigger/job
                                      |
                              Context assembler
                                      |
                    Qwen structured action + evidence IDs
                             (untrusted proposal)
                                      |
                    Deterministic agent + portfolio guard
                      /               |                 \
                   BLOCK          ALERT/SHADOW          TRADE
                     |                 |                   |
                     +-------- immutable run --------+    |
                                                       grant check
                                                       fresh recheck
                                                       Bitget Demo SDK
                                                           |
                                                  reconcile + receipt
                                      |
                              Outcome/counterfactual scorer
```

Keep the current two `worker` instances. Extend that process with an `AgentOrchestrator`; do not create a third public service. PostgreSQL is the source of truth for events, triggers, jobs, grants, runs, transitions, and outcomes. Redis provides wake-ups, short-lived dedupe keys, distributed locks, kill switches, SSE fan-out, and rate limiting, but loss of Redis must not lose a durable run.

### Worker schedules and trigger rules

- Keep Bitget collection at the existing five-second cadence and portfolio refresh at five minutes, plus an immediate refresh before every agent authorization and execution.
- Poll SEC and configured IR feeds every two minutes. Use conditional requests (`ETag`/`If-Modified-Since`), bounded exponential backoff, and a descriptive `SEC_USER_AGENT`.
- Create `OFFICIAL_EVENT` once per user, event content hash, symbol, and agent-policy version.
- Create `SESSION_CHANGE` once per symbol/state transition. It is informational and cannot directly increase exposure.
- Create `OFF_HOURS_MOVE` when the absolute move crosses the active user's deterministic threshold. Re-arm only after returning below 75% of that threshold; otherwise dedupe by symbol/session.
- Create `COLLATERAL_RISK` when the Demo collateral buffer falls within five percentage points of the required minimum or crosses it; dedupe by two-percentage-point band for one hour.
- Create one `PRE_WEEKEND_SWEEP` per enabled user at 15:45 America/New_York on Friday when the cash market is open.
- Create `OUTCOME_DUE` jobs for decisions at the first valid cash-open quote, 60 minutes later, and the next completed cash session.
- Manual production runs are shadow-only and can never issue an execution token or count toward PAPER_AUTO eligibility.

### Durable queue and recovery

- Insert the trigger, run, and first job in one PostgreSQL transaction using a unique dedupe key.
- Claim jobs with `FOR UPDATE SKIP LOCKED`, a 60-second lease, worker ID, attempt count, and lease expiry. Heartbeat long Qwen work every 15 seconds.
- A crashed lease returns to `QUEUED`; restart from the last persisted safe transition. Never repeat an already persisted assessment, decision, reservation, or submission.
- Retry read/analysis jobs at 1, 5, and 15 minutes with jitter, then mark the run `FAILED_CLOSED`. Order submission is never blindly retried; uncertain results enter existing client-order-ID reconciliation.
- Use deterministic keys derived from `userId + triggerId + policyVersion` for runs and from the guard decision ID for orders.

## 4. Trusted event ingestion and Qwen analyst

### Event ingestion

- Continue tracking SEC forms `8-K`, `10-Q`, `10-K`, and `6-K` for the three supported issuers. Accept IR items only from configured HTTPS feed URLs whose final hostname is on the issuer allow-list.
- Resolve DNS and redirects defensively: HTTPS only, no credentials in URLs, no private/link-local addresses, at most two redirects, a two-megabyte response ceiling, and a ten-second fetch timeout.
- Strip scripts, styles, forms, hidden content, tracking parameters, and markup. Cap normalized stored text at 64,000 characters and the Qwen context at 24,000 characters.
- Split source text into numbered, hashed evidence segments. Persist canonical URL, source type, accession/feed ID, publication/effective/detection times, content hash, document hash, and correction/supersession linkage.
- A changed content hash creates a new event version. It never overwrites the source evidence used by an earlier run.
- Public UI and exports show summaries and canonical source links, not full redistributed documents.
- Language suggesting a suspension may raise an official-event caution flag, but SessionGuard must not claim to detect a Nasdaq/NYSE trading halt. Missing or stale Bitget data remains `MARKET_UNAVAILABLE`.

### Sanitized model context

Construct an immutable, hashed `AgentContext` containing the trigger, event evidence segments when present, Bitget snapshot, session state, active policy version, recent same-symbol decisions, outstanding-order state, and portfolio risk ratios. Do not send Qwen:

- wallet addresses, user IDs, cookies, SIWE messages, grant IDs, decision tokens, API credentials, or provider responses containing identifiers;
- exact balances or account equity; provide rounded exposure, concentration, collateral-buffer, and available-balance percentages instead;
- arbitrary URLs or text from non-allow-listed sources.

Context construction fails before model invocation when symbol/source binding, timestamps, required market data, portfolio freshness, or evidence hashes are inconsistent.

### Qwen contract

Production requires an explicit `QWEN_API_KEY`, `QWEN_BASE_URL`, pinned `QWEN_MODEL`, and versioned prompt ID when `AGENT_RUNTIME_ENABLED=1`. Qwen receives no tools and has no network, credential, policy-editing, grant, token, or order capability.

Add a versioned structured output equivalent to:

```ts
type AgentAssessmentV1 = {
  eventId: string | null;
  symbol: "RNVDAUSDT" | "RTSLAUSDT" | "RORCLUSDT";
  action: "BUY" | "REDUCE" | "HOLD" | "WAIT" | "ADD_COLLATERAL";
  proposedNotionalCents: number;
  novelty: "NEW" | "UPDATE" | "STALE" | "UNCLEAR";
  relevance: "HIGH" | "MEDIUM" | "LOW";
  confidence: number;
  thesis: string;
  risks: string[];
  evidence: Array<{ claim: string; segmentId: string }>;
};
```

- `BUY` is available only for `OFFICIAL_EVENT` contexts. Risk/session-only contexts may propose `REDUCE`, `HOLD`, `WAIT`, or `ADD_COLLATERAL`.
- `REDUCE` maps to a reduce-only spot sell and can never open a short. `ADD_COLLATERAL` always becomes a human alert; the agent cannot move funds.
- Qwen chooses the action and proposed size inside the supplied platform maximum. Code may reduce that size or veto it but must never turn `HOLD`/`WAIT` into a trade or increase Qwen's size.
- Use temperature `0.1`, a 15-second timeout, and at most one retry for a transport-level 429/5xx failure. Do not retry invalid, conflicting, or ungrounded output within the same run.
- Validate the schema, symbol/event binding, allowed action set, notional bounds, and every evidence segment ID. Any invalid JSON, timeout, missing evidence, invented segment, or conflict produces `AGENT_UNAVAILABLE`/`MODEL_OUTPUT_INVALID` and a fail-closed receipt.
- Persist model provider, pinned model, prompt version, latency, token usage, context hash, raw-response hash, and validated assessment. Do not persist the raw prompt or unrestricted raw response.

## 5. Deterministic authorization and autonomous execution

### Agent-specific hard limits

The existing production guard remains the only component capable of returning `TRADE`. Add an agent evidence layer and these limits, all stricter than or equal to the current platform rules:

- Cash-session-only PAPER_AUTO; `session === CASH_OPEN` must be true both at authorization and immediately before submission.
- Maximum automatic order: $100; maximum five automatic orders and $500 gross new automatic notional per UTC day. Existing $250/order, 20 orders/day, and $1,000 gross limits still apply across manual and agent activity.
- Minimum Qwen confidence: 0.80 for `BUY`, 0.65 for `REDUCE`. Autonomous buys additionally require `HIGH` relevance and `NEW` or `UPDATE` novelty.
- An official event used for a buy must be no more than 24 hours old and not superseded.
- One automatic action per user/event and a 60-minute automatic-order cooldown per user/symbol.
- No automatic submission while the same user/symbol has an outstanding or uncertain order.
- Maximum projected single-name rToken exposure of 20% of account equity and aggregate supported-rToken exposure of 40%.
- Apply the existing −3%, −8%, and −12% single-name gaps plus a correlated −12% shock across all supported rTokens. An increase is blocked if either −8% single-name or correlated stress breaches the user's collateral minimum.
- Block exposure increases when Demo equity is 3% or more below the first valid portfolio snapshot of the UTC day.
- User policy and grant limits may only tighten these platform limits.
- Global, user, symbol, model-health, provider-health, and agent-runtime kill switches are checked before token issuance and again before consumption.

`SHADOW` runs execute the full context, Qwen, and deterministic decision path but issue no capability and send no order. `ALERT_ONLY` behaves the same and sends actionable notifications. `PAPER_AUTO` may issue and consume a capability only when every gate passes. A `BLOCK`, `ALERT_ONLY`, `HOLD`, `WAIT`, or `ADD_COLLATERAL` path is structurally unable to call the executor.

### Seven-day SIWE agent grant

Do not reuse the normal sign-in statement, which explicitly says it does not authorize a transaction. Add a purpose-bound SIWE challenge whose stored message explicitly authorizes background Bitget Demo orders under a displayed scope.

The signed scope contains:

- user wallet and chain ID 42161;
- selected subset of the three supported symbols;
- actions `BUY` and `REDUCE` only;
- `executionMode: BITGET_DEMO` and literal `cashOpenOnly: true`;
- user-selected automatic order limit up to $100, at most five automatic orders/day, and at most $500 automatic gross new notional/day;
- active agent-policy/settings version, issue time, and server-set expiry exactly seven days later.

Grant challenges expire after ten minutes and are single use. Store the verified grant and SIWE message hash in PostgreSQL, not a reusable bearer secret. A background decision capability binds to the grant ID, grant hash, user, policy/settings versions, market/portfolio/context hashes, symbol, side, amount, nonce, and 90-second expiry.

Extend decision capabilities into a discriminated authority union: existing manual orders remain bound to `WALLET_SESSION`; autonomous orders are bound to `AGENT_GRANT`. They must use separate verification entry points so one authority cannot be substituted for the other.

- Enabling or renewing `PAPER_AUTO` requires the purpose-specific signature, a Demo connection with execution enabled, no unresolved Demo order, and completed shadow eligibility.
- Revocation, switching to a lower mode, Demo disconnect, account deletion, policy broadening attempt, or credential invalidation immediately disables PAPER_AUTO and invalidates unconsumed grant-bound capabilities.
- Revocation requires an authenticated session but never another signature. It must remain available even while providers are degraded.
- Expiry automatically demotes the user to `ALERT_ONLY` and sends warnings 24 hours and one hour before expiry.
- There is no automatic renewal and no `LIVE_AUTO` grant.

### Shadow eligibility

Record `shadowStartedAt` when a user explicitly enables `SHADOW`. PAPER_AUTO eligibility requires both:

1. at least 24 elapsed hours since that timestamp without disabling the agent; and
2. at least 10 distinct `LIVE_BITGET` runs that reached a valid Qwen assessment and deterministic decision.

Replay, manual test, duplicate, model-failed, stale-input, and infrastructure-failed runs do not count. Mode changes between `SHADOW` and `ALERT_ONLY` preserve qualifying history; `DISABLED`, account deletion, or an operator eligibility reset clears it. The UI must show both counters and the exact earliest eligibility time.

### Execution path

- Add background-safe `evaluateAgentProposal` and `executeAgentDecision` service methods; do not fabricate or borrow a browser session ID.
- Before execution, refresh Bitget quote, anchor, Demo portfolio, open orders, daily usage, event status, policy/settings versions, grant, eligibility, and all kill switches.
- Consume the grant-bound decision nonce atomically only after the recheck passes and immediately before reserving the order.
- Continue using the existing `BitgetDemoTradingAdapter`, forced `paperTrading: true`, deterministic `clientOid`, database reservation, and reconciliation flow.
- Replay agent runs use `LOCAL_REPLAY` only and are never allowed to enter the Bitget adapter.

## 6. State, interfaces, and UI

### Shared contracts

Add versioned schemas for:

- `AgentMode = DISABLED | SHADOW | ALERT_ONLY | PAPER_AUTO`;
- `AgentTriggerType = OFFICIAL_EVENT | SESSION_CHANGE | OFF_HOURS_MOVE | COLLATERAL_RISK | PRE_WEEKEND_SWEEP | MANUAL_SHADOW | OUTCOME_DUE`;
- `AgentRunState = QUEUED | CONTEXT_BUILDING | CONTEXT_READY | ASSESSING | AUTHORIZING | SHADOW_COMPLETE | ALERTED | BLOCKED | EXECUTION_READY | REVALIDATING | SUBMITTING | RECONCILING | MONITORING | OUTCOME_PENDING | COMPLETED | FAILED_CLOSED | DEDUPLICATED | EXPIRED`;
- `AgentAssessmentV1`, `AgentSettingsV1`, `AgentGrantV1`, `AgentRunV1`, `AgentRunTransitionV1`, and `AgentOutcomeV1`.

Every state change must pass an explicit transition table and append a transition record. Illegal or repeated transitions fail closed. Run responses expose sanitized context, assessment, deterministic decision, receipt, transition timeline, and outcome under one trace ID.

### API surface

Add tenant-scoped `/api/v1` routes:

- `GET /agent/status` — mode, worker heartbeat, provider/model health, queue counts, Demo connection, grant expiry, shadow eligibility, and relevant kill-switch state.
- `GET /agent/settings` and `PUT /agent/settings` — symbols and `DISABLED`/`SHADOW`/`ALERT_ONLY` settings. Lowering from PAPER_AUTO revokes its grant. PAPER_AUTO can be activated only through grant verification.
- `POST /agent/grants/challenge`, `POST /agent/grants/verify`, and `DELETE /agent/grants/current` — issue, verify/activate, and revoke the scoped seven-day authorization.
- `GET /agent/runs?cursor=&limit=` and `GET /agent/runs/:id` — cursor-paginated sanitized runs and a full trace.
- `POST /agent/runs/manual-shadow` — rate-limited, shadow-only evaluation; never eligible for execution or shadow counts.
- `POST /agent/replays/:replayId` — run the existing scenario through the orchestrator. Accept `analyst: RECORDED | QWEN`; clearly label recorded Qwen fixtures and always force `LOCAL_REPLAY`.
- `GET /agent/outcomes?cursor=&limit=` — scored executed, blocked, alerted, and shadow decisions.
- `GET /agent/stream` — authenticated SSE for status, run transition, receipt, and outcome updates.

All reads require the existing wallet session except the public replay catalogue. All mutations require same-origin protection, tenant checks, rate limits, and audit events. Grant issue/renewal uses its own purpose-bound SIWE proof. Extend account export and deletion to include/remove all tenant-owned agent records and revoke/cancel all grants/jobs.

### PostgreSQL and Redis

Create additive migration `migrations/0002_agent_runtime.sql` and keep SQLite parity for isolated tests. Add:

- `official_events` and `official_event_versions` for normalized source metadata, evidence segments, hashes, and supersession;
- `agent_settings` and `agent_grants` for tenant mode, limits, versions, SIWE proof hash, expiry, and revocation;
- `agent_triggers`, `agent_jobs`, and `agent_runs` with unique dedupe keys and lease/retry state;
- `agent_run_transitions` as append-only state evidence;
- `agent_outcomes` for observation windows and counterfactual measurements.

Continue using existing `decisions_v1`, `paper_orders`, notifications, portfolio snapshots, and immutable audit events. Never store raw decision capabilities, Qwen keys, Demo credentials, cookies, or plaintext notification destinations in agent tables.

Retention defaults:

- normalized document text and terminal jobs/triggers: 30 days;
- model operational metadata and notification attempts: 90 days;
- grants, runs, transitions, assessments, decisions, receipts, outcomes, and immutable audit evidence: one year;
- account deletion follows the existing immediate primary-store deletion and 35-day backup-expiry contract.

### Separate `/agent` experience

Build a responsive, WCAG 2.2 AA page using the established premium 2D SessionGuard visual system. Add only an `Agent` navigation link to the existing dashboard.

The page contains:

- an always-visible status strip for mode, worker heartbeat, Bitget/Qwen health, Demo connection, grant expiry, and cash-session state;
- a four-step onboarding gate: wallet, Demo connection, monitored symbols/notifications, then shadow progress;
- mode controls with PAPER_AUTO visibly locked until both shadow requirements pass, followed by an explicit grant review and wallet signature;
- an animated observe → assess → authorize → act/decline loop driven by persisted SSE transitions, with reduced-motion fallback;
- a run list and detail drawer showing trusted evidence, Qwen's proposed action/size, deterministic allowed action/size, reason codes, receipt, and trace timeline;
- outcome cards that distinguish realized Demo P&L, counterfactual blocked loss, missed upside, and insufficient-data outcomes without claiming profit;
- reliable Sunday Oracle and cash-open NVIDIA orchestrator replays, with source, analyst origin, and local-simulation labels visible at all times.

Do not add a chat composer, conversational persona, profit promise, live-money toggle, editable model prompt, or control that can loosen platform policy.

## 7. Outcome scoring

- Save the decision-time Bitget rToken quote and proposed/allowed notional for every assessed action.
- Capture the first fresh Bitget quote within five minutes of the next cash open, a fresh quote 60 minutes later, and the final valid Bitget candle in that cash session.
- For submitted Demo orders, report receipt/fill state and mark-to-market P&L from the reconciled fill when available; otherwise label it estimate-only.
- For blocked, alerted, and shadow proposals, calculate a clearly labelled counterfactual using the proposed side/notional and the decision-time Bitget quote. Never call positive counterfactuals “saved”; label negative outcomes “avoided loss” and positive outcomes “missed upside.”
- Compute maximum favorable/adverse excursion from retained Bitget samples, collateral-buffer change, and whether the event was superseded.
- An outcome with missing/stale observations remains `INSUFFICIENT_DATA`; it is never interpolated from a commercial or underlying-stock feed.
- Outcome reports may recommend policy changes offline, but the runtime cannot activate or loosen policy. Human-approved changes create a new tighten-only version.

## 8. Security, reliability, and observability

### Required failure behavior

| Failure | Behavior |
|---|---|
| Bitget quote/anchor or Demo portfolio unavailable/stale | Fail closed; no token; provider-degraded status and notification |
| SEC/IR outage | Retain prior immutable events, show degraded source, never invent an event |
| Qwen timeout, 429/5xx after retry, invalid JSON, or ungrounded evidence | `FAILED_CLOSED`; no capability; model-health metric degraded |
| PostgreSQL error | Global agent execution kill; readiness failure; operator page |
| Redis error | No new capability or execution; durable jobs remain in PostgreSQL |
| Expired/revoked/mismatched grant | Demote or block, atomically reject token, audit reason |
| Duplicate trigger/run | Return existing run; no repeated model call or order |
| Market, policy, event, portfolio, mode, or grant changes before submit | Invalidate capability and require a new run |
| Uncertain Demo response | `RECONCILING`; lookup by deterministic client ID; never blind retry |
| Notification failure | Retry/dead-letter notification only; never change the decision |

### Security controls

- Treat official document content as untrusted data and delimit it from system instructions. Reject prompt attempts to request secrets, tools, policy changes, or unsupported actions.
- Redact all agent HTTP bodies and model content from ordinary logs. Store hashes and validated structured fields only.
- Enforce tenant ownership in every repository query, grant, run, transition, outcome, and SSE channel.
- Require CSRF/same-origin protection and strict rate limits on settings, grants, manual runs, and replay runs.
- Audit opt-in, mode changes, eligibility reset, challenge/verification, grant renewal/revocation/expiry, every run terminal state, capability issuance/consumption, and every execution/reconciliation result.
- Add automated scans proving there is exactly one private adapter configuration and it always sets `paperTrading: true`; no `LIVE_AUTO` enum or path may exist.

### Metrics and objectives

Add metrics for source polling/detection delay, trigger/job queue age, run states, transition failures, Qwen latency/tokens/failure reasons, proposal and permission distributions, dedupe suppression, shadow eligibility, grant issue/expiry/revocation, capability issue/consume/reject, automatic submissions/reconciliation, outcome coverage, avoided loss/missed upside, and agent kill switches.

Production objectives:

- worker heartbeat and oldest runnable job below 30 seconds;
- detected-event-to-terminal-decision p95 below 30 seconds, excluding upstream publication polling delay;
- publication-to-detection p95 below five minutes;
- Qwen call p95 below 15 seconds and 100% schema/evidence validation before authorization;
- zero orders without a valid current grant and zero duplicate Demo submissions;
- 100% of agent runs have a trace, context hash, policy/settings version, and terminal or recoverable state;
- at least 99% of due outcomes scored within ten minutes of their observation window when Bitget is available.

Extend worker health, Prometheus rules, Grafana, Sentry context, OTEL spans, synthetic checks, incident runbooks, restore drills, and account-export/deletion tests for these signals. Model or event-source degradation must not make the core manual SessionGuard dashboard unavailable.

## 9. Verification plan

### Unit and contract tests

- Event URL allow-list, redirect/DNS/size/time limits, normalization, segmentation, hashing, dedupe, correction, and timestamp handling.
- Trigger thresholds, hysteresis, cooldowns, Friday/DST/holiday scheduling, and idempotency keys.
- Every legal state transition and rejection of every illegal/repeated transition.
- Context privacy projection, stable hashing, symbol/time/source consistency, and stale-field rejection.
- Qwen schema, action constraints, evidence IDs, confidence/relevance/novelty gates, timeout/retry limits, and prompt-injection fixtures.
- Exposure, concentration, daily drawdown, single/correlated stress, auto order/daily caps, reduce-only behavior, and kill-switch priority.
- Purpose-specific SIWE replay/domain/URI/chain/scope/expiry attacks, grant renewal/revocation/demotion, and manual-vs-agent token substitution.
- Counterfactual direction, avoided-loss/missed-upside labels, MFE/MAE, and insufficient-data outcomes.

### Integration and failure-injection tests

- SEC/IR fixture → durable trigger/job → context → mocked Qwen → guard → persisted run and notification.
- Cash-open valid event → valid grant → capability → SDK MockServer Demo order → reconciliation → outcome.
- Sunday event with Qwen `BUY` → deterministic `BLOCK` and structurally zero adapter calls.
- Extended-session, stale quote, missing anchor, stale portfolio, superseded event, low confidence, oversized proposal, concentration breach, correlated stress, and daily-loss breaker.
- Two workers claiming the same event/run and ten concurrent capability consumers produce one run and at most one reservation/submission.
- Crash after each persisted state, including immediately before/after reservation and an uncertain provider response; restart recovers without duplicate model calls or orders.
- PostgreSQL, Redis, Bitget, SEC/IR, Qwen, KMS, and notification outages each exhibit the required independent fail-closed behavior.
- Migrations apply idempotently on PostgreSQL 18, retain compatibility with the previous application during rolling deploy, and preserve immutable audit protection.

### Browser and acceptance journeys

- Opt in → observe shadow counters → remain locked before 24h/10 runs → become eligible exactly when both pass.
- Review the seven-day scope → sign purpose-specific SIWE → PAPER_AUTO becomes active → revoke without another signature.
- Watch a Sunday Oracle run animate Qwen `BUY $250` into deterministic `BLOCK $0`, receipt, and later counterfactual.
- Watch cash-open NVIDIA propose a buy, cap it to $100, revalidate, submit one Demo order, reconcile it, and display the outcome.
- Grant expires or cash closes between decision and execution → zero submission and clear reason.
- Mobile 390 px, keyboard-only, screen-reader names/status announcements, focus containment, WCAG contrast, reduced motion, reconnecting SSE, and empty/error/degraded states.
- Prove replay is always `LOCAL_REPLAY`, recorded assessments are labelled, and replays/manual runs do not advance eligibility.

CI must run type checks, complete unit/integration/E2E suites, real PostgreSQL/Redis concurrency and recovery tests, migrations, secret/dependency/container scans, production build, Qwen/SDK contract fixtures, and an execution-path scan that fails on any live-money branch.

## 10. Delivery and rollout

1. **Foundation:** land additive schemas, repository contracts, state machine, durable jobs, and feature-flagged worker code with `AGENT_RUNTIME_ENABLED=0`.
2. **Shadow:** enable internally with real Bitget and official sources; validate at least three cash sessions and one weekend, Qwen grounding, restart recovery, and no capability issuance.
3. **Alert-only:** enable for up to 25 opted-in users; validate delivery latency, noise/dedupe, source degradation, and outcome coverage.
4. **Internal PAPER_AUTO:** enable for at most 10 individually eligible users with valid seven-day grants. Hold for three cash sessions with zero grant violations, duplicates, or unresolved reconciliations.
5. **Staged beta:** expand PAPER_AUTO to 25, then 100, then the existing 500-user cap only after security review, restore drill, model/provider error budgets, and all objectives remain green.

Use additive migrations and rolling deploys. Activate the global agent execution kill switch during releases that change grants, capabilities, guard logic, or the executor; remove it only after readiness, a Sunday block replay, a cash-open local simulation, and reconciliation probes pass. Rollback never reverses the additive migration.

## 11. Final acceptance criteria

The agent implementation is 100% complete only when:

- a trusted trigger reaches a persisted decision without a dashboard click;
- Qwen independently proposes the action and size, but cannot execute, access secrets, or change policy;
- all non-trade paths are structurally unable to reach the adapter;
- PAPER_AUTO works only after 24 hours, 10 qualifying live runs, and a current scoped seven-day SIWE grant;
- autonomous submission is cash-open, Bitget Demo-only, revalidated, single-use, idempotent, and restart-safe;
- official-source ingestion, portfolio risk, notifications, outcomes, separate `/agent` UI, accessibility, and observability meet this contract;
- replay and live sources, recorded and live Qwen analysis, and local simulation versus Bitget Demo are always visibly distinct;
- all tests and release gates pass with no unresolved TODO, placeholder, security exception, live-money path, or plan gap;
- `AI_AGENT_PRODUCTION_AUDIT.md` maps every section to concrete code/tests/operations evidence, and `agent.md` is updated only after that comparison reports no gaps.

