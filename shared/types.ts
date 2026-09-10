import { z } from "zod";

export const supportedSymbols = ["RNVDAUSDT", "RTSLAUSDT", "RORCLUSDT"] as const;
export type SupportedSymbol = (typeof supportedSymbols)[number];

export const SupportedSymbolSchema = z.enum(supportedSymbols);
export const MarketSessionSchema = z.enum([
  "CASH_OPEN",
  "EXTENDED",
  "WEEKEND_HOLIDAY",
  "CLOSED",
]);
export type MarketSession = z.infer<typeof MarketSessionSchema>;

export const RiskFlagSchema = z.enum([
  "EARNINGS_WINDOW",
  "HALT",
  "STALE_QUOTE",
  "REFERENCE_UNAVAILABLE",
]);
export type RiskFlag = z.infer<typeof RiskFlagSchema>;

export const VerdictSchema = z.enum(["TRADE", "ALERT", "BLOCK"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const MarketSnapshotSchema = z.object({
  symbol: SupportedSymbolSchema,
  displaySymbol: z.string(),
  companyName: z.string(),
  sourceMode: z.enum(["live", "replay"]),
  session: MarketSessionSchema,
  flags: z.array(RiskFlagSchema),
  rTokenPrice: z.number().positive(),
  alignedReference: z.number().positive().nullable(),
  basisBps: z.number().nullable(),
  bid: z.number().positive(),
  ask: z.number().positive(),
  spreadBps: z.number().nonnegative(),
  quoteTime: z.string().datetime(),
  referenceTime: z.string().datetime().nullable(),
  nextCashOpen: z.string().datetime(),
  chart: z.array(
    z.object({
      time: z.string().datetime(),
      price: z.number().positive(),
    }),
  ),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const MarketEventSchema = z.object({
  id: z.string(),
  symbol: SupportedSymbolSchema,
  source: z.enum(["SEC", "IR", "REPLAY"]),
  sourceName: z.string(),
  sourceUrl: z.string().url(),
  headline: z.string().min(1),
  summary: z.string(),
  publishedAt: z.string().datetime(),
  detectedAt: z.string().datetime(),
  contentHash: z.string(),
  isOfficial: z.boolean(),
  formType: z.string().optional(),
});
export type MarketEvent = z.infer<typeof MarketEventSchema>;

export const AgentAssessmentSchema = z.object({
  summary: z.string().min(1),
  novelty: z.enum(["NEW", "UPDATE", "STALE", "UNCLEAR"]),
  effectiveAt: z.string().datetime(),
  relevance: z.enum(["HIGH", "MEDIUM", "LOW"]),
  confidence: z.number().min(0).max(1),
  proposedAction: z.enum(["BUY", "SELL", "HOLD"]),
  proposedNotional: z.number().nonnegative(),
  evidence: z.array(
    z.object({
      claim: z.string(),
      sourceUrl: z.string().url(),
    }),
  ),
});
export type AgentAssessment = z.infer<typeof AgentAssessmentSchema>;

export const TradingPolicySchema = z.object({
  maxPaperOrderUsd: z.number().positive().max(250).default(250),
  extendedSizePct: z.number().min(0).max(25).default(25),
  earningsSizePct: z.number().min(0).max(10).default(10),
  maxCashSpreadBps: z.number().positive().default(35),
  maxExtendedSpreadBps: z.number().positive().default(50),
  maxBasisBps: z.number().positive().default(100),
  minConfidence: z.number().min(0).max(1).default(0.65),
  minCollateralBufferPct: z.number().min(0).max(100).default(15),
});
export type TradingPolicy = z.infer<typeof TradingPolicySchema>;

export const AccountContextSchema = z.object({
  accountEquityUsd: z.number().positive().default(5000),
  currentPositionUsd: z.number().nonnegative().default(900),
  collateralBufferPct: z.number().min(0).max(100).default(24),
  usesRTokenAsCollateral: z.boolean().default(true),
});
export type AccountContext = z.infer<typeof AccountContextSchema>;

export const TradeIntentSchema = z.object({
  symbol: SupportedSymbolSchema,
  side: z.enum(["buy", "sell"]),
  notionalUsd: z.number().positive().max(250),
  eventId: z.string(),
  mode: z.enum(["live", "replay"]),
  policy: TradingPolicySchema.optional(),
  account: AccountContextSchema.optional(),
});
export type TradeIntent = z.infer<typeof TradeIntentSchema>;

export const GapScenarioSchema = z.object({
  gapPct: z.number(),
  pnlUsd: z.number(),
  projectedBufferPct: z.number(),
});
export type GapScenario = z.infer<typeof GapScenarioSchema>;

export const PermissionDecisionSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  verdict: VerdictSchema,
  symbol: SupportedSymbolSchema,
  requestedNotionalUsd: z.number().nonnegative(),
  allowedNotionalUsd: z.number().nonnegative(),
  reasons: z.array(z.string()).min(1),
  ruleCodes: z.array(z.string()).min(1),
  gaps: z.array(GapScenarioSchema),
  decisionToken: z.string().optional(),
  tokenExpiresAt: z.string().datetime().optional(),
  snapshot: MarketSnapshotSchema,
  assessment: AgentAssessmentSchema,
});
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const DecisionReceiptSchema = z.object({
  decision: PermissionDecisionSchema,
  event: MarketEventSchema,
  order: z
    .object({
      status: z.enum(["SIMULATED", "SUBMITTED", "FILLED", "REJECTED"]),
      orderId: z.string().optional(),
      message: z.string(),
      submittedAt: z.string().datetime(),
    })
    .nullable(),
});
export type DecisionReceipt = z.infer<typeof DecisionReceiptSchema>;

export const DemoConnectSchema = z.object({
  apiKey: z.string().min(8).max(128),
  secretKey: z.string().min(8).max(256),
  passphrase: z.string().min(1).max(128),
});
export type DemoConnectInput = z.infer<typeof DemoConnectSchema>;

export const PaperOrderSchema = z.object({
  decisionToken: z.string().min(20),
});

export const ReplayScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  kicker: z.string(),
  description: z.string(),
  snapshot: MarketSnapshotSchema,
  event: MarketEventSchema,
  assessment: AgentAssessmentSchema,
  intent: TradeIntentSchema,
  outcome: z.object({
    nextOpenPrice: z.number().positive(),
    plus60mPrice: z.number().positive(),
    cashClosePrice: z.number().positive(),
    samples: z.array(z.number().positive()).min(3),
    disclosure: z.literal("RECORDED_REPLAY_FIXTURE"),
  }).strict(),
});
export type ReplayScenario = z.infer<typeof ReplayScenarioSchema>;

export const defaultPolicy: TradingPolicy = TradingPolicySchema.parse({});
export const defaultAccount: AccountContext = AccountContextSchema.parse({});

