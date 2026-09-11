import type {
  ProductionMarketSnapshot,
  ProductionSymbol,
} from "../shared/production-types.js";
import { symbolMetadata } from "../shared/production-types.js";
import { replayScenarios } from "../shared/replays.js";
import type { Coordinator } from "./coordinator.js";
import type { AnchorRecord, PlatformRepository } from "./platform-repository.js";
import {
  anchorCloseForCapture,
  classifyProductionSession,
  nextCashOpen,
  previousAnchorSessionDate,
} from "./production-session.js";

const BITGET_BASE_URL = "https://api.bitget.com";

type BitgetResponse<T> = { code: string; msg: string; data: T };
type Ticker = { symbol: string; ts: string; lastPrice: string; ask1Price: string; bid1Price: string };
type CandlePoint = { startMs: number; openMicros: number; closeMicros: number };
type Fetcher = typeof fetch;

function micros(value: string | number) {
  const result = Math.round(Number(value) * 1_000_000);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("INVALID_BITGET_PRICE");
  return result;
}

function bps(current: number, reference: number) {
  return Math.round(((current / reference - 1) * 10_000) * 100) / 100;
}

function parseCandles(data: unknown): CandlePoint[] {
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is unknown[] => Array.isArray(row) && row.length >= 5)
    .map((row) => ({ startMs: Number(row[0]), openMicros: micros(Number(row[1])), closeMicros: micros(Number(row[4])) }))
    .filter((point) => Number.isFinite(point.startMs) && point.closeMicros > 0)
    .sort((left, right) => left.startMs - right.startMs);
}

export class ProductionMarketService {
  constructor(
    private readonly repository: PlatformRepository,
    private readonly coordinator: Coordinator,
    private readonly fetcher: Fetcher = fetch,
    private readonly baseUrl = BITGET_BASE_URL,
  ) {}

  async snapshot(symbol: ProductionSymbol, options: { mode?: "LIVE_BITGET" | "REPLAY"; replayId?: string; now?: Date; fresh?: boolean } = {}) {
    const mode = options.mode ?? "LIVE_BITGET";
    const now = options.now ?? new Date();
    const requestStartedAt = Date.now();
    if (mode === "REPLAY") return this.replaySnapshot(symbol, options.replayId, now);
    const cacheKey = `market:${symbol}`;
    const cached = await this.coordinator.cacheGet<ProductionMarketSnapshot>(cacheKey);
    if (!options.fresh && cached && new Date(cached.receivedTimestamp).getTime() + 5_000 > now.getTime()) return cached;

    const tickerRows = await this.bitget<Ticker[]>(`/api/v3/market/tickers?category=SPOT&symbol=${encodeURIComponent(symbol)}`);
    const ticker = tickerRows[0];
    if (!ticker) throw new Error("BITGET_TICKER_UNAVAILABLE");
    const providerAt = new Date(Number(ticker.ts));
    if (!Number.isFinite(providerAt.getTime()) || providerAt.getTime() > now.getTime() + 5_000) {
      throw new Error("INVALID_BITGET_TIMESTAMP");
    }
    // `now` is captured before the HTTP request. Advance it by the observed request
    // duration and clamp to the accepted provider clock so receipt can never predate quote.
    const receivedAt = new Date(Math.max(providerAt.getTime(),
      now.getTime() + Math.max(0, Date.now() - requestStartedAt)));
    const quoteAgeMs = Math.max(0, receivedAt.getTime() - providerAt.getTime());
    const rTokenPriceMicros = micros(ticker.lastPrice);
    const bidPriceMicros = micros(ticker.bid1Price);
    const askPriceMicros = micros(ticker.ask1Price);
    const midpoint = (bidPriceMicros + askPriceMicros) / 2;
    const spreadBps = Math.round((((askPriceMicros - bidPriceMicros) / midpoint) * 10_000) * 100) / 100;

    const sessionDate = previousAnchorSessionDate(now);
    let anchor = await this.repository.getAnchor(symbol, sessionDate);
    if (!anchor) anchor = await this.captureAnchor(symbol, now).catch(() => null);
    const chart = await this.chart(symbol, now).catch(() => []);
    const marketAvailable = quoteAgeMs <= 10_000;
    const meta = symbolMetadata[symbol];
    const snapshot: ProductionMarketSnapshot = {
      symbol,
      ...meta,
      dataMode: "LIVE_BITGET",
      sourceLabel: "LIVE BITGET",
      source: "BITGET",
      session: classifyProductionSession(now, marketAvailable),
      rTokenPriceMicros,
      bidPriceMicros,
      askPriceMicros,
      spreadBps,
      referenceKind: "BITGET_CASH_SESSION_ANCHOR",
      referenceQuality: anchor?.quality ?? "MISSING",
      anchorPriceMicros: anchor?.priceMicros ?? null,
      offHoursMoveBps: anchor ? bps(rTokenPriceMicros, anchor.priceMicros) : null,
      providerTimestamp: providerAt.toISOString(),
      receivedTimestamp: receivedAt.toISOString(),
      quoteAgeMs,
      referenceTimestamp: anchor?.referenceTimestamp ?? null,
      nextCashOpen: nextCashOpen(now).toISOString(),
      chart: chart.length >= 2 ? chart : [
        { time: new Date(now.getTime() - 60_000).toISOString(), priceMicros: anchor?.priceMicros ?? bidPriceMicros },
        { time: providerAt.toISOString(), priceMicros: rTokenPriceMicros },
      ],
    };
    await Promise.all([
      this.coordinator.cacheSet(cacheKey, snapshot, 5),
      this.repository.saveMarketAggregate(snapshot),
      this.coordinator.publish(`market:${symbol}`, snapshot),
    ]);
    return snapshot;
  }

