import type {
  AuthenticatedUser,
  GuardDecision,
  GuardEvaluationInput,
  NotificationChannel,
  PaperOrderReceiptV1,
  PlatformNotification,
  PortfolioSnapshot,
  ProductionMarketSnapshot,
  UserPolicy,
} from "../../shared/production-types";
import type { AgentEligibility, AgentGrantV1, AgentMode, AgentOutcomeV1, AgentRunDetail, AgentRunV1, AgentSettingsV1 } from "../../shared/agent-types";

export type AgentConsoleStatus = {
  runtimeEnabled: boolean; mode: AgentMode; settings: AgentSettingsV1; workerHeartbeatAt: string | null; workerHealthy: boolean;
  qwenHealth: "HEALTHY" | "DEGRADED" | "DISABLED"; bitgetHealth: "HEALTHY" | "DEGRADED"; sourceHealth: "HEALTHY" | "DEGRADED";
  cashSession: "CASH_OPEN" | "EXTENDED" | "WEEKEND" | "HOLIDAY" | "MARKET_UNAVAILABLE"; queue: { runnable: number; leased: number; oldestRunnableAgeMs: number };
  demo: { connected: boolean; executionEnabled: boolean; lastValidatedAt?: string | null };
  grant: { active: boolean; expiresAt: string | null; warning: "NONE" | "24_HOURS" | "ONE_HOUR" | "EXPIRED" };
  eligibility: AgentEligibility; killSwitches: Record<string, boolean>;
};

export type AgentSettingsUpdate = Pick<AgentSettingsV1, "mode" | "symbols" | "offHoursMoveThresholdBps" | "minCollateralBufferPct" |
  "automaticOrderLimitCents" | "automaticOrdersPerDay" | "automaticGrossNewNotionalCents" | "notificationsEnabled">;
export type AgentGrantScope = Pick<AgentGrantV1, "symbols" | "actions" | "automaticOrderLimitCents" | "automaticOrdersPerDay" |
  "automaticGrossNewNotionalCents">;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) { super(message); }
}

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
  const body = await response.json().catch(() => ({})) as { error?: string; details?: unknown } & T;
  if (!response.ok) throw new ApiError(body.error ?? `REQUEST_${response.status}`, response.status, body.details);
  return body;
}

