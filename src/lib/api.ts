import type {
  DecisionReceipt,
  MarketEvent,
  MarketSnapshot,
  ReplayScenario,
  TradeIntent,
} from "../../shared/types";

type DemoSession = {
  connected: boolean;
  executionEnabled: boolean;
  rTokenTradingSupported?: boolean;
  mode: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.method && init.method !== "GET" ? { "x-sessionguard-request": "1" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

export const api = {
  replays: () => request<{ scenarios: ReplayScenario[] }>("/api/replays"),
  snapshot: (symbol: string) => request<{ snapshot: MarketSnapshot }>(`/api/market/snapshot/${symbol}`),
  events: (refresh = false) => request<{ events: MarketEvent[] }>(`/api/events${refresh ? "?refresh=1" : ""}`),
  session: () => request<DemoSession>("/api/demo/session"),
  connect: (credentials: { apiKey: string; secretKey: string; passphrase: string }) =>
    request<DemoSession>("/api/demo/connect", {
      method: "POST",
      body: JSON.stringify(credentials),
    }),
  disconnect: () => request<DemoSession>("/api/demo/session", { method: "DELETE" }),
  evaluate: (intent: TradeIntent) =>
    request<{ receipt: DecisionReceipt; executionEnabled: boolean }>("/api/agent/evaluate", {
      method: "POST",
      body: JSON.stringify(intent),
    }),
  order: (decisionToken: string) =>
    request<{ receipt: DecisionReceipt }>("/api/demo/orders", {
      method: "POST",
      body: JSON.stringify({ decisionToken }),
    }),
  decisions: () => request<{ receipts: DecisionReceipt[] }>("/api/decisions"),
};