  async captureAnchor(symbol: ProductionSymbol, now = new Date()): Promise<AnchorRecord> {
    const close = anchorCloseForCapture(now);
    const sessionDate = previousAnchorSessionDate(now);
    const params = new URLSearchParams({
      category: "SPOT",
      symbol,
      interval: "1m",
      startTime: String(close.getTime() - 31 * 60_000),
      endTime: String(close.getTime() + 60_000),
      limit: "40",
    });
    const points = parseCandles(await this.bitget<unknown>(`/api/v3/market/candles?${params}`));
    const eligible = points.filter((point) => point.startMs + 60_000 <= close.getTime() && close.getTime() - (point.startMs + 60_000) <= 30 * 60_000);
    const selected = eligible.at(-1);
    if (!selected) throw new Error("BITGET_CASH_SESSION_ANCHOR_MISSING");
    const ageMs = close.getTime() - (selected.startMs + 60_000);
    const anchor: AnchorRecord = {
      symbol,
      priceMicros: selected.closeMicros,
      referenceTimestamp: new Date(selected.startMs + 60_000).toISOString(),
      sessionDate,
      quality: ageMs <= 60_000 ? "OBSERVED" : "DEGRADED",
      capturedAt: now.toISOString(),
    };
    await this.repository.saveAnchor(anchor);
    return anchor;
  }

  /** Return the final valid Bitget one-minute candle for a completed cash session. */
  async completedCashSessionClose(symbol: ProductionSymbol, close: Date, now = new Date()) {
    if (now.getTime() < close.getTime()) throw new Error("OUTCOME_CASH_SESSION_NOT_COMPLETE");
    const params = new URLSearchParams({
      category: "SPOT",
      symbol,
      interval: "1m",
      startTime: String(close.getTime() - 31 * 60_000),
      endTime: String(close.getTime() + 60_000),
      limit: "40",
    });
    const points = parseCandles(await this.bitget<unknown>(`/api/v3/market/candles?${params}`));
    const selected = points.filter((point) => point.startMs + 60_000 <= close.getTime()
      && close.getTime() - (point.startMs + 60_000) <= 30 * 60_000).at(-1);
    if (!selected) throw new Error("OUTCOME_FINAL_BITGET_CANDLE_MISSING");
    return { priceMicros: selected.closeMicros, observedAt: new Date(selected.startMs + 60_000).toISOString() };
  }

