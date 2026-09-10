import {
  BitgetRestClient,
  buildTools,
  loadConfig,
  safeInvoke,
} from "@bitget-ai/bitget-agent-sdk";
import { MockServer, seedState } from "@bitget-ai/bitget-agent-sdk/testing";
import type { DemoConnectInput, SupportedSymbol } from "../shared/types.js";

function context(credentials: DemoConnectInput, baseUrl?: string) {
  const config = loadConfig({
    apiKey: credentials.apiKey,
    secretKey: credentials.secretKey,
    passphrase: credentials.passphrase,
    paperTrading: true,
    modules: "account,trade,market",
    ...(baseUrl ? { baseUrl } : {}),
  });
  const client = new BitgetRestClient(config);
  const tools = buildTools(config);
  return { config, client, tools };
}

export async function validateDemoCredentials(
  credentials: DemoConnectInput,
  baseUrl?: string,
): Promise<{ account: unknown; rTokenTradingSupported: boolean }> {
  const ctx = context(credentials, baseUrl);
  // A direct authenticated read must succeed. The composite account tool returns
  // partial errors as data, so it cannot safely prove that credentials are valid.
  const account = await ctx.client.callOperation("getAccountAssets", {});
  let rTokenTradingSupported = false;
  try {
    const instruments = await ctx.client.callOperation("getInstruments", {
      category: "SPOT",
      symbol: "RNVDAUSDT",
    });
    const rows = Array.isArray(instruments.data) ? instruments.data : [];
    rTokenTradingSupported = rows.some(
      (row) => row && typeof row === "object" && String((row as Record<string, unknown>).symbol).toUpperCase() === "RNVDAUSDT",
    );
  } catch {
    // A valid demo session may still lack rToken support; connection is retained
    // for transparency while execution remains disabled.
  }
  return { account: account.data, rTokenTradingSupported };
}

export async function placeDemoOrder(args: {
  credentials: DemoConnectInput;
  symbol: SupportedSymbol;
  side: "buy" | "sell";
  notionalUsd: number;
  rTokenPrice: number;
  baseUrl?: string;
}) {
  const ctx = context(args.credentials, args.baseUrl);
  const tool = ctx.tools.find((candidate) => candidate.name === "order");
  if (!tool) throw new Error("Bitget order tool is unavailable");
  const quantity = args.side === "buy" ? args.notionalUsd : args.notionalUsd / args.rTokenPrice;
  const result = await safeInvoke(
    tool,
    {
      action: "place",
      category: "SPOT",
      symbol: args.symbol,
      side: args.side,
      orderType: "market",
      qty: quantity.toFixed(args.side === "buy" ? 2 : 8),
      clientOid: `sg_${Date.now()}`,
    },
    ctx,
  );
  if (!result.ok) throw new Error(result.error?.message ?? "Paper order was rejected");
  return result.data as Record<string, unknown>;
}

export async function simulateWithOfficialSdk(args: {
  symbol: SupportedSymbol;
  side: "buy" | "sell";
  notionalUsd: number;
  rTokenPrice: number;
}) {
  const mock = new MockServer();
  await mock.start();
  seedState(mock.getState());
  try {
    return await placeDemoOrder({
      ...args,
      credentials: {
        apiKey: "sessionguard-replay-key",
        secretKey: "sessionguard-replay-secret",
        passphrase: "sessionguard-replay",
      },
      baseUrl: mock.baseUrl,
    });
  } finally {
    await mock.stop();
  }
}
