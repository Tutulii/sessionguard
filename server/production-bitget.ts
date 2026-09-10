import { BitgetRestClient, loadConfig } from "@bitget-ai/bitget-agent-sdk";
import type {
  PersistentDemoConnectInput,
  PortfolioSnapshot,
  ProductionSymbol,
} from "../shared/production-types.js";
import { supportedSymbols } from "../shared/production-types.js";

type OperationResult = { data?: unknown };
type Row = Record<string, unknown>;

function number(row: Row, keys: string[], fallback = 0) {
  for (const key of keys) {
    const parsed = Number(row[key]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function rows(value: unknown): Row[] {
  if (Array.isArray(value)) return value.filter((item): item is Row => Boolean(item) && typeof item === "object");
  if (value && typeof value === "object") {
    for (const key of ["list", "rows", "assets", "orders"]) {
      const nested = (value as Row)[key];
      if (Array.isArray(nested)) return rows(nested);
    }
  }
  return [];
}

function cents(value: number) { return Math.round(value * 100); }
function quantityMicros(value: number) { return Math.max(0, Math.round(value * 1_000_000)); }
export function isRealityInstrument(row: Record<string, unknown>, symbol: ProductionSymbol) {
  const sameSymbol = String(row.symbol ?? "").toUpperCase() === symbol;
  const realityMarker = String(row.isReality ?? "").trim().toLowerCase();
  const reality = row.isReality === true || ["true", "yes", "1"].includes(realityMarker);
  const online = !row.status || ["online", "listed", "normal"].includes(String(row.status).toLowerCase());
  return sameSymbol && reality && online;
}


export type PortfolioPrices = Record<ProductionSymbol, number>;

export interface DemoTradingAdapter {
  validate(credentials: PersistentDemoConnectInput): Promise<{ executionEnabled: boolean }>;
  portfolio(userId: string, credentials: PersistentDemoConnectInput, pricesMicros: PortfolioPrices): Promise<PortfolioSnapshot>;
  placeOrder(args: {
    credentials: PersistentDemoConnectInput;
    symbol: ProductionSymbol;
    side: "buy" | "sell";
    notionalCents: number;
    priceMicros: number;
    clientOrderId: string;
  }): Promise<{ orderId: string | null; raw: Record<string, unknown> }>;
  reconcile(credentials: PersistentDemoConnectInput, symbol: ProductionSymbol, clientOrderId: string): Promise<{ orderId: string; status: string } | null>;
}

export class BitgetDemoTradingAdapter implements DemoTradingAdapter {
  constructor(private readonly baseUrl?: string) {}

  async validate(credentials: PersistentDemoConnectInput) {
    const client = this.client(credentials);
    await client.callOperation("getAccountAssets", {});
    const checks = await Promise.all(supportedSymbols.map(async (symbol) => {
      try {
        const result = await client.callOperation("getInstruments", { category: "SPOT", symbol }) as OperationResult;
        return rows(result.data).some((row) => isRealityInstrument(row, symbol));
      } catch { return false; }
    }));
    return { executionEnabled: checks.every(Boolean) };
  }

  async portfolio(userId: string, credentials: PersistentDemoConnectInput, pricesMicros: PortfolioPrices) {
    const client = this.client(credentials);
    const [assetResult, orderResult] = await Promise.all([
      client.callOperation("getAccountAssets", {}) as Promise<OperationResult>,
      client.callOperation("getOpenOrders", { category: "SPOT", limit: "100" }) as Promise<OperationResult>,
    ]);
    const account = assetResult.data && typeof assetResult.data === "object" && !Array.isArray(assetResult.data)
      ? assetResult.data as Row
      : {};
    const assets = rows(assetResult.data);
    const coinToSymbol: Record<string, ProductionSymbol> = {
      RNVDA: "RNVDAUSDT", RTSLA: "RTSLAUSDT", RORCL: "RORCLUSDT",
    };
    const positions = assets.flatMap((asset) => {
      const coin = String(asset.coin ?? asset.asset ?? "").toUpperCase();
      const symbol = coinToSymbol[coin];
      if (!symbol) return [];
      const quantity = number(asset, ["equity", "balance", "total", "available"]);
      return [{
        symbol,
        quantityMicros: quantityMicros(quantity),
        marketValueCents: cents(quantity * pricesMicros[symbol] / 1_000_000),
        // Treat rToken holdings as collateral conservatively when Bitget does not expose an explicit flag.
        usedAsCollateral: asset.isCollateral === undefined ? true : Boolean(asset.isCollateral),
      }];
    });
    const usdt = assets.find((asset) => String(asset.coin ?? asset.asset ?? "").toUpperCase() === "USDT");
    const directUsdtAvailable = usdt ? Math.max(0, number(usdt, ["available", "availableBalance", "free"])) : 0;
    // Bitget defines effEquity as net value available for UTA margin. It is
    // safe to use when positive, but a non-USDT asset balance alone is not
    // assumed spendable for an rToken/USDT order.
    const utaEffectiveEquity = Math.max(0, number(account, ["effEquity"]));
    const reportedAccountEquity = number(account, ["accountEquity", "usdtEquity"]);
    const reportedAssetEquity = assets.reduce((total, asset) => total + number(asset, ["usdValue", "usdtValue"], 0), 0);
    const computedEquity = directUsdtAvailable + positions.reduce((total, position) => total + position.marketValueCents / 100, 0);
    const accountEquityCents = Math.max(1, cents(reportedAccountEquity > 0
      ? reportedAccountEquity
      : reportedAssetEquity > 0 ? reportedAssetEquity : computedEquity));
    const availableBalanceCents = Math.min(accountEquityCents, cents(Math.max(directUsdtAvailable, utaEffectiveEquity)));
    return {
      userId,
      accountEquityCents,
      availableBalanceCents,
      collateralBufferPct: Math.max(0, Math.min(100, Math.round((availableBalanceCents / accountEquityCents) * 1_000) / 10)),
      positions,
      openOrderCount: rows(orderResult.data).length,
      source: "BITGET_DEMO" as const,
      capturedAt: new Date().toISOString(),
    } satisfies PortfolioSnapshot;
  }

  async placeOrder(args: {
    credentials: PersistentDemoConnectInput;
    symbol: ProductionSymbol;
    side: "buy" | "sell";
    notionalCents: number;
    priceMicros: number;
    clientOrderId: string;
  }) {
    const quoteAmount = args.notionalCents / 100;
    const baseAmount = quoteAmount / (args.priceMicros / 1_000_000);
    const result = await this.client(args.credentials).callOperation("placeOrder", {
      category: "SPOT",
      symbol: args.symbol,
      side: args.side,
      orderType: "market",
      qty: (args.side === "buy" ? quoteAmount : baseAmount).toFixed(args.side === "buy" ? 2 : 8),
      clientOid: args.clientOrderId,
    }) as OperationResult;
    const raw = (result.data && typeof result.data === "object" ? result.data : {}) as Record<string, unknown>;
    return { orderId: raw.orderId ? String(raw.orderId) : null, raw };
  }

  async reconcile(credentials: PersistentDemoConnectInput, symbol: ProductionSymbol, clientOrderId: string) {
    const result = await this.client(credentials).callOperation("getOrderDetails", {
      category: "SPOT", symbol, clientOid: clientOrderId,
    }) as OperationResult;
    const row = rows(result.data)[0] ?? (result.data && typeof result.data === "object" ? result.data as Row : null);
    if (!row || !row.orderId) return null;
    return { orderId: String(row.orderId), status: String(row.status ?? "submitted") };
  }

  private client(credentials: PersistentDemoConnectInput) {
    const config = loadConfig({
      apiKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      passphrase: credentials.passphrase,
      paperTrading: true,
      modules: "account,trade,market",
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
    });
    return new BitgetRestClient(config);
  }
}

export function replayPortfolio(userId: string, now = new Date()): PortfolioSnapshot {
  return {
    userId,
    accountEquityCents: 500_000,
    availableBalanceCents: 120_000,
    collateralBufferPct: 24,
    positions: [{ symbol: "RORCLUSDT", quantityMicros: 2_968_000, marketValueCents: 90_000, usedAsCollateral: true }],
    openOrderCount: 0,
    source: "REPLAY",
    capturedAt: now.toISOString(),
  };
}
