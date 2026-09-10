import { z } from "zod";
import { SupportedSymbolSchema, supportedSymbols } from "./types.js";

export { supportedSymbols };
export type ProductionSymbol = (typeof supportedSymbols)[number];

export const DataModeSchema = z.enum(["LIVE_BITGET", "REPLAY"]);
export type DataMode = z.infer<typeof DataModeSchema>;

export const ProductionSessionSchema = z.enum([
  "CASH_OPEN",
  "EXTENDED",
  "WEEKEND",
  "HOLIDAY",
  "MARKET_UNAVAILABLE",
]);
export type ProductionSession = z.infer<typeof ProductionSessionSchema>;

export const ReferenceKindSchema = z.literal("BITGET_CASH_SESSION_ANCHOR");
export type ReferenceKind = z.infer<typeof ReferenceKindSchema>;

export const ReferenceQualitySchema = z.enum(["OBSERVED", "DEGRADED", "MISSING"]);
export type ReferenceQuality = z.infer<typeof ReferenceQualitySchema>;

export const PermissionSchema = z.enum(["TRADE", "ALERT_ONLY", "BLOCK"]);
export type Permission = z.infer<typeof PermissionSchema>;

export const ExecutionModeSchema = z.enum(["BITGET_DEMO", "LOCAL_REPLAY"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const symbolMetadata: Record<ProductionSymbol, {
  displaySymbol: string;
  underlyingSymbol: "NVDA" | "TSLA" | "ORCL";
  companyName: string;
}> = {
  RNVDAUSDT: { displaySymbol: "rNVDA", underlyingSymbol: "NVDA", companyName: "NVIDIA" },
  RTSLAUSDT: { displaySymbol: "rTSLA", underlyingSymbol: "TSLA", companyName: "Tesla" },
  RORCLUSDT: { displaySymbol: "rORCL", underlyingSymbol: "ORCL", companyName: "Oracle" },
};

export const ProductionMarketSnapshotSchema = z.object({
  symbol: SupportedSymbolSchema,
  displaySymbol: z.string(),
  underlyingSymbol: z.enum(["NVDA", "TSLA", "ORCL"]),
  companyName: z.string(),
  dataMode: DataModeSchema,
  sourceLabel: z.enum(["LIVE BITGET", "REPLAY"]),
  source: z.literal("BITGET"),
  session: ProductionSessionSchema,
  rTokenPriceMicros: z.number().int().positive(),
  bidPriceMicros: z.number().int().positive(),
  askPriceMicros: z.number().int().positive(),
  spreadBps: z.number().nonnegative(),
  referenceKind: ReferenceKindSchema,
  referenceQuality: ReferenceQualitySchema,
  anchorPriceMicros: z.number().int().positive().nullable(),
  offHoursMoveBps: z.number().nullable(),
  providerTimestamp: z.string().datetime(),
  receivedTimestamp: z.string().datetime(),
  quoteAgeMs: z.number().int().nonnegative(),
  referenceTimestamp: z.string().datetime().nullable(),
  nextCashOpen: z.string().datetime(),
  chart: z.array(z.object({ time: z.string().datetime(), priceMicros: z.number().int().positive() })),
});
export type ProductionMarketSnapshot = z.infer<typeof ProductionMarketSnapshotSchema>;

export const platformPolicy = Object.freeze({
  version: "2026-09-09.1",
  maxPaperOrderCents: 25_000,
  extendedSizePct: 25,
  earningsSizePct: 10,
  maxOffHoursMoveBps: 100,
  maxCashSpreadBps: 35,
  maxExtendedSpreadBps: 50,
  minCollateralBufferPct: 15,
  dailyGrossNewNotionalCents: 100_000,
  dailyOrderCount: 20,
  quoteMaxAgeMs: 10_000,
  portfolioMaxAgeMs: 15_000,
  decisionTtlMs: 90_000,
});

export const UserPolicySchema = z.object({
  maxPaperOrderCents: z.number().int().min(100).max(platformPolicy.maxPaperOrderCents),
  extendedSizePct: z.number().min(0).max(platformPolicy.extendedSizePct),
  earningsSizePct: z.number().min(0).max(platformPolicy.earningsSizePct),
  maxOffHoursMoveBps: z.number().positive().max(platformPolicy.maxOffHoursMoveBps),
  maxCashSpreadBps: z.number().positive().max(platformPolicy.maxCashSpreadBps),
  maxExtendedSpreadBps: z.number().positive().max(platformPolicy.maxExtendedSpreadBps),
  minCollateralBufferPct: z.number().min(platformPolicy.minCollateralBufferPct).max(100),
  allowExtended: z.boolean(),
});
export type UserPolicy = z.infer<typeof UserPolicySchema>;

export const defaultUserPolicy: UserPolicy = {
  maxPaperOrderCents: platformPolicy.maxPaperOrderCents,
  extendedSizePct: platformPolicy.extendedSizePct,
  earningsSizePct: platformPolicy.earningsSizePct,
  maxOffHoursMoveBps: platformPolicy.maxOffHoursMoveBps,
  maxCashSpreadBps: platformPolicy.maxCashSpreadBps,
  maxExtendedSpreadBps: platformPolicy.maxExtendedSpreadBps,
  minCollateralBufferPct: platformPolicy.minCollateralBufferPct,
  allowExtended: true,
};

export const PortfolioPositionSchema = z.object({
  symbol: SupportedSymbolSchema,
  quantityMicros: z.number().int().nonnegative(),
  marketValueCents: z.number().int().nonnegative(),
  usedAsCollateral: z.boolean(),
});

export const PortfolioSnapshotSchema = z.object({
  userId: z.string().uuid(),
  accountEquityCents: z.number().int().positive(),
  availableBalanceCents: z.number().int(),
  collateralBufferPct: z.number().min(0).max(100),
  positions: z.array(PortfolioPositionSchema),
  openOrderCount: z.number().int().nonnegative(),
  source: z.enum(["BITGET_DEMO", "REPLAY"]),
  capturedAt: z.string().datetime(),
});
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshotSchema>;

export const GuardEvaluationSchema = z.object({
  symbol: SupportedSymbolSchema,
  side: z.enum(["buy", "sell"]),
  notionalCents: z.number().int().positive().max(platformPolicy.maxPaperOrderCents),
  maxSlippageBps: z.number().int().min(0).max(100).default(50),
  dataMode: DataModeSchema,
  replayId: z.string().optional(),
  earningsWindow: z.boolean().default(false),
});
export type GuardEvaluationInput = z.infer<typeof GuardEvaluationSchema>;

export const GapScenarioV1Schema = z.object({
  gapPct: z.number(),
  pnlCents: z.number().int(),
  projectedCollateralBufferPct: z.number(),
});
export type GapScenarioV1 = z.infer<typeof GapScenarioV1Schema>;

export const GuardDecisionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  createdAt: z.string().datetime(),
  permission: PermissionSchema,
  symbol: SupportedSymbolSchema,
  side: z.enum(["buy", "sell"]),
  requestedNotionalCents: z.number().int().positive(),
  allowedNotionalCents: z.number().int().nonnegative(),
  maxSlippageBps: z.number().int().nonnegative(),
  reasonCodes: z.array(z.string()).min(1),
  reasons: z.array(z.string()).min(1),
  gapScenarios: z.array(GapScenarioV1Schema),
  policyVersion: z.string(),
  inputHash: z.string(),
  marketHash: z.string(),
  portfolioHash: z.string(),
  snapshot: ProductionMarketSnapshotSchema,
  portfolioCapturedAt: z.string().datetime(),
  dataMode: DataModeSchema,
  decisionToken: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});
