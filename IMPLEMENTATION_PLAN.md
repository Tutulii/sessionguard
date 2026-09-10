# SessionGuard Premium Animated Frontend

## Summary

Create a React/Vite TypeScript application supported by a small Node/Fastify server and deployed as one Fly.io app.

The experience uses two routes:

- `/` — premium editorial landing page explaining the “two clocks, one price” problem.
- `/app` — interactive SessionGuard dashboard with live Bitget quotes, official-event monitoring, deterministic replays, Qwen analysis, permission gating, gap simulation, and Bitget demo-account execution.

A judge should be able to understand the problem and witness a weekend order being blocked within 60 seconds.

## Experience and Visual Direction

- Use a mature editorial-finance style with warm paper, deep ink, vermilion, marigold, muted sage, thick illustrated outlines, subtle grain, and self-hosted Fraunces and Instrument Sans fonts.
- Create a custom SVG geometric human trader in a blazer operating an illustrated market gate. Avoid stock illustrations and childish mascot styling.
- Use Framer Motion for gate, character, dual-clock, chart, ticker, receipt, counter, route, and scroll-triggered animation.
- Provide equally polished desktop and mobile compositions with a reduced-motion alternative.
- Build a landing hero, “Two clocks” explainer, four-step decision pipeline, animated intercepted-order preview, and CTA into the working demo.
- Build an app dashboard with asset switching, live/replay modes, session state, quote/reference/basis cards, official events, Qwen assessment, permission gate, gap and collateral simulation, decision receipts, and export.

## Product Behavior and Interfaces

- Model `marketSession` as `CASH_OPEN | EXTENDED | WEEKEND_HOLIDAY | CLOSED`, with independent flags including `EARNINGS_WINDOW`, `HALT`, `STALE_QUOTE`, and `REFERENCE_UNAVAILABLE`.
- Fetch current rToken quotes and candles from Bitget. Calculate the reference from the last completed rToken candle aligned with the US cash close and label it “last cash-aligned reference,” never “official Nasdaq close.”
- Monitor official SEC filing feeds and configurable issuer investor-relations feeds for NVIDIA, Tesla, and Oracle. Normalize and deduplicate events.
- Send verified event content to Qwen using a structured schema for summary, novelty, effective time, relevance, confidence, evidence, proposed action, and size.
- Keep final permission deterministic. Halts, stale data, missing references, invalid Qwen output, and rule errors fail closed. Weekend exposure increases are blocked. Position reductions may pass when quote and spread limits pass. Extended-hours and earnings trades receive reduced caps. Cash-open trades may proceed within configured limits.
- Use editable demo defaults: maximum $250 per paper order, 25% sizing during extended hours, 10% sizing inside an earnings window, and no exposure increase when the −8% scenario breaches the configured collateral buffer.
- Require a short-lived, single-use server decision token before paper execution.
- Use the official Bitget SDK with `paperTrading: true`; do not implement a live-money route.
- Support public visitors connecting their own Bitget demo keys. Encrypt credentials in server memory, associate them with a secure HttpOnly session cookie, expire them after 30 minutes, and never persist or log them.
- Store sanitized events, permission decisions, replay runs, and paper-order receipts in SQLite on a Fly volume.

Public server contracts:

- `GET /api/market/snapshot/:symbol`
- `GET /api/events`
- `POST /api/agent/evaluate`
- `POST /api/demo/connect`
- `DELETE /api/demo/session`
- `POST /api/demo/orders`
- `GET /api/decisions`
- `GET /api/decisions/export`
- `GET /api/replays`

Shared validated types: `MarketSnapshot`, `MarketEvent`, `AgentAssessment`, `PermissionDecision`, `GapScenario`, and `DecisionReceipt`.

## Test and Acceptance Plan

- Unit-test session calculations across weekends, holidays, DST, earnings overlays, basis, staleness, gap losses, collateral estimates, and rule priority.
- Verify Qwen timeouts, invalid output, feed failures, missing references, and stale quotes fail closed.
- Integration-test the Bitget SDK through its official mock server and prove `BLOCK` and `ALERT` cannot reach order placement.
- Verify decision tokens are single-use, expire, and bind symbol, side, and amount.
- Test credential expiry, log redaction, rate limits, feed deduplication, persistence, and replay fallback.
- Exercise desktop 1440×900 and mobile 390×844 flows for weekend block, cash-open paper execution, demo-key connection, offline fallback, filters, and export.
- Check keyboard access, screen-reader labels, contrast, reduced motion, touch targets, and overflow.
- Require a successful production build, test suite, Fly configuration validation, deterministic judge replay, and zero live-money code paths.

## Assumptions

- This is a new standalone project.
- The first release supports rNVDA, rTSLA, and rORCL.
- Official feeds provide event input; general social-media and third-party news ingestion are outside this milestone.
- Each visitor connects their own Bitget demo key.
- The implementation capability-checks rToken spot support in Bitget demo trading. If unavailable, authenticated execution stays disabled and replay execution uses the official SDK simulator with an explicit `SIMULATED` label.
- A thin backend is part of the deliverable because Qwen access, official feeds, secret isolation, audit persistence, and paper execution cannot safely run only in the browser.

