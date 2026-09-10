# SessionGuard Advanced Agent Architecture

## 1. Objective

Turn SessionGuard from an interactive permission desk into an always-on, event-driven trading-risk agent for Bitget rTokens.

The advanced agent is **not a chatbot** and is not an autonomous stock picker. It continuously observes verified market and event inputs, proposes a response with Qwen, applies deterministic portfolio policy, executes only permitted paper actions, alerts the user when judgment is required, and records every outcome.

The governing rule remains:

> Qwen interprets. Deterministic code authorizes. Bitget Demo executes.

## 2. Core design principles

1. **The model has no execution authority.** Qwen never receives credentials, decision tokens, or an order tool.
2. **Official inputs first.** Trade-relevant events must originate from SEC EDGAR or configured issuer investor-relations feeds.
3. **Fail closed.** Missing, stale, malformed, conflicting, or unverifiable inputs result in `BLOCK` or `ALERT`, never a trade.
4. **Portfolio-aware decisions.** Permission considers total exposure, collateral, concentration, correlated holdings, and outstanding orders—not only the proposed order.
5. **Event-driven and idempotent.** The same event and market state cannot create duplicate executions.
6. **Paper-only by construction.** Every SDK client uses `paperTrading: true`; there is no live-money configuration branch.
7. **Policy changes require a human.** The system may measure and recommend new thresholds, but it cannot rewrite its own deterministic policy.
8. **Every action is explainable.** Inputs, policy version, model output, rule results, notification, execution, and later outcome share one trace ID.

## 3. System architecture

```text
                       OFFICIAL / MARKET INPUTS
          +------------------+-------------------+----------------+
          |                  |                   |                |
     Bitget market       SEC EDGAR          Issuer IR       Market calendar
     quote/candles       filing feed         RSS/Atom       + session clock
          |                  |                   |                |
          +------------------+-------------------+----------------+
                                     |
                          1. INGEST + NORMALIZE
                    schema validation, timestamps, hashes,
                     source allow-list, deduplication
                                     |
                              DURABLE EVENT BUS
                       SQLite jobs for the hackathon MVP
                                     |
                          2. TRIGGER EVALUATOR
                 new event / basis move / session transition /
                  pre-weekend sweep / stale data / risk breach
                                     |
                          3. CONTEXT ASSEMBLER
                 quote + reference + session + event + portfolio
                   + policy version + recent decision memory
                                     |
                          4. QWEN EVENT ANALYST
                    structured interpretation and proposal
                          (untrusted advisory output)
                                     |
                        5. DETERMINISTIC RISK ENGINE
                 session + liquidity + basis + event + portfolio
                      + limits + cooldown + kill switch
                           /           |           \
                      BLOCK          ALERT         TRADE
                        |              |              |
                  receipt only   notify / approve   short-lived,
                                               single-use permission
                                                     |
                                           6. PAPER EXECUTOR
                                      fresh market recheck + SDK
                                           `paperTrading: true`
                                                     |
                          7. RECEIPT + OUTCOME MONITOR
                 immutable audit, fill state, next-open result,
                  avoided loss, drawdown, calibration metrics
```

## 4. Agent responsibilities

### 4.1 Market Watcher

Code-only service that:

- Polls Bitget quotes and candles for rNVDA, rTSLA, and rORCL.
- Computes bid/ask spread, quote age, cash-aligned reference, and basis.
- Emits a trigger only when a material state change occurs.
- Uses adaptive polling: faster near session transitions or active events, slower while idle.
- Marks stale or unavailable data explicitly instead of substituting replay data.

### 4.2 Official Event Watcher

Code-only service that:

- Polls SEC EDGAR and configured official IR feeds.
- Normalizes timestamps, symbols, source URLs, form types, and content hashes.
- Deduplicates by source identifier and content hash.
- Records detection time separately from publication/effective time.
- Rejects non-allow-listed sources for autonomous evaluation.

### 4.3 Trigger Evaluator

Deterministic service that decides when a full agent run is justified. Supported triggers:

- New verified SEC or IR event.
- Basis crosses a configured threshold.
- Spread or quote freshness deteriorates.
- Session changes between `CASH_OPEN`, `EXTENDED`, `CLOSED`, and `WEEKEND_HOLIDAY`.
- Pre-weekend portfolio sweep before Friday cash close.
- Approaching earnings window or detected halt.
- Collateral buffer falls below its warning threshold.
- Previously blocked event reaches the next cash open and requires outcome scoring.

Triggers use debounce, cooldown, and deduplication keys so a noisy quote cannot create an evaluation storm.

### 4.4 Context Assembler

Builds one immutable `AgentContext` containing:

- Trigger and trace identifiers.
- Current market snapshot and source timestamps.
- Verified official event and content hash.
- Current and next US cash-session state.
- Requested action, if any.
- Positions, open paper orders, available balance, and rToken collateral usage.
- Per-symbol and portfolio stress scenarios.
- Recent decisions for the same symbol and event.
- Active policy version and emergency controls.

If any required field is missing or internally inconsistent, context construction fails closed before Qwen is called.

### 4.5 Qwen Event Analyst

Qwen receives only the verified event package and sanitized market context. It returns schema-validated JSON:

```ts
type AgentAssessment = {
  summary: string;
  novelty: "NEW" | "UPDATE" | "STALE" | "UNCLEAR";
  effectiveAt: string;
  relevance: "HIGH" | "MEDIUM" | "LOW";
  confidence: number;
  proposedAction: "BUY" | "SELL" | "HOLD";
  proposedNotional: number;
  evidence: Array<{ claim: string; sourceUrl: string }>;
};
```

Additional grounding controls:

- Evidence URLs must match the verified source package.
- The response is rejected if its timestamp or symbol conflicts with the event.
- Prompt and model versions are stored with the run.
- Timeout, invalid JSON, schema failure, or ungrounded evidence produces `AGENT_UNAVAILABLE` and a block.

### 4.6 Deterministic Portfolio Risk Engine

This is the only authority capable of returning `TRADE`.

It evaluates rules in a fixed priority order:

1. Emergency kill switch and account lock.
2. Data freshness and reference availability.
3. Halt and session restrictions.
4. Event verification and Qwen validity.
5. Duplicate-event, cooldown, and outstanding-order checks.
6. Spread and basis limits.
7. Per-order, per-symbol, portfolio, and daily notional limits.
8. Earnings and extended-hours size caps.
9. Gap, collateral, concentration, and correlated-exposure stress.
10. Action/confidence/novelty compatibility.

Recommended portfolio controls:

- Maximum paper order: `$250`.
- Maximum aggregate rToken exposure: configurable percentage of paper equity.
- Maximum single-name exposure: configurable percentage of rToken exposure.
- Extended-hours size: at most `25%` of normal size.
- Earnings-window size: at most `10%` of normal size.
- Weekend and weekday-overnight exposure increases: `BLOCK`.
- Reductions during dark sessions: permitted only with fresh quotes and acceptable spread.
- −3%, −8%, and −12% single-name gap tests.
- Correlated shock scenario for multiple technology rTokens.
- No increase when the −8% scenario breaches the configured collateral buffer.
- Daily loss, order-count, and notional circuit breakers.

The output is a signed `PermissionDecision` with rule codes, reasons, allowed amount, policy version, input hashes, and expiry.

### 4.7 Execution Coordinator

Code-only service that:

- Accepts only a `TRADE` decision carrying a valid short-lived token.
- Locks the decision ID to prevent concurrent duplicate submission.
- Re-fetches quote, spread, session, basis, flags, account state, and capability immediately before execution.
- Invalidates permission when material conditions changed.
- Uses a deterministic idempotency key derived from the decision ID.
- Calls only the official Bitget SDK configured with `paperTrading: true`.
- Stores the final SDK response after removing sensitive fields.

`BLOCK` and `ALERT` decisions never receive an execution token, so they cannot reach this component.

### 4.8 Notification and Human Escalation Service

Delivers concise, actionable messages through in-app notifications and optionally Telegram, push, or email.

Notification classes:

- `INFO` — session transition or outcome update.
- `WARNING` — basis/spread/collateral threshold approaching.
- `ACTION_REQUIRED` — agent recommends a paper action but policy requires approval.
- `BLOCKED` — an attempted or proposed action was refused.
- `EXECUTED` — a permitted paper order was submitted.