export const productionApi = {
  agentStatus: () => request<{ status: AgentConsoleStatus }>("/api/v1/agent/status"),
  agentSettings: () => request<{ settings: AgentSettingsV1 }>("/api/v1/agent/settings"),
  updateAgentSettings: (settings: AgentSettingsUpdate) => request<{ settings: AgentSettingsV1 }>("/api/v1/agent/settings", { method: "PUT", body: JSON.stringify(settings) }),
  agentGrantChallenge: (scope: AgentGrantScope) => request<{ challengeId: string; message: string; expiresAt: string; grantExpiresAt: string; executionMode: "BITGET_DEMO"; cashOpenOnly: true; scope: AgentGrantScope }>("/api/v1/agent/grants/challenge", { method: "POST", body: JSON.stringify(scope) }),
  verifyAgentGrant: (challengeId: string, message: string, signature: string) => request<{ grant: Omit<AgentGrantV1, "userId" | "walletAddress" | "chainId" | "policyVersion" | "settingsVersion" | "messageHash" | "revokedReason" | "version">; settings: AgentSettingsV1 }>("/api/v1/agent/grants/verify", { method: "POST", body: JSON.stringify({ challengeId, message, signature }) }),
  revokeAgentGrant: () => request<{ revoked: boolean; mode: AgentMode }>("/api/v1/agent/grants/current", { method: "DELETE" }),
  agentRuns: (cursor?: string) => request<{ items: AgentRunV1[]; nextCursor: string | null }>(`/api/v1/agent/runs?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  agentRun: (id: string) => request<{ run: AgentRunDetail }>(`/api/v1/agent/runs/${encodeURIComponent(id)}`),
  manualAgentShadow: (symbol: string, triggerType = "SESSION_CHANGE") => request<{ run: AgentRunV1 }>("/api/v1/agent/runs/manual-shadow", { method: "POST", body: JSON.stringify({ symbol, triggerType }) }),
  agentReplay: (replayId: string, analyst: "RECORDED" | "QWEN") => request<{ run: AgentRunV1; status: "QUEUED" | "SKIPPED_DUPLICATE" }>(`/api/v1/agent/replays/${encodeURIComponent(replayId)}`, { method: "POST", body: JSON.stringify({ analyst }) }),
  agentOutcomes: (cursor?: string) => request<{ items: AgentOutcomeV1[]; nextCursor: string | null }>(`/api/v1/agent/outcomes?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  replays: () => request<{ scenarios: Array<{ id: string; name: string; kicker: string; description: string; symbol: string }> }>("/api/v1/replays"),
  authMe: () => request<{ authenticated: true; user: AuthenticatedUser }>("/api/v1/auth/me"),
  nonce: (address: string) => request<{ nonce: string; message: string; expiresAt: string; chainId: 42161 }>("/api/v1/auth/nonce", {
    method: "POST", body: JSON.stringify({ address, chainId: 42161 }),
  }),
  verify: (message: string, signature: string) => request<{ user: AuthenticatedUser }>("/api/v1/auth/verify", {
    method: "POST", body: JSON.stringify({ message, signature }),
  }),
  logout: () => request<{ authenticated: false }>("/api/v1/auth/logout", { method: "POST" }),
  snapshot: (symbol: string, mode: "LIVE_BITGET" | "REPLAY", replayId?: string) => {
    const query = new URLSearchParams({ mode });
    if (replayId) query.set("replayId", replayId);
    return request<{ snapshot: ProductionMarketSnapshot }>(`/api/v1/market/snapshots/${symbol}?${query}`);
  },
  connection: () => request<{ connected: boolean; executionEnabled: boolean; lastValidatedAt: string | null }>("/api/v1/connections/bitget-demo"),
  connect: (credentials: { apiKey: string; secretKey: string; passphrase: string }) => request<{ connected: boolean; executionEnabled: boolean }>("/api/v1/connections/bitget-demo", {
    method: "PUT", body: JSON.stringify(credentials),
  }),
  disconnect: () => request<{ connected: false }>("/api/v1/connections/bitget-demo", { method: "DELETE" }),
  portfolio: (mode: "LIVE_BITGET" | "REPLAY", replayId?: string) => {
    const query = new URLSearchParams({ mode }); if (replayId) query.set("replayId", replayId);
    return request<{ portfolio: PortfolioSnapshot }>(`/api/v1/portfolio?${query}`);
  },
  policy: () => request<{ policy: UserPolicy; version: string }>("/api/v1/policies"),
  updatePolicy: (policy: UserPolicy) => request<{ policy: UserPolicy; version: string }>("/api/v1/policies", { method: "PUT", body: JSON.stringify(policy) }),
  evaluate: (input: GuardEvaluationInput) => request<{ decision: GuardDecision }>("/api/v1/guard/evaluate", { method: "POST", body: JSON.stringify(input) }),
  execute: (decisionToken: string) => request<{ order: PaperOrderReceiptV1 }>("/api/v1/paper-orders", { method: "POST", body: JSON.stringify({ decisionToken }) }),
  decisions: (offset = 0) => request<{ receipts: Array<{ decision: GuardDecision; order: PaperOrderReceiptV1 | null }>; page: { nextOffset: number | null } }>(`/api/v1/decisions?limit=25&offset=${offset}`),
  channels: () => request<{ channels: NotificationChannel[]; vapidPublicKey: string | null }>("/api/v1/notifications/channels"),
  addEmail: (email: string) => request<{ channel: NotificationChannel; verificationUrl?: string }>("/api/v1/notifications/channels", { method: "POST", body: JSON.stringify({ type: "EMAIL", email }) }),
  addTelegram: () => request<{ channel: NotificationChannel; connectUrl: string }>("/api/v1/notifications/channels", { method: "POST", body: JSON.stringify({ type: "TELEGRAM" }) }),
  addWebPush: (subscription: PushSubscriptionJSON) => request<{ channel: NotificationChannel }>("/api/v1/notifications/channels", { method: "POST", body: JSON.stringify({ type: "WEB_PUSH", subscription }) }),
  removeChannel: (id: string) => request<{ removed: true }>(`/api/v1/notifications/channels/${id}`, { method: "DELETE" }),
  inbox: () => request<{ notifications: PlatformNotification[] }>("/api/v1/notifications/inbox"),
  acknowledge: (id: string) => request<{ acknowledged: true }>(`/api/v1/notifications/inbox/${id}/ack`, { method: "POST" }),
  testNotification: () => request<{ notification: PlatformNotification | null }>("/api/v1/notifications/test", { method: "POST" }),
  deleteAccount: () => request<{ deleted: true; backupExpiryDays: 35 }>("/api/v1/account", { method: "DELETE" }),
};

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
};

declare global { interface Window { ethereum?: EthereumProvider } }

export async function signInWithWallet() {
  const provider = window.ethereum;
  if (!provider) throw new Error("Install or open an EVM wallet such as Bitget Wallet.");
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
  const address = accounts[0];
  if (!address) throw new Error("No wallet account was selected.");
  try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa4b1" }] }); }
  catch {
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0xa4b1", chainName: "Arbitrum One",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://arb1.arbitrum.io/rpc"], blockExplorerUrls: ["https://arbiscan.io"] }] });
  }
  const challenge = await productionApi.nonce(address);
  let signature: string;
  try { signature = await provider.request({ method: "personal_sign", params: [challenge.message, address] }) as string; }
  catch { signature = await provider.request({ method: "personal_sign", params: [address, challenge.message] }) as string; }
  return productionApi.verify(challenge.message, signature);
}


export async function signAgentGrant(scope: AgentGrantScope, expectedAddress: string) {
  const provider = window.ethereum;
  if (!provider) throw new Error("Install or open an EVM wallet such as Bitget Wallet.");
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
  const address = accounts[0];
  if (!address || address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error("Select the same wallet used to sign in.");
  try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa4b1" }] }); }
  catch { throw new Error("Switch the wallet to Arbitrum One before signing the agent scope."); }
  const challenge = await productionApi.agentGrantChallenge(scope);
  let signature: string;
  try { signature = await provider.request({ method: "personal_sign", params: [challenge.message, address] }) as string; }
  catch { signature = await provider.request({ method: "personal_sign", params: [address, challenge.message] }) as string; }
  return productionApi.verifyAgentGrant(challenge.challengeId, challenge.message, signature);
}

export function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}
