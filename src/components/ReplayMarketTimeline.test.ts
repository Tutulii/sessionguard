import { describe, expect, it } from "vitest";
import { replayScenarios } from "../../shared/replays";
import { symbolMetadata, type ProductionMarketSnapshot } from "../../shared/production-types";
import { deriveReplayFrame } from "./ReplayMarketTimeline";

function replaySnapshot(id: string): ProductionMarketSnapshot {
  const scenario = replayScenarios.find((item) => item.id === id);
  if (!scenario) throw new Error("Replay fixture missing");
  const source = scenario.snapshot;
  return {
    symbol: source.symbol,
    ...symbolMetadata[source.symbol],
    dataMode: "REPLAY",
    sourceLabel: "REPLAY",
    source: "BITGET",
    session: source.session === "CASH_OPEN" ? "CASH_OPEN" : source.session === "EXTENDED" ? "EXTENDED" : "WEEKEND",
    rTokenPriceMicros: Math.round(source.rTokenPrice * 1_000_000),
    bidPriceMicros: Math.round(source.bid * 1_000_000),
    askPriceMicros: Math.round(source.ask * 1_000_000),
    spreadBps: source.spreadBps,
    referenceKind: "BITGET_CASH_SESSION_ANCHOR",
    referenceQuality: source.alignedReference === null ? "MISSING" : "OBSERVED",
    anchorPriceMicros: source.alignedReference === null ? null : Math.round(source.alignedReference * 1_000_000),
    offHoursMoveBps: source.basisBps,
    providerTimestamp: source.quoteTime,
    receivedTimestamp: "2026-09-09T00:00:00.000Z",
    quoteAgeMs: 0,
    referenceTimestamp: source.referenceTime,
    nextCashOpen: source.nextCashOpen,
    chart: source.chart.map((point) => ({ time: point.time, priceMicros: Math.round(point.price * 1_000_000) })),
  };
}

describe("replay frame projection", () => {
  it("projects each recorded tick without changing the authoritative fixture", () => {
    const snapshot = replaySnapshot("extended-tesla");
    const first = deriveReplayFrame(snapshot, 0);
    expect(first.rTokenPriceMicros).toBe(snapshot.chart[0].priceMicros);
    expect(first.providerTimestamp).toBe(snapshot.chart[0].time);
    expect(first.offHoursMoveBps).toBe(0);
    expect(snapshot.rTokenPriceMicros).toBe(416_180_000);
  });

  it("clamps seeking to the final decision point and restores exact provider values", () => {
    const snapshot = replaySnapshot("extended-tesla");
    const final = deriveReplayFrame(snapshot, 999);
    expect(final).toMatchObject({
      rTokenPriceMicros: snapshot.rTokenPriceMicros,
      bidPriceMicros: snapshot.bidPriceMicros,
      askPriceMicros: snapshot.askPriceMicros,
      providerTimestamp: snapshot.chart.at(-1)?.time,
      offHoursMoveBps: snapshot.offHoursMoveBps,
    });
  });
});
