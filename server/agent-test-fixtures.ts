import { createHash, randomUUID } from "node:crypto";
import {
  AgentAssessmentV1Schema,
  AgentContextV1Schema,
  AgentGrantV1Schema,
  AgentJobV1Schema,
  AgentRunTransitionV1Schema,
  AgentRunV1Schema,
  AgentSettingsV1Schema,
  AgentTriggerV1Schema,
  OfficialEventV1Schema,
  agentPolicy,
  type AgentContextV1,
  type AgentMode,
} from "../shared/agent-types.js";
import {
  ProductionMarketSnapshotSchema,
  PortfolioSnapshotSchema,
  defaultUserPolicy,
  platformPolicy,
  type ProductionSession,
  type ProductionSymbol,
} from "../shared/production-types.js";
import { productionHash } from "./production-rules.js";

export const testIds = Object.freeze({
  user: "11111111-1111-4111-8111-111111111111",
  otherUser: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  event: "22222222-2222-4222-8222-222222222222",
  eventVersion: "33333333-3333-4333-8333-333333333333",
  trigger: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  trace: "66666666-6666-4666-8666-666666666666",
  grant: "77777777-7777-4777-8777-777777777777",
});

export const cashTime = new Date("2026-09-15T15:00:00.000Z");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function testMarket(overrides: Record<string, unknown> = {}) {
  const symbol = (overrides.symbol as ProductionSymbol | undefined) ?? "RNVDAUSDT";
  const now = (overrides.receivedTimestamp as string | undefined) ?? cashTime.toISOString();
  return ProductionMarketSnapshotSchema.parse({
    symbol,
    displaySymbol: symbol === "RNVDAUSDT" ? "rNVDA" : symbol === "RTSLAUSDT" ? "rTSLA" : "rORCL",
    underlyingSymbol: symbol === "RNVDAUSDT" ? "NVDA" : symbol === "RTSLAUSDT" ? "TSLA" : "ORCL",
    companyName: symbol === "RNVDAUSDT" ? "NVIDIA" : symbol === "RTSLAUSDT" ? "Tesla" : "Oracle",
    dataMode: "LIVE_BITGET",
    sourceLabel: "LIVE BITGET",
    source: "BITGET",
    session: "CASH_OPEN" satisfies ProductionSession,
    rTokenPriceMicros: 100_000_000,
    bidPriceMicros: 99_990_000,
    askPriceMicros: 100_000_000,
    spreadBps: 1,
    referenceKind: "BITGET_CASH_SESSION_ANCHOR",
    referenceQuality: "OBSERVED",
    anchorPriceMicros: 99_000_000,
    offHoursMoveBps: 20,
    providerTimestamp: now,
    receivedTimestamp: now,
    quoteAgeMs: 0,
    referenceTimestamp: "2026-09-14T20:00:00.000Z",
    nextCashOpen: "2026-09-16T13:30:00.000Z",
    chart: [{ time: "2026-09-15T14:45:00.000Z", priceMicros: 99_500_000 }, { time: now, priceMicros: 100_000_000 }],
    ...overrides,
  });
}

export function testPortfolio(overrides: Record<string, unknown> = {}) {
  return PortfolioSnapshotSchema.parse({
    userId: testIds.user,
    accountEquityCents: 500_000,
    availableBalanceCents: 250_000,
    collateralBufferPct: 35,
    positions: [{ symbol: "RNVDAUSDT", quantityMicros: 5_000_000, marketValueCents: 50_000, usedAsCollateral: true }],
    openOrderCount: 0,
    source: "BITGET_DEMO",
    capturedAt: cashTime.toISOString(),
    ...overrides,
  });
}