  /** Recover the first completed Bitget one-minute observation within five minutes after a missed target. */
  async completedObservationCandle(symbol: ProductionSymbol, target: Date, now = new Date()) {
    const targetMs = target.getTime();
    if (!Number.isFinite(targetMs)) throw new Error("OUTCOME_OBSERVATION_TIME_INVALID");
    const candleStartMs = Math.ceil(targetMs / 60_000) * 60_000;
    const earliestCompletedMs = candleStartMs + 60_000;
    const recoveryWindowEndMs = candleStartMs + 5 * 60_000;
    if (now.getTime() < earliestCompletedMs) throw new Error("OUTCOME_OBSERVATION_CANDLE_NOT_COMPLETE");
    const params = new URLSearchParams({
      category: "SPOT",
      symbol,
      interval: "1m",
      startTime: String(candleStartMs),
      endTime: String(recoveryWindowEndMs + 60_000),
      limit: "7",
    });
    const points = parseCandles(await this.bitget<unknown>(`/api/v3/market/candles?${params}`));
    const selected = points.find((point) => point.startMs >= candleStartMs && point.startMs <= recoveryWindowEndMs
      && point.startMs + 60_000 <= now.getTime());
    if (!selected) throw new Error("OUTCOME_BOUNDED_BITGET_CANDLE_MISSING");
    return {
      priceMicros: selected.openMicros,
      observedAt: new Date(selected.startMs).toISOString(),
      completedAt: new Date(selected.startMs + 60_000).toISOString(),
      source: "BITGET_COMPLETED_1M_CANDLE" as const,
    };
  }

  private replaySnapshot(symbol: ProductionSymbol, replayId: string | undefined, now: Date): ProductionMarketSnapshot {
    const scenario = replayScenarios.find((item) => item.id === replayId && item.snapshot.symbol === symbol)
      ?? replayScenarios.find((item) => item.snapshot.symbol === symbol);
    if (!scenario) throw new Error("REPLAY_NOT_FOUND");
    const source = scenario.snapshot;
    const session = source.session === "CASH_OPEN" ? "CASH_OPEN"
      : source.session === "EXTENDED" || source.session === "CLOSED" ? "EXTENDED"
        : "WEEKEND";
    return {
      symbol,
      ...symbolMetadata[symbol],
      dataMode: "REPLAY",
      sourceLabel: "REPLAY",
      source: "BITGET",
      session,
      rTokenPriceMicros: micros(source.rTokenPrice),
      bidPriceMicros: micros(source.bid),
      askPriceMicros: micros(source.ask),
      spreadBps: source.spreadBps,
      referenceKind: "BITGET_CASH_SESSION_ANCHOR",
      referenceQuality: source.alignedReference ? "OBSERVED" : "MISSING",
      anchorPriceMicros: source.alignedReference ? micros(source.alignedReference) : null,
      offHoursMoveBps: source.basisBps,
      providerTimestamp: source.quoteTime,
      receivedTimestamp: now.toISOString(),
      quoteAgeMs: 0,
      referenceTimestamp: source.referenceTime,
      nextCashOpen: source.nextCashOpen,
      chart: source.chart.map((point) => ({ time: point.time, priceMicros: micros(point.price) })),
    };
  }

  private async chart(symbol: ProductionSymbol, now: Date) {
    const params = new URLSearchParams({
      category: "SPOT", symbol, interval: "15m",
      startTime: String(now.getTime() - 8 * 60 * 60_000), endTime: String(now.getTime()), limit: "40",
    });
    return parseCandles(await this.bitget<unknown>(`/api/v3/market/candles?${params}`))
      .map((point) => ({ time: new Date(point.startMs).toISOString(), priceMicros: point.closeMicros }));
  }

  private async bitget<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`BITGET_HTTP_${response.status}`);
    const payload = await response.json() as BitgetResponse<T>;
    if (payload.code !== "00000") throw new Error(`BITGET_${payload.code}`);
    return payload.data;
  }
}
