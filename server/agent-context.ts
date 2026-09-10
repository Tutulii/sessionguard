import { createHash } from "node:crypto";
import {
  AgentContextV1Schema,
  type AgentContextV1,
  type AgentRunV1,
  type AgentSettingsV1,
  type AgentTriggerV1,
  type OfficialEventV1,
} from "../shared/agent-types.js";
import type { PortfolioSnapshot, ProductionMarketSnapshot } from "../shared/production-types.js";
import { platformPolicy } from "../shared/production-types.js";
import { productionHash } from "./production-rules.js";

function sha(value: string) { return createHash("sha256").update(value).digest("hex"); }
function rounded(value: number) { return Math.round(value * 10) / 10; }

export type AgentContextInput = {
  trigger: AgentTriggerV1;
  event: OfficialEventV1 | null;
  market: ProductionMarketSnapshot;
  portfolio: PortfolioSnapshot;
  settings: AgentSettingsV1;
  recentRuns: AgentRunV1[];
  outstandingOrder: boolean;
  dailyBaselineEquityCents: number;
  now?: Date;
};

export function assembleAgentContext(input: AgentContextInput): AgentContextV1 {
  const now = input.now ?? new Date(); const { trigger, event, market, portfolio, settings } = input;
  if (trigger.symbol !== market.symbol) throw new Error("CONTEXT_MARKET_SYMBOL_MISMATCH");
  if ((trigger.sourceMode === "LIVE_BITGET") !== (market.dataMode === "LIVE_BITGET")) throw new Error("CONTEXT_SOURCE_MODE_MISMATCH");
  if (portfolio.userId !== trigger.userId) throw new Error("CONTEXT_PORTFOLIO_TENANT_MISMATCH");
  if (trigger.sourceMode === "LIVE_BITGET" && trigger.eventId !== (event?.id ?? null)) throw new Error("CONTEXT_EVENT_BINDING_MISMATCH");
  if (event && event.symbol !== trigger.symbol) throw new Error("CONTEXT_EVENT_SYMBOL_MISMATCH");
  if (trigger.sourceMode === "LIVE_BITGET" && event && (new Date(event.publishedAt).getTime() > new Date(event.detectedAt).getTime() + 60_000 ||
    new Date(event.effectiveAt).getTime() > now.getTime() + 5 * 60_000)) throw new Error("CONTEXT_EVENT_TIME_INVALID");
  if (market.dataMode === "LIVE_BITGET" && (market.quoteAgeMs > platformPolicy.quoteMaxAgeMs ||
    now.getTime() - new Date(portfolio.capturedAt).getTime() > platformPolicy.portfolioMaxAgeMs)) throw new Error("CONTEXT_INPUT_STALE");
  if (trigger.sourceMode === "LIVE_BITGET" && market.providerTimestamp > market.receivedTimestamp) throw new Error("CONTEXT_MARKET_TIME_INVALID");
  for (const segment of event?.evidence ?? []) if (sha(segment.text) !== segment.hash) throw new Error("CONTEXT_EVIDENCE_HASH_MISMATCH");

  const evidence = []; let characters = 0;
  for (const segment of event?.evidence ?? []) {
    if (evidence.length >= 20 || characters + segment.text.length > 16_000) break;
    evidence.push(segment); characters += segment.text.length;
  }
  if (event && !evidence.length) throw new Error("CONTEXT_EVIDENCE_MISSING");
  const equity = Math.max(1, portfolio.accountEquityCents);
  const position = portfolio.positions.find((item) => item.symbol === trigger.symbol)?.marketValueCents ?? 0;
  const aggregate = portfolio.positions.reduce((sum, item) => sum + item.marketValueCents, 0);
  const dailyDrawdownPct = Math.max(0, (input.dailyBaselineEquityCents - equity) / Math.max(1, input.dailyBaselineEquityCents) * 100);
  const { userId: _triggerUserId, ...safeTrigger } = trigger;
  const safeEvent = event ? (({ normalizedText: _text, evidence: _evidence, ...metadata }) => metadata)(event) : null;
  const { chart: _chart, ...safeMarket } = market;
  const withoutHash = {
    version: 1 as const,
    trigger: safeTrigger,
    event: safeEvent,
    evidence,
    market: safeMarket,
    portfolioRisk: {
      accountEquityBand: (equity < 50_000 ? "UNDER_500" : equity < 100_000 ? "500_TO_1K" : equity <= 500_000 ? "1K_TO_5K" : "OVER_5K") as
        "UNDER_500" | "500_TO_1K" | "1K_TO_5K" | "OVER_5K",
      availableBalancePct: rounded(portfolio.availableBalanceCents / equity * 100),
      collateralBufferPct: rounded(portfolio.collateralBufferPct),
      singleNameExposurePct: rounded(position / equity * 100),
      aggregateExposurePct: rounded(aggregate / equity * 100),
      dailyDrawdownPct: rounded(dailyDrawdownPct),
      openOrderCount: portfolio.openOrderCount,
    },
    recentDecisions: input.recentRuns.filter((run) => run.assessment && run.authorization).slice(0, 10).map((run) => ({
      action: run.assessment!.action, permission: run.authorization!.permission,
      ageMinutes: Math.max(0, rounded((now.getTime() - new Date(run.createdAt).getTime()) / 60_000)),
    })),
    outstandingOrder: input.outstandingOrder,
    // Qwen may express intent up to the platform proposal ceiling; deterministic code applies the stricter $100 agent/user/grant cap.
    platformMaximumNotionalCents: platformPolicy.maxPaperOrderCents,
    policyVersion: settings.policyVersion,
    settingsVersion: settings.settingsVersion,
    assembledAt: now.toISOString(),
  };
  const contextHash = productionHash(withoutHash);
  return AgentContextV1Schema.parse({ ...withoutHash, contextHash });
}
