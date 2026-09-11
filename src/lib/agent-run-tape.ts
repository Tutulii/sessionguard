import type { AgentRunV1 } from "../../shared/agent-types";

export type AgentRunTape = {
  items: AgentRunV1[];
  collapsedCount: number;
};

function textFact(value: string | number | boolean | null | undefined) {
  return typeof value === "string" && value.length ? value : null;
}

function numberFact(value: string | number | boolean | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function semanticIdentity(run: AgentRunV1) {
  const trigger = run.context?.trigger;
  if (!trigger) return null;

  if (trigger.type === "OFFICIAL_EVENT") {
    const contentHash = textFact(run.context?.event?.contentHash) ?? textFact(trigger.facts.contentHash);
    const replayId = trigger.replayId ?? textFact(trigger.facts.replayId);
    const eventIdentity = contentHash ?? trigger.eventId ?? replayId;
    return eventIdentity ? `OFFICIAL_EVENT:${run.sourceMode}:${run.symbol}:${eventIdentity}` : null;
  }

  if (trigger.type === "COLLATERAL_RISK") {
    const band = numberFact(trigger.facts.collateralBandPct);
    if (band === null) return null;
    const episode = textFact(trigger.facts.riskEpisode);
    return episode
      ? `COLLATERAL_RISK:${run.symbol}:${episode}:${band}`
      : `LEGACY_COLLATERAL_RISK:${run.symbol}:${run.settingsVersion}:${band}`;
  }

  return null;
}

/**
 * Groups legacy duplicate decisions for the console without mutating the
 * append-only audit history. The API export remains the source of every row.
 */
export function buildAgentRunTape(runs: AgentRunV1[]): AgentRunTape {
  const seen = new Set<string>();
  const items: AgentRunV1[] = [];
  let collapsedCount = 0;

  for (const run of runs) {
    const identity = semanticIdentity(run);
    if (identity && seen.has(identity)) {
      collapsedCount += 1;
      continue;
    }
    if (identity) seen.add(identity);
    items.push(run);
  }

  return { items, collapsedCount };
}
