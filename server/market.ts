import type { MarketSnapshot, RiskFlag, SupportedSymbol } from "../shared/types.js";
import {
  classifyMarketSession,
  nextCashOpen,
  previousCashClose,
} from "./session-engine.js";

const BITGET_BASE_URL = "https://api.bitget.com";

const SYMBOL_META: Record<SupportedSymbol, { displaySymbol: string; companyName: string }> = {
  RNVDAUSDT: { displaySymbol: "rNVDA", companyName: "NVIDIA" },
  RTSLAUSDT: { displaySymbol: "rTSLA", companyName: "Tesla" },
  RORCLUSDT: { displaySymbol: "rORCL", companyName: "Oracle" },
};

type BitgetResponse<T> = {
  code: string;
  msg: string;
  data: T;
};

type Ticker = {
  symbol: string;
  ts: string;
  lastPrice: string;
  ask1Price: string;
  bid1Price: string;
};

const cache = new Map<string, { expiresAt: number; snapshot: MarketSnapshot }>();

async function fetchBitget<T>(path: string): Promise<T> {
  const response = await fetch(`${BITGET_BASE_URL}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Bitget market request failed (${response.status})`);
  const payload = (await response.json()) as BitgetResponse<T>;
  if (payload.code !== "00000") throw new Error(payload.msg || "Bitget market request failed");
  return payload.data;
}

function parseCandles(data: unknown): Array<{ time: string; price: number }> {
  if (!Array.isArray(data)) return [];
  return data
    .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 5)
    .map((row) => ({
      time: new Date(Number(row[0])).toISOString(),
      price: Number(row[4]),
    }))
    .filter((point) => Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => a.time.localeCompare(b.time));
}

async function fetchChart(symbol: SupportedSymbol, now: Date) {
  const startTime = now.getTime() - 8 * 60 * 60 * 1000;
  const params = new URLSearchParams({
    category: "SPOT",
    symbol,
    interval: "15m",
    startTime: String(startTime),
    endTime: String(now.getTime()),
    limit: "40",
  });
  try {
    return parseCandles(await fetchBitget<unknown>(`/api/v3/market/candles?${params}`));
  } catch {
    return [];
  }
}

async function fetchAlignedReference(symbol: SupportedSymbol, now: Date) {
  const close = previousCashClose(now);
  const params = new URLSearchParams({
    category: "SPOT",
    symbol,
    interval: "5m",
    startTime: String(close.getTime() - 20 * 60 * 1000),
    endTime: String(close.getTime() + 5 * 60 * 1000),
    limit: "10",
  });
  const points = parseCandles(await fetchBitget<unknown>(`/api/v3/market/candles?${params}`));
  // Bitget candle timestamps identify the interval start. The 15:55 candle is
  // therefore the last completed five-minute rToken candle at a 16:00 cash close.
  const targetStart = close.getTime() - 5 * 60 * 1000;
  const eligible = points.filter((point) => {
    const pointStart = new Date(point.time).getTime();
    return pointStart <= targetStart && targetStart - pointStart <= 10 * 60 * 1000;
  });
  const point = eligible.at(-1);
  return point ? { price: point.price, time: point.time } : null;
}

export async function getLiveSnapshot(
  symbol: SupportedSymbol,
  now = new Date(),
): Promise<MarketSnapshot> {
  const cached = cache.get(symbol);
  if (cached && cached.expiresAt > now.getTime()) return cached.snapshot;

  const tickerData = await fetchBitget<Ticker[]>(
    `/api/v3/market/tickers?category=SPOT&symbol=${encodeURIComponent(symbol)}`,
  );
  const ticker = tickerData[0];
  if (!ticker) throw new Error(`No live ticker found for ${symbol}`);

  const [reference, chart] = await Promise.all([
    fetchAlignedReference(symbol, now).catch(() => null),
    fetchChart(symbol, now),
  ]);
  const rTokenPrice = Number(ticker.lastPrice);
  const bid = Number(ticker.bid1Price);
  const ask = Number(ticker.ask1Price);
  if (![rTokenPrice, bid, ask].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error(`Invalid live ticker values for ${symbol}`);
  }

  const quoteTime = new Date(Number(ticker.ts));
  const flags: RiskFlag[] = [];
  if (now.getTime() - quoteTime.getTime() > 120_000) flags.push("STALE_QUOTE");
  if (!reference) flags.push("REFERENCE_UNAVAILABLE");

  const alignedReference = reference?.price ?? null;
  const basisBps = alignedReference
    ? Math.round(((rTokenPrice / alignedReference - 1) * 10_000) * 100) / 100
    : null;
  const midpoint = (bid + ask) / 2;
  const spreadBps = Math.round((((ask - bid) / midpoint) * 10_000) * 100) / 100;
  const meta = SYMBOL_META[symbol];
  const fallbackChart = [
    { time: new Date(now.getTime() - 30 * 60_000).toISOString(), price: alignedReference ?? bid },
    { time: quoteTime.toISOString(), price: rTokenPrice },
  ];

  const snapshot: MarketSnapshot = {
    symbol,
    ...meta,
    sourceMode: "live",
    session: classifyMarketSession(now),
    flags,
    rTokenPrice,
    alignedReference,
    basisBps,
    bid,
    ask,
    spreadBps,
    quoteTime: quoteTime.toISOString(),
    referenceTime: reference?.time ?? null,
    nextCashOpen: nextCashOpen(now).toISOString(),
    chart: chart.length >= 2 ? chart : fallbackChart,
  };
  cache.set(symbol, { expiresAt: now.getTime() + 5_000, snapshot });
  return snapshot;
}

