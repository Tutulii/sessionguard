import { z } from "zod";
import {
  GuardDecisionSchema,
  PaperOrderReceiptSchema,
  PortfolioSnapshotSchema,
  ProductionMarketSnapshotSchema,
  type ProductionSymbol,
} from "./production-types.js";
import { SupportedSymbolSchema, supportedSymbols } from "./types.js";

export const agentPolicy = Object.freeze({
  version: "2026-09-09.agent.1",
  promptVersion: "sessionguard-agent-v1",
  grantLifetimeMs: 7 * 86_400_000,
  grantChallengeTtlMs: 10 * 60_000,
  decisionTtlMs: 90_000,
  jobLeaseMs: 60_000,
  jobHeartbeatMs: 15_000,
  maxAutomaticOrderCents: 10_000,
  maxAutomaticOrdersPerUtcDay: 5,
  maxAutomaticGrossNewNotionalCents: 50_000,
  minimumShadowAgeMs: 24 * 60 * 60_000,
  minimumQualifyingShadowRuns: 10,
  minimumBuyConfidence: 0.8,
  minimumReduceConfidence: 0.65,
  maximumEventAgeMs: 24 * 60 * 60_000,
  symbolCooldownMs: 60 * 60_000,
  maximumSingleNameExposurePct: 20,
  maximumAggregateExposurePct: 40,
  maximumDailyDrawdownPct: 3,
});