Each notification contains the symbol, session, quote age, basis, requested/allowed amount, primary rule, and a link to the receipt. Secrets and raw model prompts are never included.

### 4.9 Outcome Monitor

After a decision, the monitor records:

- Price at decision time.
- Price at the next cash open.
- Maximum favorable and adverse excursion over configured windows.
- Paper P&L for executed decisions.
- Counterfactual P&L for blocked or alerted decisions.
- Collateral-buffer change.
- Whether the event was later amended or superseded.

It can recommend policy adjustments in an offline report. Applying a recommendation requires explicit human approval and creates a new versioned policy.

## 5. Agent state machine

```text
IDLE
  -> TRIGGERED
  -> CONTEXT_BUILDING
  -> CONTEXT_READY
  -> ASSESSING
  -> AUTHORIZING
       -> BLOCKED -> RECORDED -> OUTCOME_PENDING
       -> ALERT_PENDING -> APPROVED / REJECTED / EXPIRED
       -> EXECUTION_READY -> REVALIDATING -> SUBMITTING
  -> MONITORING
  -> OUTCOME_SCORED
  -> IDLE
```

Terminal safety transitions can occur from every active state:

- Invalid input -> `BLOCKED`.
- Timeout -> `BLOCKED` or `EXPIRED`.
- Kill switch -> `BLOCKED`.
- Duplicate run -> `DEDUPLICATED`.
- Changed market conditions -> `REVALIDATION_FAILED`.
- SDK uncertainty -> `EXECUTION_UNKNOWN`, followed by order-status reconciliation; never blind retry.

## 6. Autonomy levels

| Level | Behavior | Recommended use |
|---|---|---|
| `REPLAY` | Deterministic historical scenario and SDK MockServer | Public judge demo |
| `SHADOW` | Live inputs and decisions, no order submission | Default first deployment |
| `ALERT_ONLY` | Live monitoring and actionable notifications | User observation period |
| `PAPER_AUTO` | Automatically submits only deterministic `TRADE` decisions | Opt-in after shadow validation |

There is intentionally no `LIVE_AUTO` level.

## 7. Durable data model

SQLite remains sufficient for a single Fly.io instance during the hackathon.

Recommended tables:

- `events` — normalized verified events and content hashes.
- `market_snapshots` — sampled quotes, references, basis, spread, session, and flags.
- `agent_runs` — trace, trigger, state, model/prompt version, timestamps, and failure code.
- `decisions` — immutable sanitized permission decisions and policy version.
- `orders` — paper submission, reconciliation, and final state.
- `positions` — sanitized demo portfolio snapshots.
- `outcomes` — next-open and counterfactual measurements.
- `notification_jobs` — channel, delivery state, retries, and deduplication key.
- `policies` — versioned thresholds and human approval metadata.
- `worker_leases` — prevents duplicate processing when more than one worker exists.

Credentials and raw decision tokens must never enter the database.

## 8. Job and concurrency model

For the hackathon build:

- Use a durable SQLite job table.
- Run one in-process worker beside Fastify.
- Claim jobs with a lease and transaction.
- Use `eventId + symbol + triggerType + policyVersion` as the idempotency key.
- Retry read operations with bounded exponential backoff and jitter.
- Never automatically retry an order submission unless Bitget confirms that the idempotency key was not accepted.
- Reconcile uncertain submissions through order lookup before any next action.

For multi-instance production, replace the SQLite queue and leases with a managed queue and transactional database while preserving the same state machine and contracts.

## 9. Suggested interfaces

### Internal contracts

```ts
interface Trigger {
  id: string;
  type: "OFFICIAL_EVENT" | "BASIS_MOVE" | "SESSION_CHANGE" | "RISK_SWEEP" | "OUTCOME_DUE";
  symbol: SupportedSymbol;
  occurredAt: string;
  dedupeKey: string;
}

interface AgentRun {
  id: string;
  traceId: string;
  state: AgentRunState;
  autonomy: "REPLAY" | "SHADOW" | "ALERT_ONLY" | "PAPER_AUTO";
  trigger: Trigger;
  contextHash?: string;
  policyVersion: string;
  assessment?: AgentAssessment;
  decisionId?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}
```

