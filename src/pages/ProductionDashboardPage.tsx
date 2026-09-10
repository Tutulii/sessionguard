import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, AlertTriangle, ArrowRight, BadgeCheck, Ban, Bell, Bot, Check, ChevronDown,
  CircleDollarSign, Clock3, CloudOff, Download, ExternalLink, FileCheck2, Gauge,
  KeyRound, LoaderCircle, LockKeyhole, LogOut, Mail, Menu, MessageCircle, MoonStar,
  Play, RefreshCw, Save, Send, Settings2, ShieldCheck, Smartphone, Trash2,
  TrendingDown, TrendingUp, Unplug, Wallet, X, Zap,
} from "lucide-react";
import { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  AuthenticatedUser, GuardDecision, GuardRuleResult, NotificationChannel, PaperOrderReceiptV1,
  PlatformNotification, PortfolioSnapshot, ProductionMarketSnapshot, ProductionSymbol,
  UserPolicy,
} from "../../shared/production-types";
import { defaultUserPolicy, symbolMetadata } from "../../shared/production-types";
import { Brand } from "../components/Brand";
import { GuardianScene } from "../components/GuardianScene";
import { deriveReplayFrame, ReplayMarketTimeline } from "../components/ReplayMarketTimeline";
import { ApiError, productionApi, signInWithWallet, urlBase64ToUint8Array } from "../lib/production-api";
import "../production.css";

type DeskMode = "REPLAY" | "LIVE_BITGET";
type Receipt = { decision: GuardDecision; order: PaperOrderReceiptV1 | null };
type ReplayOption = { id: string; name: string; kicker: string; description: string; symbol: string };

const symbols = Object.keys(symbolMetadata) as ProductionSymbol[];

function dollars(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(cents / 100);
}
function price(micros: number | null) {
  if (micros === null) return "Unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(micros / 1_000_000);
}
function time(value: string | null) {
  return value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value)) : "Not available";
}
function compactAddress(address: string) { return `${address.slice(0, 6)}…${address.slice(-4)}`; }
function executionLabel(order: PaperOrderReceiptV1 | null) {
  if (!order) return "NO ORDER";
  return order.executionMode === "LOCAL_REPLAY" ? "LOCAL REPLAY SIMULATION" : "BITGET DEMO SUBMITTED";
}
function sessionLabel(session: ProductionMarketSnapshot["session"]) {
  return ({ CASH_OPEN: "CASH OPEN", EXTENDED: "EXTENDED", WEEKEND: "WEEKEND", HOLIDAY: "HOLIDAY", MARKET_UNAVAILABLE: "UNAVAILABLE" })[session];
}

const legacyBlockingRuleCodes = new Set([
  "DATA_MODE_MISMATCH", "MARKET_UNAVAILABLE", "STALE_QUOTE", "ANCHOR_MISSING", "STALE_PORTFOLIO",
  "CASH_MARKET_DARK", "NOT_REDUCE_ONLY", "EXTENDED_DISABLED", "DAILY_ORDER_LIMIT",
  "DAILY_NOTIONAL_LIMIT", "INSUFFICIENT_AVAILABLE_BALANCE", "COLLATERAL_STRESS", "ZERO_SIZE_CAP",
]);
const legacyCapRuleCodes = new Set(["EXTENDED_SIZE_CAP", "EARNINGS_SIZE_CAP", "AVAILABLE_BALANCE_CAP"]);

function decisionRules(decision: GuardDecision): GuardRuleResult[] {
  if (decision.ruleResults?.length) return decision.ruleResults;
  return decision.reasonCodes.map((code, index) => {
    const effect: GuardRuleResult["effect"] = legacyBlockingRuleCodes.has(code)
      ? "BLOCK"
      : legacyCapRuleCodes.has(code) ? "CAP" : decision.permission === "ALERT_ONLY" ? "ALERT" : "PASS";
    return { code, message: decision.reasons[index] ?? code, effect, scope: "ORDER" };
  });
}

function primaryRuleForDecision(decision: GuardDecision): GuardRuleResult {
  const rules = decisionRules(decision);
  const explicit = decision.primaryReasonCode
    ? rules.find((rule) => rule.code === decision.primaryReasonCode)
    : undefined;
  if (explicit) return { ...explicit, message: decision.primaryReason ?? explicit.message };
  const target = decision.permission === "BLOCK" ? "BLOCK" : decision.permission === "ALERT_ONLY" ? "ALERT" : undefined;
  return rules.find((rule) => rule.effect === target) ?? rules[0];
}

function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`desk-pill tone-${tone}`}>{children}</span>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])")];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handler);
    return () => { document.removeEventListener("keydown", handler); previous?.focus(); };
  }, [onClose]);
  return (
    <motion.div className="modal-backdrop" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <motion.section ref={dialogRef} className="connect-modal prod-modal" role="dialog" aria-modal="true" aria-label={title} initial={{ opacity: 0, y: 18, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12 }}>
        <button className="modal-close" aria-label={`Close ${title}`} onClick={onClose}><X /></button>
        <div className="modal-icon"><ShieldCheck /></div><span className="card-kicker">SESSIONGUARD</span><h2>{title}</h2>
        {children}
      </motion.section>
    </motion.div>
  );
}