export const AgentModeSchema = z.enum(["DISABLED", "SHADOW", "ALERT_ONLY", "PAPER_AUTO"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const AgentTriggerTypeSchema = z.enum([
  "OFFICIAL_EVENT",
  "SESSION_CHANGE",
  "OFF_HOURS_MOVE",
  "COLLATERAL_RISK",
  "PRE_WEEKEND_SWEEP",
  "MANUAL_SHADOW",
  "OUTCOME_DUE",
]);
export type AgentTriggerType = z.infer<typeof AgentTriggerTypeSchema>;

export const AgentRunStateSchema = z.enum([
  "QUEUED",
  "CONTEXT_BUILDING",
  "CONTEXT_READY",
  "ASSESSING",
  "AUTHORIZING",
  "SHADOW_COMPLETE",
  "ALERTED",
  "BLOCKED",
  "EXECUTION_READY",
  "REVALIDATING",
  "SUBMITTING",
  "RECONCILING",
  "MONITORING",
  "OUTCOME_PENDING",
  "COMPLETED",
  "FAILED_CLOSED",
  "DEDUPLICATED",
  "EXPIRED",
]);
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;

export const terminalAgentRunStates = new Set<AgentRunState>([
  "COMPLETED", "FAILED_CLOSED", "DEDUPLICATED", "EXPIRED",
]);

export const agentRunTransitions: Readonly<Record<AgentRunState, readonly AgentRunState[]>> = Object.freeze({
  QUEUED: ["CONTEXT_BUILDING", "DEDUPLICATED", "EXPIRED", "FAILED_CLOSED"],
  CONTEXT_BUILDING: ["CONTEXT_READY", "FAILED_CLOSED", "EXPIRED"],
  CONTEXT_READY: ["ASSESSING", "FAILED_CLOSED", "EXPIRED"],
  ASSESSING: ["AUTHORIZING", "FAILED_CLOSED", "EXPIRED"],
  AUTHORIZING: ["SHADOW_COMPLETE", "ALERTED", "BLOCKED", "EXECUTION_READY", "FAILED_CLOSED", "EXPIRED"],
  SHADOW_COMPLETE: ["OUTCOME_PENDING", "COMPLETED"],
  ALERTED: ["OUTCOME_PENDING", "COMPLETED"],
  BLOCKED: ["OUTCOME_PENDING", "COMPLETED"],
  EXECUTION_READY: ["REVALIDATING", "FAILED_CLOSED", "EXPIRED"],
  REVALIDATING: ["SUBMITTING", "BLOCKED", "FAILED_CLOSED", "EXPIRED"],
  SUBMITTING: ["RECONCILING", "MONITORING", "FAILED_CLOSED"],
  RECONCILING: ["MONITORING", "FAILED_CLOSED"],
  MONITORING: ["OUTCOME_PENDING", "COMPLETED", "FAILED_CLOSED"],
  OUTCOME_PENDING: ["COMPLETED", "FAILED_CLOSED"],
  COMPLETED: [],
  FAILED_CLOSED: [],
  DEDUPLICATED: [],
  EXPIRED: [],
});

export function assertAgentRunTransition(from: AgentRunState, to: AgentRunState) {
  if (!(agentRunTransitions[from] as readonly AgentRunState[]).includes(to)) {
    throw new Error(`ILLEGAL_AGENT_TRANSITION:${from}->${to}`);
  }
}

export const AgentAssessmentV1Schema = z.object({
  eventId: z.string().uuid().nullable(),
  symbol: SupportedSymbolSchema,
  action: z.enum(["BUY", "REDUCE", "HOLD", "WAIT", "ADD_COLLATERAL"]),
  proposedNotionalCents: z.number().int().min(0).max(25_000),
  novelty: z.enum(["NEW", "UPDATE", "STALE", "UNCLEAR"]),
  relevance: z.enum(["HIGH", "MEDIUM", "LOW"]),
  confidence: z.number().min(0).max(1),
  thesis: z.string().min(1).max(1_500),
  risks: z.array(z.string().min(1).max(400)).max(10),
  evidence: z.array(z.object({ claim: z.string().min(1).max(500), segmentId: z.string().min(1).max(128) })).max(20),
}).strict();
export type AgentAssessmentV1 = z.infer<typeof AgentAssessmentV1Schema>;

export const AgentSettingsV1Schema = z.object({
  version: z.literal(1),
  userId: z.string().uuid(),
  mode: AgentModeSchema,
  symbols: z.array(SupportedSymbolSchema).min(1).max(supportedSymbols.length),
  offHoursMoveThresholdBps: z.number().int().min(10).max(100),
  minCollateralBufferPct: z.number().min(15).max(100),
  automaticOrderLimitCents: z.number().int().min(100).max(agentPolicy.maxAutomaticOrderCents),
  automaticOrdersPerDay: z.number().int().min(1).max(agentPolicy.maxAutomaticOrdersPerUtcDay),
  automaticGrossNewNotionalCents: z.number().int().min(100).max(agentPolicy.maxAutomaticGrossNewNotionalCents),
  notificationsEnabled: z.boolean(),
  policyVersion: z.string().min(1).max(128),
  settingsVersion: z.string().min(1).max(128),
  shadowStartedAt: z.string().datetime().nullable(),
  eligibilityResetAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().refine((value) => new Set(value.symbols).size === value.symbols.length, {
  message: "Duplicate monitored symbols are not allowed.", path: ["symbols"],
});
export type AgentSettingsV1 = z.infer<typeof AgentSettingsV1Schema>;

export function defaultAgentSettings(userId: string, now = new Date()): AgentSettingsV1 {
  const at = now.toISOString();
  return {
    version: 1,
    userId,
    mode: "DISABLED",
    symbols: [...supportedSymbols],
    offHoursMoveThresholdBps: 100,
    minCollateralBufferPct: 15,
    automaticOrderLimitCents: agentPolicy.maxAutomaticOrderCents,
    automaticOrdersPerDay: agentPolicy.maxAutomaticOrdersPerUtcDay,
    automaticGrossNewNotionalCents: agentPolicy.maxAutomaticGrossNewNotionalCents,
    notificationsEnabled: true,
    policyVersion: agentPolicy.version,
    settingsVersion: "initial",
    shadowStartedAt: null,
    eligibilityResetAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

export const AgentGrantV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  userId: z.string().uuid(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.literal(42161),
  symbols: z.array(SupportedSymbolSchema).min(1).max(supportedSymbols.length),
  actions: z.array(z.enum(["BUY", "REDUCE"])).min(1).max(2),
  executionMode: z.literal("BITGET_DEMO"),
  cashOpenOnly: z.literal(true),
  automaticOrderLimitCents: z.number().int().min(100).max(agentPolicy.maxAutomaticOrderCents),
  automaticOrdersPerDay: z.number().int().min(1).max(agentPolicy.maxAutomaticOrdersPerUtcDay),
  automaticGrossNewNotionalCents: z.number().int().min(100).max(agentPolicy.maxAutomaticGrossNewNotionalCents),
  policyVersion: z.string().min(1),
  settingsVersion: z.string().min(1),
  messageHash: z.string().length(64),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  revokedReason: z.string().max(128).nullable(),
}).strict();
export type AgentGrantV1 = z.infer<typeof AgentGrantV1Schema>;

export const AgentGrantChallengeSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  nonce: z.string().min(8),
  message: z.string().min(40).max(4096),
  scopeHash: z.string().length(64),
  scope: z.object({
    symbols: z.array(SupportedSymbolSchema).min(1).max(supportedSymbols.length),
    actions: z.array(z.enum(["BUY", "REDUCE"])).min(1).max(2),
    automaticOrderLimitCents: z.number().int().min(100).max(agentPolicy.maxAutomaticOrderCents),
    automaticOrdersPerDay: z.number().int().min(1).max(agentPolicy.maxAutomaticOrdersPerUtcDay),
    automaticGrossNewNotionalCents: z.number().int().min(100).max(agentPolicy.maxAutomaticGrossNewNotionalCents),
  }).strict(),
  grantExpiresAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
}).strict();
export type AgentGrantChallenge = z.infer<typeof AgentGrantChallengeSchema>;

export const EvidenceSegmentSchema = z.object({
  id: z.string().min(1).max(128),
  index: z.number().int().nonnegative(),
  hash: z.string().length(64),
  text: z.string().min(1).max(4_000),
}).strict();
export type EvidenceSegment = z.infer<typeof EvidenceSegmentSchema>;

export const OfficialEventV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  versionId: z.string().uuid(),
  symbol: SupportedSymbolSchema,
  sourceType: z.enum(["SEC_EDGAR", "ISSUER_IR", "REPLAY_FIXTURE"]),
  formType: z.enum(["8-K", "10-Q", "10-K", "6-K", "IR_RELEASE"]),
  accessionId: z.string().min(1).max(256),
  canonicalUrl: z.string().url(),
  title: z.string().min(1).max(500),
  publishedAt: z.string().datetime(),
  effectiveAt: z.string().datetime(),
  detectedAt: z.string().datetime(),
  contentHash: z.string().length(64),
  documentHash: z.string().length(64),
  normalizedText: z.string().min(1).max(64_000),
  evidence: z.array(EvidenceSegmentSchema).min(1),
  cautionFlags: z.array(z.enum(["POSSIBLE_SUSPENSION_LANGUAGE", "CORRECTION", "LATE_DETECTION"])),
  supersedesEventId: z.string().uuid().nullable(),
  supersededByEventId: z.string().uuid().nullable(),
}).strict();
export type OfficialEventV1 = z.infer<typeof OfficialEventV1Schema>;

export const AgentTriggerV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  userId: z.string().uuid(),
  type: AgentTriggerTypeSchema,
  symbol: SupportedSymbolSchema,
  eventId: z.string().uuid().nullable(),
  sourceMode: z.enum(["LIVE_BITGET", "LOCAL_REPLAY"]),
  replayId: z.string().max(128).nullable(),
  dedupeKey: z.string().length(64),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: z.string().datetime(),
}).strict();
export type AgentTriggerV1 = z.infer<typeof AgentTriggerV1Schema>;