### Additional API routes

- `GET /api/agent/status` — worker, mode, last heartbeat, queue depth, and kill-switch state.
- `GET /api/agent/runs` — sanitized recent runs.
- `GET /api/agent/runs/:id` — full trace and state transitions.
- `POST /api/agent/runs` — manually trigger an evaluation for testing; no direct order request.
- `POST /api/agent/mode` — switch among shadow, alert-only, and paper-auto after reauthentication.
- `POST /api/agent/kill-switch` — immediately prevent new execution permissions.
- `GET /api/outcomes` — decision and counterfactual scorecards.
- `GET /api/policies` — active and historical policy versions.
- `POST /api/policies` — validate and activate a human-approved policy revision.
- `POST /api/notifications/test` — test a configured delivery channel without market action.

All mutations require the existing same-origin header, authenticated session, strict rate limiting, and audit logging.

## 10. Failure behavior

| Failure | Required behavior |
|---|---|
| Bitget quote unavailable | Mark source unavailable, block permission, retain replay as separately labeled option |
| Quote stale | `BLOCK` with `STALE_QUOTE` |
| Cash-aligned reference missing | `BLOCK` with `REFERENCE_UNAVAILABLE` |
| SEC/IR feed unavailable | Keep prior verified events, report source degradation, do not invent an event |
| Qwen timeout or invalid output | `BLOCK` with `AGENT_UNAVAILABLE` |
| Conflicting event symbol/source | Reject context before model invocation |
| Database or policy error | Activate execution kill switch and alert operator |
| Duplicate trigger | Return the existing run; do not evaluate or execute again |
| Market changes before submission | Invalidate the token and require a new run |
| Order response uncertain | Reconcile by idempotency key; never blind retry |
| Notification failure | Retry notification only; never alter the trading decision |

## 11. Security boundaries

- Qwen receives no API credentials, cookies, account identifiers, or order capability.
- Demo credentials remain AES-256-GCM encrypted in the expiring in-memory vault.
- Logs use structured redaction and never serialize request bodies containing credentials.
- Database records store session hashes rather than raw session IDs.
- Decision tokens are signed, short-lived, single-use, session-bound, and absent from exports.
- Policy activation and autonomy changes require recent user authentication.
- A server-side kill switch is checked both when issuing and consuming permission.
- External URLs are allow-listed and fetched with timeouts, size limits, and safe content parsing.
- All public output identifies replay, live data, simulated orders, and submitted demo orders distinctly.

## 12. Observability

Track operational and product metrics without recording secrets:

- Event-to-decision latency.
- Runs by trigger and terminal state.
- `TRADE`, `ALERT`, and `BLOCK` rates.
- Blocks by deterministic rule code.
- Quote/reference age and upstream availability.
- Qwen latency, timeout rate, schema-failure rate, and token usage.
- Duplicate triggers suppressed.
- Decision-token issue, expiry, and consumption counts.
- Paper submission and reconciliation outcomes.
- Avoided-loss and counterfactual outcome distributions.
- Maximum paper drawdown and collateral-buffer minimum.
- Notification delivery latency and failure rate.
- Agent heartbeat and queue depth.

## 13. Testing strategy

### Unit

- Trigger thresholds, deduplication, debounce, cooldown, and session transitions.
- Portfolio aggregation, concentration, correlated shocks, daily limits, and kill switch.
- State-machine transitions and illegal transition rejection.
- Grounded Qwen evidence validation.
- Policy versioning and input hashing.

### Integration

- SEC/IR ingestion to queued run.
- Live snapshot to deterministic decision.
- Qwen failure to fail-closed receipt.
- Permission token to Bitget SDK MockServer order.
- Uncertain order to reconciliation without duplication.
- Notification retry independent of decision state.

### End-to-end

- Sunday headline -> automatic `BLOCK` -> receipt -> next-open counterfactual.
- Cash-open official event -> permitted paper order -> filled receipt.
- Pre-weekend leveraged portfolio -> warning with recommended USDT buffer.
- Duplicate event -> one run and at most one paper order.
- Kill switch during revalidation -> no submission.
- Restart during a run -> durable recovery from the last safe state.

## 14. Implementation mapping to the current codebase

