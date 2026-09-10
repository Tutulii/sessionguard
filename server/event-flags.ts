import type { MarketEvent, MarketSnapshot, RiskFlag } from "../shared/types.js";

const EARNINGS_LANGUAGE = /earnings|quarterly|results|financial results|10-q|10-k/i;
const HALT_LANGUAGE = /trading halt|trading suspended|suspension of trading/i;

export function applyEventRiskFlags(
  snapshot: MarketSnapshot,
  event: MarketEvent,
  at = new Date(snapshot.quoteTime),
): MarketSnapshot {
  const flags = new Set<RiskFlag>(snapshot.flags);
  const eventTime = new Date(event.publishedAt).getTime();
  const distanceHours = Math.abs(at.getTime() - eventTime) / 3_600_000;
  const eventText = `${event.formType ?? ""} ${event.headline} ${event.summary}`;

  if (EARNINGS_LANGUAGE.test(eventText) && distanceHours <= 48) flags.add("EARNINGS_WINDOW");
  if (HALT_LANGUAGE.test(eventText) && distanceHours <= 24) flags.add("HALT");

  return { ...snapshot, flags: [...flags] };
}