export const SanitizedPortfolioRiskSchema = z.object({
  accountEquityBand: z.enum(["UNDER_500", "500_TO_1K", "1K_TO_5K", "OVER_5K"]),
  availableBalancePct: z.number(),
  collateralBufferPct: z.number(),
  singleNameExposurePct: z.number(),
  aggregateExposurePct: z.number(),
  dailyDrawdownPct: z.number(),
  openOrderCount: z.number().int().nonnegative(),
}).strict();

export const AgentContextV1Schema = z.object({
  version: z.literal(1),
  trigger: AgentTriggerV1Schema.omit({ userId: true }),
  event: OfficialEventV1Schema.omit({ normalizedText: true, evidence: true }).nullable(),
  evidence: z.array(EvidenceSegmentSchema).max(20),
  market: ProductionMarketSnapshotSchema.omit({ chart: true }),
  portfolioRisk: SanitizedPortfolioRiskSchema,
  recentDecisions: z.array(z.object({ action: z.string(), permission: z.string(), ageMinutes: z.number().nonnegative() })).max(10),
  outstandingOrder: z.boolean(),
  platformMaximumNotionalCents: z.number().int().positive().max(25_000),
  policyVersion: z.string(),
  settingsVersion: z.string(),
  assembledAt: z.string().datetime(),
  contextHash: z.string().length(64),
}).strict();
export type AgentContextV1 = z.infer<typeof AgentContextV1Schema>;

