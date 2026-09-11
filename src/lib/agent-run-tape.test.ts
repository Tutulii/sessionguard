import { describe, expect, it } from "vitest";
import type { AgentRunV1, AgentTriggerV1 } from "../../shared/agent-types";
import { buildAgentRunTape } from "./agent-run-tape";

function run(id: string, trigger: Partial<AgentTriggerV1>, options: {
  symbol?: AgentRunV1["symbol"];
  settingsVersion?: string;
  contentHash?: string;
  sourceMode?: AgentRunV1["sourceMode"];
} = {}) {
  return {
    id,
    symbol: options.symbol ?? "RORCLUSDT",
    settingsVersion: options.settingsVersion ?? "settings-v1",
    sourceMode: options.sourceMode ?? "LOCAL_REPLAY",
    context: {
      trigger: {
        type: "OFFICIAL_EVENT",
        replayId: null,
        eventId: null,
        facts: {},
        ...trigger,
      },
      event: options.contentHash ? { contentHash: options.contentHash } : null,
    },
  } as AgentRunV1;
}

describe("agent decision tape dedupe", () => {
  it("groups the same official content while preserving an amended filing", () => {
    const newest = run("newest", { replayId: "sunday-oracle" }, { contentHash: "a".repeat(64) });
    const duplicate = run("duplicate", { replayId: "sunday-oracle" }, { contentHash: "a".repeat(64) });
    const amendment = run("amendment", { replayId: "sunday-oracle" }, { contentHash: "b".repeat(64) });
    const live = run("live", { eventId: "official-id" }, { contentHash: "a".repeat(64), sourceMode: "LIVE_BITGET" });

    expect(buildAgentRunTape([newest, duplicate, amendment, live])).toEqual({
      items: [newest, amendment, live],
      collapsedCount: 1,
    });
  });

  it("groups legacy risk ticks but keeps new durable risk episodes separate", () => {
    const legacy = run("legacy-newest", { type: "COLLATERAL_RISK", facts: { collateralBandPct: 10 } });
    const legacyDuplicate = run("legacy-duplicate", { type: "COLLATERAL_RISK", facts: { collateralBandPct: 10 } });
    const firstEpisode = run("episode-1", { type: "COLLATERAL_RISK",
      facts: { collateralBandPct: 10, riskEpisode: "episode-one" } });
    const secondEpisode = run("episode-2", { type: "COLLATERAL_RISK",
      facts: { collateralBandPct: 10, riskEpisode: "episode-two" } });

    expect(buildAgentRunTape([legacy, legacyDuplicate, firstEpisode, secondEpisode])).toEqual({
      items: [legacy, firstEpisode, secondEpisode],
      collapsedCount: 1,
    });
  });
});