export type GuardDecision = z.infer<typeof GuardDecisionSchema>;

export const PaperOrderRequestSchema = z.object({ decisionToken: z.string().min(32) });

export const PaperOrderReceiptSchema = z.object({
  id: z.string().uuid(),
  decisionId: z.string().uuid(),
  userId: z.string().uuid(),
  clientOrderId: z.string(),
  executionMode: ExecutionModeSchema,
  status: z.enum(["RESERVED", "SUBMITTING", "SIMULATED", "SUBMITTED", "RECONCILING", "FILLED", "REJECTED"]),
  providerOrderId: z.string().nullable(),
  message: z.string(),
  submittedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  attemptCount: z.number().int().nonnegative(),
});
export type PaperOrderReceiptV1 = z.infer<typeof PaperOrderReceiptSchema>;

export const SiweNonceRequestSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.literal(42161).default(42161),
});
export const SiweVerifyRequestSchema = z.object({
  message: z.string().min(40).max(4096),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
});

export const PersistentDemoConnectSchema = z.object({
  apiKey: z.string().min(8).max(128),
  secretKey: z.string().min(8).max(256),
  passphrase: z.string().min(1).max(128),
});
export type PersistentDemoConnectInput = z.infer<typeof PersistentDemoConnectSchema>;

export const NotificationChannelSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["IN_APP", "TELEGRAM", "EMAIL", "WEB_PUSH"]),
  label: z.string(),
  verified: z.boolean(),
  createdAt: z.string().datetime(),
});
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationChannelInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("EMAIL"), email: z.string().email() }),
  z.object({ type: z.literal("TELEGRAM"), connectionToken: z.string().min(16).optional() }),
  z.object({
    type: z.literal("WEB_PUSH"),
    subscription: z.object({
      endpoint: z.string().url(),
      keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
    }),
  }),
]);

export const NotificationSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(["SESSION_TRANSITION", "OFF_HOURS_MOVE", "STRESS_BLOCK", "DECISION_BLOCKED", "CREDENTIAL", "ORDER"]),
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]),
  title: z.string(),
  body: z.string(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type PlatformNotification = z.infer<typeof NotificationSchema>;

export type AuthenticatedUser = {
  id: string;
  address: string;
  chainId: 42161;
  createdAt: string;
};