export const AgentAuthorizationV1Schema = z.object({
  permission: z.enum(["TRADE", "ALERT_ONLY", "BLOCK"]),
  requestedNotionalCents: z.number().int().nonnegative(),
  allowedNotionalCents: z.number().int().nonnegative(),
  side: z.enum(["buy", "sell"]).nullable(),
  reasonCodes: z.array(z.string()).min(1),
  reasons: z.array(z.string()).min(1),
  guardDecision: GuardDecisionSchema.nullable(),
}).strict();
export type AgentAuthorizationV1 = z.infer<typeof AgentAuthorizationV1Schema>;

export const AgentModelMetadataSchema = z.object({
  provider: z.literal("QWEN"),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  latencyMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  contextHash: z.string().length(64),
  rawResponseHash: z.string().length(64),
}).strict();

export const AgentRunV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  traceId: z.string().uuid(),
  userId: z.string().uuid(),
  triggerId: z.string().uuid(),
  eventId: z.string().uuid().nullable(),
  symbol: SupportedSymbolSchema,
  sourceMode: z.enum(["LIVE_BITGET", "LOCAL_REPLAY"]),
  analystOrigin: z.enum(["QWEN", "RECORDED"]),
  modeAtStart: AgentModeSchema,
  policyVersion: z.string(),
  settingsVersion: z.string(),
  state: AgentRunStateSchema,
  qualifyingShadowRun: z.boolean(),
  context: AgentContextV1Schema.nullable(),
  assessment: AgentAssessmentV1Schema.nullable(),
  modelMetadata: AgentModelMetadataSchema.nullable(),
  authorization: AgentAuthorizationV1Schema.nullable(),
  receipt: PaperOrderReceiptSchema.nullable(),
  failureCode: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  terminalAt: z.string().datetime().nullable(),
}).strict();
export type AgentRunV1 = z.infer<typeof AgentRunV1Schema>;

export const AgentRunTransitionV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string().uuid(),
  traceId: z.string().uuid(),
  fromState: AgentRunStateSchema.nullable(),
  toState: AgentRunStateSchema,
  reasonCode: z.string().min(1).max(128),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: z.string().datetime(),
}).strict();
export type AgentRunTransitionV1 = z.infer<typeof AgentRunTransitionV1Schema>;

export const AgentOutcomeV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string().uuid(),
  symbol: SupportedSymbolSchema,
  status: z.enum(["PENDING", "REALIZED_DEMO", "ESTIMATE_ONLY", "AVOIDED_LOSS", "MISSED_UPSIDE", "NEUTRAL", "INSUFFICIENT_DATA"]),
  decisionPriceMicros: z.number().int().positive(),
  proposedNotionalCents: z.number().int().nonnegative(),
  allowedNotionalCents: z.number().int().nonnegative(),
  nextOpenPriceMicros: z.number().int().positive().nullable(),
  plus60mPriceMicros: z.number().int().positive().nullable(),
  cashClosePriceMicros: z.number().int().positive().nullable(),
  pnlCents: z.number().int().nullable(),
  mfeBps: z.number().nullable(),
  maeBps: z.number().nullable(),
  collateralBufferChangePct: z.number().nullable(),
  eventSuperseded: z.boolean(),
  observationDueAt: z.string().datetime(),
  scoredAt: z.string().datetime().nullable(),
  label: z.string().min(1).max(200),
}).strict();
export type AgentOutcomeV1 = z.infer<typeof AgentOutcomeV1Schema>;

export const AgentJobV1Schema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(["PROCESS_RUN", "OUTCOME_NEXT_OPEN", "OUTCOME_60M", "OUTCOME_CLOSE", "GRANT_EXPIRY"]),
  status: z.enum(["QUEUED", "LEASED", "COMPLETED", "FAILED"]),
  runAt: z.string().datetime(),
  attemptCount: z.number().int().nonnegative(),
  workerId: z.string().nullable(),
  leaseExpiresAt: z.string().datetime().nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type AgentJobV1 = z.infer<typeof AgentJobV1Schema>;

export type AgentRunDetail = AgentRunV1 & { transitions: AgentRunTransitionV1[]; outcome: AgentOutcomeV1 | null };

export type AgentEligibility = {
  eligible: boolean;
  qualifyingRuns: number;
  requiredRuns: number;
  shadowStartedAt: string | null;
  earliestEligibleAt: string | null;
  ageRequirementMet: boolean;
  runsRequirementMet: boolean;
};