function DemoModal({ status, busy, error, onConnect, onDisconnect, onClose }: {
  status: { connected: boolean; executionEnabled: boolean };
  busy: boolean; error: string; onConnect: (value: { apiKey: string; secretKey: string; passphrase: string }) => void;
  onDisconnect: () => void; onClose: () => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    onConnect({ apiKey: String(data.get("apiKey")), secretKey: String(data.get("secretKey")), passphrase: String(data.get("passphrase")) });
  };
  return <Modal title="Connect Bitget Demo" onClose={onClose}>
    <p>Credentials are validated against Bitget Demo, envelope-encrypted with a managed key, and persisted only for your wallet account. No live-money API path exists.</p>
    {status.connected ? <div className="connected-state"><BadgeCheck/><div><strong>{status.executionEnabled ? "Paper execution ready" : "Connected · Reality instruments unavailable"}</strong><small>Rotate by disconnecting and reconnecting after a fresh wallet signature.</small></div><button className="button button-outline" disabled={busy} onClick={onDisconnect}><Unplug/> Disconnect</button></div> :
      <form onSubmit={submit}><label>Demo API key<input autoFocus name="apiKey" type="password" autoComplete="off" minLength={8} required /></label><label>Demo secret key<input name="secretKey" type="password" autoComplete="off" minLength={8} required /></label><label>Demo passphrase<input name="passphrase" type="password" autoComplete="off" required /></label>{error && <div className="form-error"><AlertTriangle/> {error}</div>}<button className="button button-coral button-full" disabled={busy}>{busy ? <LoaderCircle className="spin"/> : <LockKeyhole/>} Verify and encrypt</button></form>}
  </Modal>;
}