export function testSettings(mode: AgentMode = "SHADOW", overrides: Record<string, unknown> = {}) {
  return AgentSettingsV1Schema.parse({
    version: 1,
    userId: testIds.user,
    mode,
    symbols: ["RNVDAUSDT", "RTSLAUSDT", "RORCLUSDT"],
    offHoursMoveThresholdBps: 100,
    minCollateralBufferPct: 15,
    automaticOrderLimitCents: 10_000,
    automaticOrdersPerDay: 5,
    automaticGrossNewNotionalCents: 50_000,
    notificationsEnabled: true,
    policyVersion: agentPolicy.version,
    settingsVersion: "settings-v1",
    shadowStartedAt: "2026-09-13T14:00:00.000Z",
    eligibilityResetAt: null,
    createdAt: "2026-09-13T14:00:00.000Z",
    updatedAt: "2026-09-13T14:00:00.000Z",
    ...overrides,
  });
}

export function testEvent(overrides: Record<string, unknown> = {}) {
  const text = (overrides.normalizedText as string | undefined) ?? "NVIDIA entered a new material agreement. The filing describes the agreement and its effective date.";
  const segment = { id: `seg-1-${sha(text).slice(0, 12)}`, index: 0, hash: sha(text), text };
  return OfficialEventV1Schema.parse({
    version: 1,
    id: testIds.event,
    versionId: testIds.eventVersion,
    symbol: "RNVDAUSDT",
    sourceType: "SEC_EDGAR",
    formType: "8-K",
    accessionId: "0001045810-26-000001",
    canonicalUrl: "https://www.sec.gov/Archives/edgar/data/1045810/fixture.htm",
    title: "NVIDIA 8-K material agreement",
    publishedAt: "2026-09-15T14:45:00.000Z",
    effectiveAt: "2026-09-15T14:45:00.000Z",
    detectedAt: "2026-09-15T14:46:00.000Z",
    contentHash: sha(`NVIDIA 8-K material agreement\n${text}`),
    documentHash: sha(text),
    normalizedText: text,
    evidence: [segment],
    cautionFlags: [],
    supersedesEventId: null,
    supersededByEventId: null,
    ...overrides,
  });
}

export function testTrigger(overrides: Record<string, unknown> = {}) {
  return AgentTriggerV1Schema.parse({
    version: 1,
    id: testIds.trigger,
    userId: testIds.user,
    type: "OFFICIAL_EVENT",
    symbol: "RNVDAUSDT",
    eventId: testIds.event,
    sourceMode: "LIVE_BITGET",
    replayId: null,
    dedupeKey: sha("test-trigger"),
    facts: { source: "SEC_EDGAR" },
    createdAt: cashTime.toISOString(),
    ...overrides,
  });
}

export function testContext(overrides: Record<string, unknown> = {}): AgentContextV1 {
  const event = testEvent(); const trigger = testTrigger(); const market = testMarket();
  const base = {
    version: 1 as const,
    trigger: (({ userId: _userId, ...safe }) => safe)(trigger),
    event: (({ normalizedText: _text, evidence: _evidence, ...safe }) => safe)(event),
    evidence: event.evidence,
    market: (({ chart: _chart, ...safe }) => safe)(market),
    portfolioRisk: { accountEquityBand: "1K_TO_5K" as const, availableBalancePct: 50, collateralBufferPct: 35,
      singleNameExposurePct: 10, aggregateExposurePct: 10, dailyDrawdownPct: 0, openOrderCount: 0 },
    recentDecisions: [], outstandingOrder: false, platformMaximumNotionalCents: platformPolicy.maxPaperOrderCents,
    policyVersion: agentPolicy.version, settingsVersion: "settings-v1", assembledAt: cashTime.toISOString(),
  };
  const candidate = { ...base, ...overrides }; const { contextHash: _hash, ...hashable } = candidate as typeof candidate & { contextHash?: string };
  return AgentContextV1Schema.parse({ ...hashable, contextHash: productionHash(hashable) });
}