export type AgentStatusV1 = {
  runtimeEnabled: boolean;
  mode: AgentMode;
  workerHeartbeatAt: string | null;
  workerHealthy: boolean;
  qwenHealth: "HEALTHY" | "DEGRADED" | "DISABLED";
  bitgetHealth: "HEALTHY" | "DEGRADED";
  sourceHealth: "HEALTHY" | "DEGRADED";
  cashSession: "CASH_OPEN" | "EXTENDED" | "WEEKEND" | "HOLIDAY" | "MARKET_UNAVAILABLE";
  queue: { runnable: number; leased: number; oldestRunnableAgeMs: number };
  demo: { connected: boolean; executionEnabled: boolean };
  grant: { active: boolean; expiresAt: string | null; warning: "NONE" | "24_HOURS" | "ONE_HOUR" | "EXPIRED" };
  eligibility: AgentEligibility;
  killSwitches: { global: boolean; user: boolean; runtime: boolean; model: boolean; provider: boolean; symbols: Partial<Record<ProductionSymbol, boolean>> };
};

export const UpdateAgentSettingsSchema = z.object({
  mode: z.enum(["DISABLED", "SHADOW", "ALERT_ONLY"]),
  symbols: z.array(SupportedSymbolSchema).min(1).max(supportedSymbols.length),
  offHoursMoveThresholdBps: z.number().int().min(10).max(100),
  minCollateralBufferPct: z.number().min(15).max(100),
  automaticOrderLimitCents: z.number().int().min(100).max(agentPolicy.maxAutomaticOrderCents),
  automaticOrdersPerDay: z.number().int().min(1).max(agentPolicy.maxAutomaticOrdersPerUtcDay),
  automaticGrossNewNotionalCents: z.number().int().min(100).max(agentPolicy.maxAutomaticGrossNewNotionalCents),
  notificationsEnabled: z.boolean(),
}).strict().refine((value) => new Set(value.symbols).size === value.symbols.length, {
  message: "Duplicate monitored symbols are not allowed.", path: ["symbols"],
});

export const AgentGrantScopeInputSchema = z.object({
  symbols: z.array(SupportedSymbolSchema).min(1).max(supportedSymbols.length),
  actions: z.array(z.enum(["BUY", "REDUCE"])).min(1).max(2),
  automaticOrderLimitCents: z.number().int().min(100).max(agentPolicy.maxAutomaticOrderCents),
  automaticOrdersPerDay: z.number().int().min(1).max(agentPolicy.maxAutomaticOrdersPerUtcDay),
  automaticGrossNewNotionalCents: z.number().int().min(100).max(agentPolicy.maxAutomaticGrossNewNotionalCents),
}).strict()
  .refine((value) => new Set(value.symbols).size === value.symbols.length, { message: "Duplicate grant symbols are not allowed.", path: ["symbols"] })
  .refine((value) => new Set(value.actions).size === value.actions.length, { message: "Duplicate grant actions are not allowed.", path: ["actions"] });

export const AgentGrantVerifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  message: z.string().min(40).max(4096),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
}).strict();

export const ManualShadowRequestSchema = z.object({
  symbol: SupportedSymbolSchema,
  triggerType: z.enum(["SESSION_CHANGE", "OFF_HOURS_MOVE", "COLLATERAL_RISK", "PRE_WEEKEND_SWEEP"]).default("SESSION_CHANGE"),
}).strict();

export const ReplayAgentRequestSchema = z.object({ analyst: z.enum(["RECORDED", "QWEN"]) }).strict();

export function portfolioRiskProjection(portfolio: z.infer<typeof PortfolioSnapshotSchema>, symbol: ProductionSymbol) {
  const equity = Math.max(1, portfolio.accountEquityCents);
  const supported = portfolio.positions.reduce((sum, item) => sum + item.marketValueCents, 0);
  const named = portfolio.positions.find((item) => item.symbol === symbol)?.marketValueCents ?? 0;
  return {
    accountEquityBand: (equity < 50_000 ? "UNDER_500" : equity < 100_000 ? "500_TO_1K" : equity <= 500_000 ? "1K_TO_5K" : "OVER_5K") as
      "UNDER_500" | "500_TO_1K" | "1K_TO_5K" | "OVER_5K",
    availableBalancePct: portfolio.availableBalanceCents / equity * 100,
    collateralBufferPct: portfolio.collateralBufferPct,
    singleNameExposurePct: named / equity * 100,
    aggregateExposurePct: supported / equity * 100,
    dailyDrawdownPct: 0,
    openOrderCount: portfolio.openOrderCount,
  };
}