function NotificationsModal({ channels, inbox, busy, onEmail, onTelegram, onPush, onTest, onRemove, onClose }: {
  channels: NotificationChannel[]; inbox: PlatformNotification[]; busy: boolean;
  onEmail: (email: string) => void; onTelegram: () => void; onPush: () => void; onTest: () => void; onRemove: (id: string) => void; onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  return <Modal title="Risk alerts" onClose={onClose}>
    <p>Every delivery is queued, deduplicated, retried, and recorded. Trade alerts remain informational and paper-only.</p>
    <div className="prod-channel-grid">
      {channels.map((channel) => <div className="prod-channel" key={channel.id}><span>{channel.type === "EMAIL" ? <Mail/> : channel.type === "TELEGRAM" ? <Send/> : channel.type === "WEB_PUSH" ? <Smartphone/> : <Bell/>}</span><div><strong>{channel.label}</strong><small>{channel.verified ? "Verified" : "Verification pending"}</small></div>{channel.type !== "IN_APP" && <button aria-label={`Remove ${channel.label}`} onClick={() => onRemove(channel.id)}><Trash2/></button>}</div>)}
    </div>
    <form className="prod-inline-form" onSubmit={(event) => { event.preventDefault(); if (email) onEmail(email); }}><label><span>Email channel</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="trader@example.com" required /></label><button disabled={busy}><Mail/> Add</button></form>
    <div className="prod-modal-actions"><button onClick={onTelegram} disabled={busy}><MessageCircle/> Connect Telegram</button><button onClick={onPush} disabled={busy}><Smartphone/> Enable web push</button><button onClick={onTest} disabled={busy}><Zap/> Send test</button></div>
    <div className="prod-inbox"><span className="card-kicker">RECENT IN-APP</span>{inbox.slice(0, 5).map((item) => <article key={item.id}><span className={`prod-severity ${item.severity.toLowerCase()}`} /><div><strong>{item.title}</strong><p>{item.body}</p><small>{time(item.createdAt)}</small></div></article>)}{!inbox.length && <p>No alerts yet.</p>}</div>
  </Modal>;
}

function PolicyPanel({ policy, setPolicy, onSave, busy }: { policy: UserPolicy; setPolicy: (value: UserPolicy) => void; onSave: () => void; busy: boolean }) {
  return <section className="prod-policy" id="policy"><div className="card-title-row"><div><span className="card-kicker">TIGHTEN ONLY</span><h3>Personal guardrails</h3></div><Pill tone="good">PLATFORM LOCKED</Pill></div>
    <p>You can make protection stricter. Server validation prevents settings above platform limits.</p>
    <label><span>Maximum paper order<strong>{dollars(policy.maxPaperOrderCents)}</strong></span><input type="range" min="100" max="25000" step="100" value={policy.maxPaperOrderCents} onChange={(event) => setPolicy({ ...policy, maxPaperOrderCents: Number(event.target.value) })}/></label>
    <label><span>Extended size<strong>{policy.extendedSizePct}%</strong></span><input type="range" min="0" max="25" value={policy.extendedSizePct} onChange={(event) => setPolicy({ ...policy, extendedSizePct: Number(event.target.value) })}/></label>
    <label><span>Earnings-window size<strong>{policy.earningsSizePct}%</strong></span><input type="range" min="0" max="10" value={policy.earningsSizePct} onChange={(event) => setPolicy({ ...policy, earningsSizePct: Number(event.target.value) })}/></label>
    <label><span>Move tolerance<strong>{policy.maxOffHoursMoveBps} bps</strong></span><input type="range" min="5" max="100" step="5" value={policy.maxOffHoursMoveBps} onChange={(event) => setPolicy({ ...policy, maxOffHoursMoveBps: Number(event.target.value) })}/></label>
    <label><span>Cash-session spread<strong>{policy.maxCashSpreadBps} bps</strong></span><input type="range" min="1" max="35" value={policy.maxCashSpreadBps} onChange={(event) => setPolicy({ ...policy, maxCashSpreadBps: Number(event.target.value) })}/></label>
    <label><span>Extended spread<strong>{policy.maxExtendedSpreadBps} bps</strong></span><input type="range" min="1" max="50" value={policy.maxExtendedSpreadBps} onChange={(event) => setPolicy({ ...policy, maxExtendedSpreadBps: Number(event.target.value) })}/></label>
    <label><span>Required collateral buffer<strong>{policy.minCollateralBufferPct}%</strong></span><input type="range" min="15" max="100" value={policy.minCollateralBufferPct} onChange={(event) => setPolicy({ ...policy, minCollateralBufferPct: Number(event.target.value) })}/></label>
    <label className="prod-check"><input type="checkbox" checked={policy.allowExtended} onChange={(event) => setPolicy({ ...policy, allowExtended: event.target.checked })}/><span>Allow tightly capped extended-session paper orders</span></label>
    <button className="button button-ink button-full" disabled={busy} onClick={onSave}><Save/> Save stricter policy</button>
  </section>;
}

export function ProductionDashboardPage() {
  const [searchParams] = useSearchParams();
  const initialReplay = searchParams.get("replay") ?? "sunday-oracle";
  const [mode, setMode] = useState<DeskMode>("REPLAY");
  const [replays, setReplays] = useState<ReplayOption[]>([]);
  const [replayId, setReplayId] = useState(initialReplay);
  const [symbol, setSymbol] = useState<ProductionSymbol>("RORCLUSDT");
  const [snapshot, setSnapshot] = useState<ProductionMarketSnapshot | null>(null);
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null);
  const [connection, setConnection] = useState({ connected: false, executionEnabled: false });
  const [policy, setPolicy] = useState<UserPolicy>(defaultUserPolicy);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [inbox, setInbox] = useState<PlatformNotification[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [nextReceiptOffset, setNextReceiptOffset] = useState<number | null>(null);
  const [decision, setDecision] = useState<GuardDecision | null>(null);
  const [notional, setNotional] = useState(250);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [earningsWindow, setEarningsWindow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showDemo, setShowDemo] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [replayFrame, setReplayFrame] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const demoTriggerRef = useRef<HTMLButtonElement>(null);

  const guardianVerdict = decision?.permission === "ALERT_ONLY" ? "ALERT" : decision?.permission ?? "BLOCK";
  const renderedRules = decision ? decisionRules(decision) : [];
  const primaryRule = decision ? primaryRuleForDecision(decision) : null;
  const prefersReducedMotion = typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const replayLastFrame = Math.max(0, (snapshot?.chart.length ?? 1) - 1);
  const replayReady = mode !== "REPLAY" || replayFrame >= replayLastFrame;
  const activeReplay = replays.find((item) => item.id === replayId);
  const displayedSnapshot = useMemo(() => snapshot && mode === "REPLAY"
    ? deriveReplayFrame(snapshot, replayFrame)
    : snapshot, [mode, replayFrame, snapshot]);

  const loadMarket = useCallback(async (nextSymbol = symbol, nextMode = mode, nextReplay = replayId) => {
    try {
      const result = await productionApi.snapshot(nextSymbol, nextMode, nextReplay);
      setSnapshot(result.snapshot); setError("");
    } catch (caught) {
      setError(`${caught instanceof Error ? caught.message : "Market unavailable"}. Live data was not relabelled as replay.`);
    }
  }, [mode, replayId, symbol]);

  const loadPrivate = useCallback(async (activeMode = mode, activeReplay = replayId) => {
    const results = await Promise.allSettled([
      productionApi.connection(), productionApi.policy(), productionApi.portfolio(activeMode, activeReplay),
      productionApi.decisions(), productionApi.channels(), productionApi.inbox(),
    ]);
    if (results[0].status === "fulfilled") setConnection(results[0].value);
    if (results[1].status === "fulfilled") setPolicy(results[1].value.policy);
    if (results[2].status === "fulfilled") setPortfolio(results[2].value.portfolio);
    if (results[3].status === "fulfilled") {
      setReceipts(results[3].value.receipts);
      setNextReceiptOffset(results[3].value.page.nextOffset);
    }
    if (results[4].status === "fulfilled") setChannels(results[4].value.channels);
    if (results[5].status === "fulfilled") setInbox(results[5].value.notifications);
  }, [mode, replayId]);

  useEffect(() => {
    Promise.allSettled([productionApi.replays(), productionApi.authMe()]).then(([replayResult, authResult]) => {
      if (replayResult.status === "fulfilled") {
        setReplays(replayResult.value.scenarios);
        const selected = replayResult.value.scenarios.find((item) => item.id === initialReplay) ?? replayResult.value.scenarios[0];
        if (selected) { setReplayId(selected.id); setSymbol(selected.symbol as ProductionSymbol); void loadMarket(selected.symbol as ProductionSymbol, "REPLAY", selected.id); }
      }
      if (authResult.status === "fulfilled") { setUser(authResult.value.user); void loadPrivate("REPLAY", initialReplay); }
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    const refreshActiveDesk = () => {
      if (document.visibilityState === "hidden") return;
      void Promise.allSettled([
        productionApi.portfolio(mode, mode === "REPLAY" ? replayId : undefined),
        productionApi.decisions(),
      ]).then(([portfolioResult, receiptResult]) => {
        if (portfolioResult.status === "fulfilled") setPortfolio(portfolioResult.value.portfolio);
        else setPortfolio(null);
        if (receiptResult.status === "fulfilled") {
          setReceipts(receiptResult.value.receipts);
          setNextReceiptOffset(receiptResult.value.page.nextOffset);
        }
      });
    };
    const interval = window.setInterval(refreshActiveDesk, 15_000);
    document.addEventListener("visibilitychange", refreshActiveDesk);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", refreshActiveDesk); };
  }, [mode, replayId, user]);

  useEffect(() => {
    if (mode !== "LIVE_BITGET") return;
    void loadMarket(symbol, mode, replayId);
    const interval = window.setInterval(() => void loadMarket(symbol, mode, replayId), 15_000);
    return () => window.clearInterval(interval);
  }, [mode, replayId, symbol]);

  useEffect(() => {
    if (mode !== "REPLAY" || snapshot?.dataMode !== "REPLAY") {
      setReplayPlaying(false);
      return;
    }
    setReplayFrame(prefersReducedMotion ? Math.max(0, snapshot.chart.length - 1) : 0);
    setReplayPlaying(false);
    setDecision(null);
  }, [mode, prefersReducedMotion, replayId, snapshot?.dataMode, snapshot?.providerTimestamp]);

  useEffect(() => {
    if (mode !== "REPLAY" || !snapshot || !replayPlaying || replayFrame >= replayLastFrame) return;
    const timer = window.setTimeout(() => setReplayFrame((current) => Math.min(current + 1, replayLastFrame)), 850);
    return () => window.clearTimeout(timer);
  }, [mode, replayFrame, replayLastFrame, replayPlaying, snapshot]);

  useEffect(() => {
    if (mode === "REPLAY" && replayPlaying && replayReady) setReplayPlaying(false);
  }, [mode, replayPlaying, replayReady]);

  useEffect(() => {
    if (!user) return;
    const stream = new EventSource("/api/v1/notifications/stream");
    stream.addEventListener("notification", (event) => {
      const notification = JSON.parse((event as MessageEvent).data) as PlatformNotification;
      setInbox((current) => [notification, ...current.filter((item) => item.id !== notification.id)]);
    });
    return () => stream.close();
  }, [user]);

  const authenticate = async () => {
    setBusy(true); setError("");
    try { const result = await signInWithWallet(); setUser(result.user); setNotice(`Wallet ${compactAddress(result.user.address)} verified on Arbitrum.`); await loadPrivate(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Wallet sign-in failed"); }
    finally { setBusy(false); }
  };

  const requireWallet = () => { if (!user) { void authenticate(); return false; } return true; };

  const chooseReplay = (id: string) => {
    const selected = replays.find((item) => item.id === id); if (!selected) return;
    setReplayId(id); setSymbol(selected.symbol as ProductionSymbol); setDecision(null); setError("");
    setReplayFrame(0); setReplayPlaying(false); setEarningsWindow(false);
    void loadMarket(selected.symbol as ProductionSymbol, "REPLAY", id);
    if (user) void loadPrivate("REPLAY", id);
  };

  const chooseMode = (next: DeskMode) => {
    const matchingReplay = next === "REPLAY" ? replays.find((item) => item.symbol === symbol)?.id ?? replayId : replayId;
    setMode(next); setDecision(null); setError(""); setReplayPlaying(false); setEarningsWindow(false);
    if (next === "REPLAY") { setReplayId(matchingReplay); setReplayFrame(0); }
    void loadMarket(symbol, next, matchingReplay);
    if (user) void loadPrivate(next, matchingReplay);
  };

  const selectSymbol = (next: ProductionSymbol) => {
    const matchingReplay = mode === "REPLAY" ? replays.find((item) => item.symbol === next)?.id ?? replayId : replayId;
    setSymbol(next); setDecision(null); setError(""); setReplayPlaying(false); setEarningsWindow(false);
    if (mode === "REPLAY") { setReplayId(matchingReplay); setReplayFrame(0); }
    void loadMarket(next, mode, matchingReplay);
    if (user) void loadPrivate(mode, matchingReplay);
  };

  const handleAssetKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, current: ProductionSymbol) => {
    const index = symbols.indexOf(current);
    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % symbols.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + symbols.length) % symbols.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = symbols.length - 1;
    else return;
    event.preventDefault();
    const next = symbols[nextIndex];
    selectSymbol(next);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-symbol=\"" + next + "\"]")?.focus());
  };

  const seekReplay = (frame: number) => {
    setReplayPlaying(false); setReplayFrame(Math.max(0, Math.min(frame, replayLastFrame))); setDecision(null); setError("");
  };

  const resetReplay = () => { setReplayPlaying(false); setReplayFrame(0); setDecision(null); setError(""); };
  const finishReplay = () => { setReplayPlaying(false); setReplayFrame(replayLastFrame); setDecision(null); setError(""); };
  const toggleReplay = () => {
    setDecision(null); setError("");
    if (prefersReducedMotion) { setReplayFrame(replayLastFrame); setReplayPlaying(false); return; }
    if (replayPlaying) { setReplayPlaying(false); return; }
    if (replayReady) setReplayFrame(0);
    setReplayPlaying(true);
  };

  const evaluate = async () => {
    if (mode === "REPLAY" && !replayReady) { setError("Reach the replay decision point before running the guard."); return; }
    if (!requireWallet() || !snapshot) return;
    setBusy(true); setError(""); setDecision(null);
    try {
      const result = await productionApi.evaluate({ symbol, side, notionalCents: Math.round(Math.min(250, Math.max(1, notional)) * 100),
        maxSlippageBps: 50, dataMode: mode, replayId: mode === "REPLAY" ? replayId : undefined, earningsWindow });
      setDecision(result.decision);
      setNotice(result.decision.permission === "BLOCK" ? "Exposure intercepted and logged." : result.decision.permission === "TRADE" ? "Single-use paper permission created." : "Alert recorded; no execution token issued.");
      await loadPrivate();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Guard evaluation failed"); }
    finally { setBusy(false); }
  };

  const execute = async () => {
    if (!decision?.decisionToken) return;
    setBusy(true); setError("");
    try { const result = await productionApi.execute(decision.decisionToken); setNotice(result.order.message); await loadPrivate(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Paper execution failed"); }
    finally { setBusy(false); }
  };

  const connectDemo = async (credentials: { apiKey: string; secretKey: string; passphrase: string }) => {
    setBusy(true); setError("");
    try { const result = await productionApi.connect(credentials); setConnection(result); setNotice("Bitget Demo credentials validated and encrypted at rest."); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Demo connection failed"); }
    finally { setBusy(false); }
  };

  const savePolicy = async () => {
    if (!requireWallet()) return;
    setBusy(true); try { const result = await productionApi.updatePolicy(policy); setPolicy(result.policy); setNotice("Stricter policy saved."); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Policy update failed"); } finally { setBusy(false); }
  };

  const refreshAlerts = async () => {
    const [channelResult, inboxResult] = await Promise.all([productionApi.channels(), productionApi.inbox()]);
    setChannels(channelResult.channels); setInbox(inboxResult.notifications);
  };

  const addPush = async () => {
    const channelResult = await productionApi.channels();
    if (!channelResult.vapidPublicKey) throw new Error("Web push is not configured on this environment.");
    const registration = await navigator.serviceWorker.register("/sw.js");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Browser notification permission was not granted.");
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(channelResult.vapidPublicKey) });
    await productionApi.addWebPush(subscription.toJSON()); await refreshAlerts();
  };

  const notificationAction = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setError("");
    try { await action(); await refreshAlerts(); setNotice(success); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Alert setup failed"); }
    finally { setBusy(false); }
  };

  const loadMoreReceipts = async () => {
    if (nextReceiptOffset === null) return;
    setBusy(true); setError("");
    try {
      const result = await productionApi.decisions(nextReceiptOffset);
      setReceipts((current) => [...current, ...result.receipts.filter((row) => !current.some((item) => item.decision.id === row.decision.id))]);
      setNextReceiptOffset(result.page.nextOffset);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Receipt page unavailable"); }
    finally { setBusy(false); }
  };

  return <motion.div className="dashboard-page production-dashboard" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
    <div className="paper-grain" />
    <header className="app-nav prod-nav"><Brand compact/><nav aria-label="App navigation"><a href="#market">Market</a><a href="#guard">Guard</a><a href="#decisions">Receipts</a><a href="#policy">Policy</a><Link to="/agent">Agent</Link></nav><div className="app-nav-actions"><button className="icon-button" aria-label="Notifications" onClick={() => user ? setShowAlerts(true) : void authenticate()}><Bell/><span className={inbox.some((item) => !item.readAt) ? "notification-dot" : ""}/></button>{user ? <button className="prod-wallet-chip" onClick={() => void productionApi.logout().then(() => { setUser(null); setConnection({ connected: false, executionEnabled: false }); })}><Wallet/>{compactAddress(user.address)}<LogOut/></button> : <button className="button button-ink" onClick={() => void authenticate()} disabled={busy}><Wallet/> Sign wallet</button>}<button ref={demoTriggerRef} className={`connection-pill ${connection.connected ? "is-connected" : ""}`} onClick={() => user ? setShowDemo(true) : void authenticate()}><span/>{connection.connected ? "Demo connected" : "Connect demo"}</button></div></header>

    <main className="dashboard-shell">
      <section className="desk-heading"><div><div className="eyebrow"><ShieldCheck/> Deterministic rToken risk infrastructure</div><h1>Permission desk</h1><p>Bitget session, Bitget anchor, portfolio stress, then a single-use paper permission.</p></div><div className="prod-mode" role="group" aria-label="Data source"><button className={mode === "REPLAY" ? "active" : ""} onClick={() => chooseMode("REPLAY")}><Play/> Scenario replay</button><button className={mode === "LIVE_BITGET" ? "active" : ""} onClick={() => chooseMode("LIVE_BITGET")}><Activity/> Live Bitget</button></div></section>

      <AnimatePresence>{(error || notice) && <motion.div className={`desk-message ${error ? "is-error" : "is-notice"}`} role={error ? "alert" : "status"} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>{error ? <CloudOff/> : <BadgeCheck/>}<span>{error || notice}</span>{error && mode === "LIVE_BITGET" && <button onClick={() => chooseMode("REPLAY")}>Open disclosed replay <ArrowRight/></button>}<button className="message-close" aria-label="Dismiss message" onClick={() => { setError(""); setNotice(""); }}><X/></button></motion.div>}</AnimatePresence>

      <section className="desk-toolbar" aria-label="Market controls"><div className="asset-tabs" role="tablist" aria-label="rToken asset">{symbols.map((item) => <button role="tab" aria-selected={symbol === item} tabIndex={symbol === item ? 0 : -1} className={symbol === item ? "active" : ""} key={item} data-symbol={item} onClick={() => selectSymbol(item)} onKeyDown={(event) => handleAssetKeyDown(event, item)}><span>{symbolMetadata[item].underlyingSymbol.slice(0, 2)}</span><span><strong>{symbolMetadata[item].displaySymbol}</strong><small>{symbolMetadata[item].companyName}</small></span></button>)}</div>{mode === "REPLAY" ? <label className="scenario-select"><span>Replay scenario</span><select aria-label="Replay scenario" value={replayId} onChange={(event) => chooseReplay(event.target.value)}>{replays.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown/></label> : <button className="refresh-button" onClick={() => void loadMarket()}><RefreshCw/> Refresh Bitget</button>}</section>

      {snapshot && displayedSnapshot ? <>
        <section className="market-overview" id="market">
          <div className="market-main-card">
            <div className="market-main-head">
              <div className="asset-title"><span className="asset-monogram">{displayedSnapshot.underlyingSymbol.slice(0, 2)}</span><div><span>{displayedSnapshot.companyName} rToken</span><h2>{displayedSnapshot.displaySymbol} <small>/ USDT</small></h2></div></div>
              <div className={`session-badge tone-${displayedSnapshot.session === "CASH_OPEN" ? "open" : displayedSnapshot.session === "MARKET_UNAVAILABLE" ? "block" : "alert"}`}><span/><div><small>SESSION</small><strong>{sessionLabel(displayedSnapshot.session)}</strong></div></div>
            </div>
            <div className="market-price-line">
              <div><strong>{price(displayedSnapshot.rTokenPriceMicros)}</strong><span className={(displayedSnapshot.offHoursMoveBps ?? 0) >= 0 ? "positive" : "negative"}>{displayedSnapshot.offHoursMoveBps === null ? "anchor missing" : `${displayedSnapshot.offHoursMoveBps > 0 ? "+" : ""}${displayedSnapshot.offHoursMoveBps.toFixed(1)} bps vs Bitget anchor`}</span></div>
              <div className="market-source"><small>DATA SOURCE · READ ONLY</small><span className={`market-source-status ${mode === "REPLAY" ? "source-replay" : "source-live"}`} role="status" title={mode === "REPLAY" ? "A bundled deterministic fixture—not a live feed or a button." : "Current public rToken data received from Bitget."}><i/>{mode === "REPLAY" ? "STATIC REPLAY DATA" : "LIVE BITGET FEED"}</span></div>
            </div>
            <ReplayMarketTimeline
              snapshot={snapshot}
              frameIndex={mode === "REPLAY" ? replayFrame : undefined}
              playing={replayPlaying}
              scenario={activeReplay}
              onToggle={toggleReplay}
              onReset={resetReplay}
              onSeek={seekReplay}
              onFinish={finishReplay}
            />
            <div className="chart-legend"><span><i className="legend-token"/> Bitget rToken</span><span><i className="legend-reference"/> Bitget cash-session anchor</span><span className="source-mode"><i/> {displayedSnapshot.referenceQuality}</span></div>
          </div>
          <div className="guardian-desk-card"><div className="guardian-desk-copy"><span className="card-kicker">SESSION GUARDIAN</span><h3>{sessionLabel(displayedSnapshot.session)}</h3><p>{displayedSnapshot.session === "CASH_OPEN" ? "US cash-session clock is open. Deterministic portfolio and size rules still apply." : "This rToken can move while the US cash session is dark. The anchor is a Bitget risk reference—not an underlying stock quote."}</p></div><GuardianScene verdict={guardianVerdict} compact/></div>
        </section>
        <section className="metric-grid">
          <article className="metric-card"><div className="metric-label"><Activity/> rToken quote</div><strong>{price(displayedSnapshot.rTokenPriceMicros)}</strong><small>Bid {price(displayedSnapshot.bidPriceMicros)} · Ask {price(displayedSnapshot.askPriceMicros)}</small></article>
          <article className="metric-card"><div className="metric-label"><Clock3/> Bitget anchor</div><strong>{price(displayedSnapshot.anchorPriceMicros)}</strong><small>{displayedSnapshot.referenceKind.replaceAll("_", " ")} · {time(displayedSnapshot.referenceTimestamp)}</small></article>
          <article className="metric-card"><div className="metric-label"><Gauge/> Quote freshness</div><strong>{displayedSnapshot.dataMode === "REPLAY" ? `Frame ${replayFrame + 1}/${snapshot.chart.length}` : `${(displayedSnapshot.quoteAgeMs / 1000).toFixed(1)}s`}</strong><small>{displayedSnapshot.spreadBps.toFixed(1)} bps Bitget spread</small></article>
          <article className="metric-card"><div className="metric-label"><MoonStar/> Next cash open</div><strong>{time(displayedSnapshot.nextCashOpen)}</strong><small>America / New York</small></article>
        </section>
      </> : <section className="prod-loading"><LoaderCircle className="spin"/><p>Loading disclosed market source…</p></section>}

      <section className="prod-control-grid" id="guard"><div className="prod-intent"><div className="card-title-row"><div><span className="card-kicker">PAPER INTENT</span><h3>Proposed order</h3></div><Pill>MAX $250</Pill></div><div className="side-switch"><button className={side === "buy" ? "active buy" : ""} onClick={() => setSide("buy")}>Buy / increase</button><button className={side === "sell" ? "active sell" : ""} onClick={() => setSide("sell")}>Sell / reduce</button></div><label className="notional-input"><span>Notional</span><span><i>$</i><input aria-label="Paper order notional" type="number" min="1" max="250" value={notional} onChange={(event) => setNotional(Number(event.target.value))}/><small>USD</small></span></label><label className="prod-check"><input type="checkbox" checked={earningsWindow} onChange={(event) => setEarningsWindow(event.target.checked)}/><span>Earnings risk window<small>Manual flag · resets when asset changes</small></span></label><div className="prod-data-boundary"><ShieldCheck/><span><strong>{mode === "REPLAY" ? "LOCAL REPLAY SIMULATION" : "BITGET DEMO ONLY"}</strong>No live-money route exists.</span></div></div>
        <div className={`permission-panel prod-permission verdict-${guardianVerdict.toLowerCase()}`}>
          <div className="card-title-row"><div><span className="card-kicker">DETERMINISTIC OUTPUT</span><h3>Permission</h3></div>{decision && <Pill tone={decision.permission === "TRADE" ? "good" : decision.permission === "BLOCK" ? "bad" : "warn"}>{decision.permission}</Pill>}</div>
          {decision && primaryRule ? <>
            <div className="prod-verdict"><strong>{decision.permission}</strong><span>ALLOWED<b>{dollars(decision.allowedNotionalCents)}</b></span></div>
            <div className={`prod-primary-rule effect-${primaryRule.effect.toLowerCase()}`}>
              <small>PRIMARY {primaryRule.effect} RULE</small>
              <strong>{primaryRule.code}</strong>
              <p>{primaryRule.message}</p>
            </div>
            <div className="prod-rule-list" aria-label="Evaluated guard rules">{renderedRules.slice(0, 6).map((rule) => <span className={`effect-${rule.effect.toLowerCase()}`} key={rule.code}><b>{rule.effect}</b>{rule.code}</span>)}</div>
            <div className="prod-stress-context">
              <strong>Projected {decision.snapshot.displaySymbol} position stress</strong>
              <span>Based on {dollars(decision.stressExposureCents ?? decision.requestedNotionalCents)} of exposure at this decision. Equal dollar exposure produces equal dollar gap P&amp;L across symbols.</span>
              {decision.availableBalanceCents !== undefined && <small>Spendable at decision: {dollars(decision.availableBalanceCents)} · Starting buffer: {decision.startingCollateralBufferPct ?? 0}% · Required: {decision.requiredCollateralBufferPct ?? policy.minCollateralBufferPct}%</small>}
            </div>
            <div className="prod-gap-row">{decision.gapScenarios.map((gap) => <span key={gap.gapPct}><small>{gap.gapPct}% OPEN</small><strong>{dollars(gap.pnlCents)}</strong><em>{gap.projectedCollateralBufferPct}% projected buffer</em></span>)}</div>
            {decision.decisionToken && <button className="button button-coral button-full" onClick={() => void execute()} disabled={busy}>{busy ? <LoaderCircle className="spin"/> : <Zap/>}{mode === "REPLAY" ? "Simulate allowed order" : "Submit to Bitget Demo"}</button>}
          </> : <div className="prod-empty-permission"><Ban/><p>No permission exists yet. The server will fail closed on missing or stale inputs.</p></div>}
          <button className="button button-ink button-full" onClick={() => void evaluate()} disabled={busy || !snapshot || (mode === "REPLAY" && !replayReady)}>{busy ? <LoaderCircle className="spin"/> : user ? <ShieldCheck/> : <Wallet/>}{mode === "REPLAY" && !replayReady ? "Reach decision point to run guard" : user ? "Run deterministic guard" : "Sign wallet to run guard"}</button>
        </div>
        <PolicyPanel policy={policy} setPolicy={setPolicy} onSave={() => void savePolicy()} busy={busy}/>
      </section>

      <section className="prod-portfolio"><div className="card-title-row"><div><span className="card-kicker">PORTFOLIO FRESHNESS</span><h3>{mode === "REPLAY" ? "Replay account" : "Bitget Demo account"}</h3></div>{portfolio ? <Pill tone={(Date.now() - new Date(portfolio.capturedAt).getTime()) < 15_000 ? "good" : "bad"}>{time(portfolio.capturedAt)}</Pill> : <Pill tone="warn">WALLET REQUIRED</Pill>}</div>{portfolio ? <><div className="prod-portfolio-grid"><span><small>EQUITY</small><strong>{dollars(portfolio.accountEquityCents)}</strong></span><span><small>SPENDABLE NOW</small><strong>{dollars(portfolio.availableBalanceCents)}</strong></span><span><small>COLLATERAL BUFFER</small><strong>{portfolio.collateralBufferPct}%</strong></span><span><small>OPEN ORDERS</small><strong>{portfolio.openOrderCount}</strong></span></div><div className="prod-positions" aria-label="rToken holdings">{portfolio.positions.length ? portfolio.positions.map((position) => <article key={position.symbol}><span className="asset-monogram">{symbolMetadata[position.symbol].underlyingSymbol.slice(0, 2)}</span><div><strong>{symbolMetadata[position.symbol].displaySymbol}</strong><small>{(position.quantityMicros / 1_000_000).toFixed(4)} tokens</small></div><span><strong>{dollars(position.marketValueCents)}</strong><small>{position.usedAsCollateral ? "COLLATERAL" : "NOT COLLATERAL"}</small></span></article>) : <p>No supported rToken holdings in this account.</p>}</div></> : <p>Sign your wallet to load a tenant-isolated portfolio snapshot.</p>}</section>

      <section className="decisions-section" id="decisions"><div className="decisions-head"><div><span className="section-index">IMMUTABLE EVIDENCE</span><h2>Every decision leaves a receipt.</h2><p>Tokens are removed before persistence; source, freshness, hashes, policy, and reasons remain.</p></div><a className="button button-outline" href="/api/v1/decisions/export" download><Download/> Export CSV</a></div><div className="receipts-table prod-receipts"><div className="receipt-table-head"><span>STATE</span><span>ASSET / SESSION</span><span>MOVE</span><span>PRIMARY RULE</span><span>EXECUTION</span></div>{receipts.length ? receipts.map(({ decision: item, order }) => <article className="receipt-row" key={item.id}><span className={`receipt-verdict verdict-${item.permission === "ALERT_ONLY" ? "alert" : item.permission.toLowerCase()}`}>{item.permission}</span><span><strong>{item.snapshot.displaySymbol}</strong><small>{item.snapshot.session}</small></span><span>{item.snapshot.offHoursMoveBps === null ? "—" : `${item.snapshot.offHoursMoveBps.toFixed(1)} bps`}</span><span><strong>{primaryRuleForDecision(item).code}</strong><small>{time(item.createdAt)}</small></span><span><strong>{executionLabel(order)}</strong><small>{order?.status ?? "Permission only"}</small></span></article>) : <div className="empty-receipts"><FileCheck2/><strong>{user ? "No receipts yet." : "Wallet receipts are private."}</strong><span>{user ? "Run the guard to create evidence." : "Sign in to inspect your audit trail."}</span></div>}</div>{nextReceiptOffset !== null && <button className="button button-outline prod-load-more" disabled={busy} onClick={() => void loadMoreReceipts()}>{busy ? <LoaderCircle className="spin"/> : <ChevronDown/>} Load older receipts</button>}</section>

      <section className="safety-strip"><ShieldCheck/><div><strong>Built to refuse.</strong><span>Wallet ownership · Bitget-only source · deterministic permission · single-use token</span></div><Pill tone="good"><span className="live-dot"/> NO LIVE MONEY PATH</Pill></section>
      <section className="prod-account"><div><strong>Account controls</strong><span>Export or delete tenant data. Sensitive actions require a wallet signature less than five minutes old.</span></div><div><a href="/api/v1/account/export" className="button button-outline"><Download/> Export data</a><button className="button button-outline danger" onClick={() => { if (user && window.confirm("Delete your SessionGuard account and encrypted credentials?")) void productionApi.deleteAccount().then(() => setUser(null)).catch((caught) => setError(caught.message)); }}><Trash2/> Delete account</button></div></section>
    </main>

    <nav className="mobile-bottom-nav" aria-label="Mobile navigation"><a href="#market"><Activity/><span>Market</span></a><a href="#guard"><ShieldCheck/><span>Guard</span></a><a href="#decisions"><FileCheck2/><span>Receipts</span></a><button type="button" onClick={() => setShowAlerts(true)}><Bell/><span>Alerts</span></button><Link to="/agent"><Bot/><span>Agent</span></Link></nav>
    <AnimatePresence>{showDemo && <DemoModal status={connection} busy={busy} error={error} onClose={() => { setShowDemo(false); window.requestAnimationFrame(() => demoTriggerRef.current?.focus()); }} onConnect={(value) => void connectDemo(value)} onDisconnect={() => void productionApi.disconnect().then(() => setConnection({ connected: false, executionEnabled: false }))}/>}</AnimatePresence>
    <AnimatePresence>{showAlerts && <NotificationsModal channels={channels} inbox={inbox} busy={busy} onClose={() => setShowAlerts(false)} onEmail={(email) => void notificationAction(async () => { const result = await productionApi.addEmail(email); if (result.verificationUrl) window.open(result.verificationUrl, "_blank", "noopener"); }, "Email verification started.")} onTelegram={() => void notificationAction(async () => { const result = await productionApi.addTelegram(); window.open(result.connectUrl, "_blank", "noopener"); }, "Telegram connection opened.")} onPush={() => void notificationAction(addPush, "Web push enabled.")} onTest={() => void notificationAction(productionApi.testNotification, "Test alert queued.")} onRemove={(id) => void notificationAction(() => productionApi.removeChannel(id), "Alert channel removed.")}/>}</AnimatePresence>
  </motion.div>;
}