export function testAssessment(overrides: Record<string, unknown> = {}) {
  const context = testContext();
  return AgentAssessmentV1Schema.parse({
    eventId: testIds.event,
    symbol: "RNVDAUSDT",
    action: "BUY",
    proposedNotionalCents: 15_000,
    novelty: "NEW",
    relevance: "HIGH",
    confidence: 0.91,
    thesis: "The new official filing supports a small Demo proposal.",
    risks: ["Session conditions can change before execution."],
    evidence: [{ claim: "The filing describes a material agreement.", segmentId: context.evidence[0].id }],
    ...overrides,
  });
}

export function testGrant(overrides: Record<string, unknown> = {}) {
  return AgentGrantV1Schema.parse({
    version: 1,
    id: testIds.grant,
    userId: testIds.user,
    walletAddress: "0x1111111111111111111111111111111111111111",
    chainId: 42161,
    symbols: ["RNVDAUSDT", "RTSLAUSDT", "RORCLUSDT"],
    actions: ["BUY", "REDUCE"],
    executionMode: "BITGET_DEMO",
    cashOpenOnly: true,
    automaticOrderLimitCents: 10_000,
    automaticOrdersPerDay: 5,
    automaticGrossNewNotionalCents: 50_000,
    policyVersion: agentPolicy.version,
    settingsVersion: "settings-v1",
    messageHash: sha("grant-message"),
    issuedAt: "2026-09-15T14:00:00.000Z",
    expiresAt: "2026-09-22T14:00:00.000Z",
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  });
}

export function testRun(overrides: Record<string, unknown> = {}) {
  return AgentRunV1Schema.parse({
    version: 1,
    id: testIds.run,
    traceId: testIds.trace,
    userId: testIds.user,
    triggerId: testIds.trigger,
    eventId: testIds.event,
    symbol: "RNVDAUSDT",
    sourceMode: "LIVE_BITGET",
    analystOrigin: "QWEN",
    modeAtStart: "SHADOW",
    policyVersion: agentPolicy.version,
    settingsVersion: "settings-v1",
    state: "QUEUED",
    qualifyingShadowRun: false,
    context: null,
    assessment: null,
    modelMetadata: null,
    authorization: null,
    receipt: null,
    failureCode: null,
    createdAt: cashTime.toISOString(),
    updatedAt: cashTime.toISOString(),
    terminalAt: null,
    ...overrides,
  });
}

export function testTransition(overrides: Record<string, unknown> = {}) {
  return AgentRunTransitionV1Schema.parse({ version: 1, id: randomUUID(), runId: testIds.run, userId: testIds.user,
    traceId: testIds.trace, fromState: null, toState: "QUEUED", reasonCode: "TRIGGER_ACCEPTED", metadata: {},
    createdAt: cashTime.toISOString(), ...overrides });
}

export function testJob(overrides: Record<string, unknown> = {}) {
  return AgentJobV1Schema.parse({ id: randomUUID(), runId: testIds.run, userId: testIds.user, kind: "PROCESS_RUN",
    status: "QUEUED", runAt: cashTime.toISOString(), attemptCount: 0, workerId: null, leaseExpiresAt: null,
    lastErrorCode: null, createdAt: cashTime.toISOString(), updatedAt: cashTime.toISOString(), ...overrides });
}

export function baseGuardInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: testIds.user,
    assessment: testAssessment(),
    context: testContext(),
    settings: testSettings("PAPER_AUTO"),
    grant: testGrant(),
    event: testEvent(),
    market: testMarket(),
    portfolio: testPortfolio(),
    userPolicy: defaultUserPolicy,
    userPolicyVersion: "default",
    platformUsage: { count: 0, grossNewNotionalCents: 0 },
    automaticUsage: { count: 0, grossNewNotionalCents: 0 },
    dailyBaselineEquityCents: 500_000,
    outstandingSameSymbolOrder: false,
    eventAlreadyActioned: false,
    symbolCooldownActive: false,
    eligibleForPaperAuto: true,
    killSwitches: { global: false, user: false, symbol: false, runtime: false, model: false, provider: false },
    now: cashTime,
    ...overrides,
  };
}