### Foundation already implemented

- Market data: `server/market.ts`
- Market sessions: `server/session-engine.ts`
- Event normalization: `server/events.ts`
- Event risk flags: `server/event-flags.ts`
- Qwen adapter: `server/qwen.ts`
- Deterministic policy: `server/rules.ts`
- Permission tokens: `server/decision-token.ts`
- Bitget Demo/MockServer execution: `server/bitget-demo.ts`
- SQLite receipts: `server/store.ts`
- API and security boundary: `server/app.ts`
- Trader interface: `src/pages/DashboardPage.tsx`

### New modules for the advanced agent

```text
server/agent/
  orchestrator.ts        owns the observe-to-outcome loop
  state-machine.ts       validates every run transition
  trigger-evaluator.ts   creates deduplicated triggers
  context-assembler.ts   builds immutable validated context
  portfolio-risk.ts      aggregates exposure and stress
  execution-coordinator.ts revalidates and submits paper orders
  outcome-monitor.ts     scores executed and blocked decisions
  worker.ts              durable job claiming and recovery

server/notifications/
  service.ts             channel-independent notification jobs
  telegram.ts            optional Telegram delivery adapter

server/agent-store.ts    runs, jobs, policies, outcomes, leases
shared/agent-types.ts    trigger, run, state, outcome schemas
```

The existing rule engine stays the execution authority; the orchestrator calls it rather than replacing it.

## 15. Recommended delivery order

### Phase A — Autonomous shadow loop

1. Add durable triggers, jobs, run state, and heartbeat.
2. Connect official events and session transitions to the orchestrator.
3. Run context -> Qwen -> deterministic policy automatically.
4. Persist and display agent runs without executing orders.

### Phase B — Portfolio intelligence

1. Load sanitized demo account positions and balances.
2. Add concentration, aggregate exposure, correlation, and daily circuit breakers.
3. Add the Friday pre-weekend risk sweep.

### Phase C — Notifications and paper automation

1. Add in-app and Telegram delivery jobs.
2. Add autonomy-mode controls and server kill switch.
3. Enable `PAPER_AUTO` only after a clean shadow-mode acceptance period.
4. Revalidate immediately before every demo submission.

### Phase D — Outcome calibration

1. Capture next-cash-open and drawdown outcomes.
2. Compare allowed, blocked, and counterfactual results.
3. Generate human-reviewed policy recommendations.

## 16. Hackathon demo sequence

1. Start the agent in `SHADOW` mode with the Sunday Oracle replay queued as an official-event trigger.
2. Show the run automatically progress through context, Qwen, and policy states.
3. Show Qwen proposing `BUY $250` while deterministic policy returns `BLOCK $0` because the cash market is dark.
4. Open the receipt and show the exact input hashes and rule codes.
5. Switch to the cash-open NVIDIA replay and `PAPER_AUTO`.
6. Show a `TRADE` decision, fresh-condition revalidation, one-time token consumption, and official SDK MockServer receipt.
7. Open the outcome panel and compare the blocked weekend counterfactual with the permitted cash-open paper action.

This demonstrates genuine agency: the system observes, reasons, refuses or acts, records, and evaluates—without relying on a chat window.

## 17. Completion criteria

The advanced architecture is complete when:

- The loop runs from trigger through receipt without a dashboard click.
- Restarts do not duplicate an evaluation or order.
- Every state transition is persisted and traceable.
- Qwen cannot access execution capabilities.
- All `BLOCK` and `ALERT` paths are structurally unable to submit.
- Portfolio and collateral limits apply before token issuance.
- Shadow, alert-only, and paper-auto modes behave distinctly.
- The kill switch prevents token issuance and consumption.
- Paper orders are revalidated and idempotent.
- Outcomes are scored for both executed and blocked decisions.
- Desktop/mobile UI exposes agent health, mode, runs, receipts, and outcomes.
- All unit, integration, browser, accessibility, restart-recovery, and failure-injection tests pass.
- No live-money path exists.

## 18. Non-goals

- Conversational chatbot interface.
- Social-media rumor ingestion for autonomous trading.
- Profit guarantees or directional stock prediction.
- Self-modifying runtime policy.
- Shared custodial API keys.
- Live-money order execution.
