import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, AlertTriangle, ArrowLeft, BadgeCheck, Ban, BellRing, Bot, ChevronRight, CircleDollarSign,
  Clock3, CloudOff, Eye, FileCheck2, Gauge, KeyRound, LoaderCircle, LockKeyhole, Play, Radar,
  RefreshCw, RotateCcw, ShieldCheck, Sparkles, TriangleAlert, Wallet, X, Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import type {
  AgentMode, AgentOutcomeV1, AgentRiskSizingV1, AgentRunDetail, AgentRunState, AgentRunV1, AgentSettingsV1,
} from "../../shared/agent-types";
import type { AuthenticatedUser, ProductionSymbol } from "../../shared/production-types";
import { symbolMetadata } from "../../shared/production-types";
import { Brand } from "../components/Brand";
import {
  productionApi, signAgentGrant, signInWithWallet, type AgentConsoleStatus, type AgentSettingsUpdate,
} from "../lib/production-api";
import { buildAgentRunTape } from "../lib/agent-run-tape";
import "../agent.css";

type ReplayOption = { id: string; name: string; kicker: string; description: string; symbol: string };
const symbols = Object.keys(symbolMetadata) as ProductionSymbol[];
const activeExecutionStates = new Set<AgentRunState>(["EXECUTION_READY", "REVALIDATING", "SUBMITTING", "RECONCILING", "MONITORING"]);

function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function shortTime(value: string | null) {
  return value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value)) : "Not available";
}
function transitionTime(reasonCode: string, createdAt: string) {
  return reasonCode === "OUTCOME_MONITORING_SCHEDULED"
    ? `SCHEDULE REGISTERED · ${shortTime(createdAt)}`
    : `RECORDED · ${shortTime(createdAt)}`;
}
function observationSourceSummary(outcome: AgentOutcomeV1) {
  const sources = Object.values(outcome.observationSources ?? {}).filter((source): source is NonNullable<typeof source> => source !== null);
  if (!sources.length) return outcome.status === "PENDING" ? "OBSERVATIONS NOT CAPTURED YET" : "LEGACY SOURCE UNRECORDED";
  const labels = sources.map((source) => source === "LIVE_BITGET_QUOTE" ? "LIVE BITGET QUOTE"
    : source === "BITGET_COMPLETED_1M_CANDLE" ? "BITGET 1M CANDLE RECOVERY" : "RECORDED REPLAY");
  return [...new Set(labels)].join(" + ");
}
function outcomeProgressSummary(outcome: AgentOutcomeV1) {
  if (outcome.status !== "PENDING") return `scored ${shortTime(outcome.scoredAt)}`;
  if (outcome.nextOpenPriceMicros === null) return `next-open check due ${shortTime(outcome.observationDueAt)}`;
  const plus60DueAt = new Date(new Date(outcome.observationDueAt).getTime() + 60 * 60_000).toISOString();
  if (outcome.plus60mPriceMicros === null) return `next-open captured · +60-minute check due ${shortTime(plus60DueAt)}`;
  if (outcome.cashClosePriceMicros === null) return "next-open and +60-minute captured · cash-close check queued";
  return "all observation checkpoints captured · final scoring queued";
}


const sizingFactorLabels: Record<string, string> = {
  CONFIGURED_CEILING: "signed ceiling",
  EQUITY_BUDGET: "equity budget",
  SINGLE_NAME_HEADROOM: "single-name headroom",
  AGGREGATE_HEADROOM: "aggregate headroom",
  COLLATERAL_STRESS_HEADROOM: "12% stress headroom",
  SPENDABLE_BALANCE: "spendable balance",
  DAILY_HEADROOM: "daily headroom",
  CONFIDENCE_SCALE: "Qwen confidence",
  LIQUIDITY_SCALE: "spread / liquidity",
  EVENT_RISK_SCALE: "event risk",
};

function RiskSizingCard({ sizing, side }: { sizing: AgentRiskSizingV1; side: "buy" | "sell" | null }) {
  const capacities = (side === "sell" ? [
    ["Held-position limit", sizing.singleNameHeadroomCents],
    ["Signed/system ceiling", sizing.configuredCeilingCents],
  ] : [
    ["2% equity budget", sizing.equityCapCents],
    ["Single-name headroom", sizing.singleNameHeadroomCents],
    ["Aggregate headroom", sizing.aggregateHeadroomCents],
    ["12% stress headroom", sizing.collateralStressHeadroomCents],
    ["Spendable balance", sizing.spendableBalanceCents],
    ["Daily headroom", sizing.dailyHeadroomCents],
  ]) as ReadonlyArray<readonly [string, number]>;
  const multiplier = (bps: number) => (bps / 100).toFixed(bps % 100 === 0 ? 0 : 1) + "%";
  return <div className="agent-sizing-card">
    <header><span><small>RISK-SIZED CANDIDATE</small><strong>{money(sizing.riskSizedNotionalCents)}</strong></span><p>Qwen requested {money(sizing.requestedNotionalCents)}. The signed/system ceiling is {money(sizing.configuredCeilingCents)}; the engine can only reduce it.</p></header>
    <div className="agent-sizing-flow"><span><small>REQUEST</small><strong>{money(sizing.requestedNotionalCents)}</strong></span><ChevronRight/><span><small>CAPACITY</small><strong>{money(sizing.preMultiplierCents)}</strong></span><ChevronRight/><span><small>RISK SIZE</small><strong>{money(sizing.riskSizedNotionalCents)}</strong></span></div>
    <dl className="agent-sizing-capacities">{capacities.map(([label, cents]) => <div key={label}><dt>{label}</dt><dd>{money(cents)}</dd></div>)}</dl>
    <div className="agent-sizing-multipliers"><span><small>CONFIDENCE</small><strong>{multiplier(sizing.confidenceMultiplierBps)}</strong></span><span><small>LIQUIDITY</small><strong>{multiplier(sizing.liquidityMultiplierBps)}</strong></span><span><small>EVENT RISK</small><strong>{multiplier(sizing.eventMultiplierBps)}</strong></span></div>
    <p className="agent-sizing-factors"><strong>Applied:</strong> {sizing.limitingFactors.length ? sizing.limitingFactors.map((factor) => sizingFactorLabels[factor] ?? stateLabel(factor)).join(" · ") : "Qwen request was already below every capacity limit."}</p>
  </div>;
}

function compactAddress(address: string) { return `${address.slice(0, 6)}…${address.slice(-4)}`; }
function stateLabel(state: string) { return state.replaceAll("_", " "); }
function stateTone(state: AgentRunState) {
  return state === "BLOCKED" || state === "FAILED_CLOSED" || state === "EXPIRED" ? "block"
    : state === "ALERTED" || state === "RECONCILING" ? "warn"
      : state === "COMPLETED" || state === "SHADOW_COMPLETE" || state === "MONITORING" ? "good" : "live";
}

function StatusPill({ icon, label, value, tone = "neutral" }: { icon: ReactNode; label: string; value: string; tone?: string }) {
  return <div className={`agent-status-pill tone-${tone}`}>{icon}<span><small>{label}</small><strong>{value}</strong></span></div>;
}

function useDialogFocusTrap(panel: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((item) => !item.hidden && item.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) { event.preventDefault(); panel.current.focus(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1]; const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.current.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !panel.current.contains(active))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, [onClose, panel]);
}

function AgentLoopScene({ state, permission }: { state?: AgentRunState; permission?: "TRADE" | "ALERT_ONLY" | "BLOCK" }) {
  const stage = !state || ["QUEUED", "CONTEXT_BUILDING", "CONTEXT_READY"].includes(state) ? 0
    : state === "ASSESSING" ? 1 : state === "AUTHORIZING" ? 2 : 3;
  const blocked = permission === "BLOCK" || state === "BLOCKED" || state === "FAILED_CLOSED";
  const executing = state ? activeExecutionStates.has(state) : false;
  return <div className="agent-loop-scene" aria-label={`Agent safety loop: ${state ? stateLabel(state) : "waiting"}`} role="img">
    <svg viewBox="0 0 920 360" aria-hidden="true">
      <defs>
        <linearGradient id="agentSky" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#12352f"/><stop offset="1" stopColor="#285b50"/></linearGradient>
        <filter id="agentGlow"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <rect x="4" y="4" width="912" height="352" rx="32" fill="url(#agentSky)" stroke="#0c2924" strokeWidth="8"/>
      <circle cx="75" cy="62" r="24" fill="#f4c85f" opacity=".92"/><circle cx="68" cy="56" r="4" fill="#c9a544"/>
      {[145,208,672,814,856].map((x, i) => <motion.circle key={x} cx={x} cy={46 + (i % 2) * 25} r="3" fill="#fff8e9" animate={{ opacity: [.25, 1, .25] }} transition={{ repeat: Infinity, duration: 2 + i * .3 }}/>) }
      <path d="M35 285H885" stroke="#8cb8a4" strokeWidth="3" strokeDasharray="10 11" opacity=".55"/>
      <path d="M138 186C230 186 230 186 320 186S410 186 500 186 590 186 680 186 770 186 850 186" fill="none" stroke="#f4c85f" strokeWidth="3" strokeDasharray="8 12" opacity=".5"/>
      <motion.circle cx={138 + stage * 180} cy="186" r="8" fill="#ef735b" filter="url(#agentGlow)" animate={{ r: [7, 11, 7] }} transition={{ repeat: Infinity, duration: 1.5 }}/>
      <g transform="translate(52 116)"><circle cx="58" cy="68" r="49" fill="#f5efe3" stroke="#102d29" strokeWidth="6"/><circle cx="58" cy="68" r="30" fill="none" stroke="#ef735b" strokeWidth="5"/><path d="M58 68 87 48" stroke="#173b35" strokeWidth="7" strokeLinecap="round"/><motion.path d="M58 68 88 45" stroke="#f4c85f" strokeWidth="4" animate={{ rotate: [0,150,300,360] }} style={{ originX: "58px", originY: "68px" }} transition={{ repeat: Infinity, duration: 4, ease: "linear" }}/><text x="58" y="139" textAnchor="middle" className="agent-svg-label">OBSERVE</text></g>
      <g transform="translate(244 103)"><rect x="20" y="28" width="108" height="104" rx="31" fill="#f4c85f" stroke="#102d29" strokeWidth="7"/><path d="M74 28V8" stroke="#f5efe3" strokeWidth="7"/><circle cx="74" cy="7" r="8" fill="#ef735b"/><circle cx="55" cy="76" r="9" fill="#173b35"/><circle cx="94" cy="76" r="9" fill="#173b35"/><path d="M51 105q23 18 47 0" fill="none" stroke="#173b35" strokeWidth="6" strokeLinecap="round"/><motion.path d="M18 55C-5 68-5 94 18 106M130 55c23 13 23 39 0 51" fill="none" stroke="#f5efe3" strokeWidth="5" animate={{ opacity: stage === 1 ? [0,1,0] : .25 }} transition={{ repeat: Infinity, duration: 1.2 }}/><text x="74" y="162" textAnchor="middle" className="agent-svg-label">ASSESS</text></g>
      <g transform="translate(465 98)"><path d="M76 12 137 36v48c0 47-29 77-61 91-32-14-61-44-61-91V36L76 12Z" fill="#8cb8a4" stroke="#102d29" strokeWidth="7"/><path d="M76 29v126c23-12 43-34 43-70V48L76 29Z" fill="#f5efe3"/><path d="m47 83 20 20 40-48" fill="none" stroke="#ef735b" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round"/><text x="76" y="202" textAnchor="middle" className="agent-svg-label">AUTHORIZE</text></g>
      <g transform="translate(686 105)"><rect x="6" y="39" width="151" height="91" rx="18" fill={blocked ? "#ef735b" : executing ? "#8cb8a4" : "#f5efe3"} stroke="#102d29" strokeWidth="7"/><path d="M30 64h103M30 86h70M30 108h88" stroke="#173b35" strokeWidth="7" strokeLinecap="round" opacity=".7"/><motion.g animate={{ rotate: blocked ? 0 : executing ? -62 : -20 }} style={{ originX: "10px", originY: "41px" }}><rect x="0" y="27" width="176" height="27" rx="12" fill="#f5efe3" stroke="#102d29" strokeWidth="6"/><path d="M40 31 61 51M89 31l21 20M139 31l21 20" stroke="#ef735b" strokeWidth="12"/></motion.g><text x="81" y="163" textAnchor="middle" className="agent-svg-label">{blocked ? "DECLINE" : executing ? "DEMO ACT" : "WAIT"}</text></g>
    </svg>
    <div className="agent-loop-caption"><span className={stage === 0 ? "active" : ""}>Observe trusted inputs</span><span className={stage === 1 ? "active" : ""}>Qwen proposes</span><span className={stage === 2 ? "active" : ""}>Code decides permission</span><span className={stage === 3 ? "active" : ""}>{blocked ? "Declined safely" : executing ? "Bitget Demo only" : "No action"}</span></div>
  </div>;
}

function GrantReview({ settings, address, busy, onClose, onSigned }: { settings: AgentSettingsV1; address: string; busy: boolean; onClose: () => void; onSigned: () => void }) {
  const [confirmed, setConfirmed] = useState(false); const [error, setError] = useState(""); const [signing, setSigning] = useState(false);
  const panel = useRef<HTMLElement>(null); useDialogFocusTrap(panel, onClose);
  const sign = async () => {
    setError(""); setSigning(true);
    try { await signAgentGrant({ symbols: settings.symbols, actions: ["BUY", "REDUCE"], automaticOrderLimitCents: settings.automaticOrderLimitCents,
      automaticOrdersPerDay: settings.automaticOrdersPerDay, automaticGrossNewNotionalCents: settings.automaticGrossNewNotionalCents }, address); onSigned(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Grant signature failed"); }
    finally { setSigning(false); }
  };
  return <motion.div className="agent-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <motion.section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="grant-title" className="agent-grant-dialog" initial={{ y: 24, scale: .98 }} animate={{ y: 0, scale: 1 }}>
      <button className="agent-close" aria-label="Close grant review" onClick={onClose}><X/></button><div className="agent-dialog-icon"><KeyRound/></div><span className="agent-kicker">SEVEN-DAY SIWE SCOPE</span><h2 id="grant-title">Review what the loop may do.</h2>
      <p>This signature is separate from sign-in. It authorizes background orders only within the exact scope below.</p>
      <dl className="agent-scope-list"><div><dt>Venue</dt><dd>Bitget Demo only</dd></div><div><dt>Session</dt><dd>US cash open only</dd></div><div><dt>Symbols</dt><dd>{settings.symbols.map((symbol) => symbolMetadata[symbol].displaySymbol).join(", ")}</dd></div><div><dt>Actions</dt><dd>Buy + reduce-only</dd></div><div><dt>Per order</dt><dd>{money(settings.automaticOrderLimitCents)} maximum</dd></div><div><dt>Daily</dt><dd>{settings.automaticOrdersPerDay} orders · {money(settings.automaticGrossNewNotionalCents)} new notional</dd></div><div><dt>Expiry</dt><dd>Exactly 7 days · no auto-renewal</dd></div></dl>
      <div className="agent-never"><Ban/><span><strong>Never authorized</strong>Live money, shorts, transfers, prompt changes, or off-hours auto orders.</span></div>
      <label className="agent-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/><span>I understand this is a renewable Bitget Demo execution grant, not a sign-in message.</span></label>
      {error && <div className="agent-error" role="alert"><AlertTriangle/>{error}</div>}
      <button className="button button-coral button-full" disabled={!confirmed || busy || signing} onClick={() => void sign()}><Wallet/> Sign exact scope</button>
    </motion.section>
  </motion.div>;
}

function RunDrawer({ run, onClose }: { run: AgentRunDetail; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null); useDialogFocusTrap(panel, onClose);
  const monitoringScheduledAt = run.transitions.find((item) => item.reasonCode === "OUTCOME_MONITORING_SCHEDULED")?.createdAt ?? null;
  const nextOutcomeCheck = !run.outcome || run.outcome.status !== "PENDING" ? null
    : run.outcome.nextOpenPriceMicros === null
      ? `NEXT-OPEN PRICE CHECK DUE · ${shortTime(run.outcome.observationDueAt)}`
      : run.outcome.plus60mPriceMicros === null
        ? `+60-MINUTE PRICE CHECK DUE · ${shortTime(new Date(new Date(run.outcome.observationDueAt).getTime() + 60 * 60_000).toISOString())}`
        : "CASH-CLOSE PRICE CHECK QUEUED";
  return <motion.div className="agent-overlay drawer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <motion.aside ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="run-detail-title" className="agent-run-drawer" initial={{ x: 40 }} animate={{ x: 0 }} exit={{ x: 40 }}>
      <button className="agent-close" aria-label="Close run detail" onClick={onClose}><X/></button><span className="agent-kicker">TRACE {run.traceId.slice(0, 8)}</span><h2 id="run-detail-title">{symbolMetadata[run.symbol].displaySymbol} · {stateLabel(run.state)}</h2>
      <div className="agent-disclosure-row"><span className={run.sourceMode === "LOCAL_REPLAY" ? "replay" : "live"}>{run.sourceMode === "LOCAL_REPLAY" ? "LOCAL REPLAY" : "LIVE BITGET"}</span><span className={run.analystOrigin === "RECORDED" ? "replay" : "live"}>{run.analystOrigin === "RECORDED" ? "RECORDED QWEN FIXTURE" : "LIVE QWEN"}</span><span>DEMO ONLY</span></div>
      {run.context?.event && <section className="agent-detail-section"><h3>Trusted evidence</h3><a href={run.context.event.canonicalUrl} target="_blank" rel="noreferrer">{run.context.event.title}<ChevronRight/></a><small>{run.context.event.sourceType} · detected {shortTime(run.context.event.detectedAt)}</small>{run.context.evidence.slice(0, 3).map((segment) => <blockquote key={segment.id}><code>{segment.id}</code>{segment.text}</blockquote>)}</section>}
      <section className="agent-detail-section"><h3>Qwen proposal</h3>{run.assessment ? <><div className="agent-proposal"><strong>{run.assessment.action}</strong><span>{money(run.assessment.proposedNotionalCents)}</span><em>{Math.round(run.assessment.confidence * 100)}% confidence</em></div><p>{run.assessment.thesis}</p><ul>{run.assessment.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul></> : <p>No valid model assessment was persisted.</p>}</section>
      <section className="agent-detail-section"><h3>Deterministic permission</h3>{run.authorization ? <><div className={`agent-verdict tone-${run.authorization.permission === "BLOCK" ? "block" : run.authorization.permission === "ALERT_ONLY" ? "warn" : "good"}`}><strong>{run.authorization.permission}</strong><span>Allowed {money(run.authorization.allowedNotionalCents)}</span></div>{run.authorization.sizing && <RiskSizingCard sizing={run.authorization.sizing} side={run.authorization.side}/>} {run.authorization.reasonCodes.map((code, index) => <p className="agent-rule" key={code}><ShieldCheck/><span><strong>{code}</strong>{run.authorization!.reasons[index] ?? "Deterministic policy applied."}</span></p>)}</> : run.state === "FAILED_CLOSED" ? <p><strong>Failed closed: {stateLabel(run.failureCode ?? "UNKNOWN ERROR")}</strong> · No trade permission or adapter capability was issued.</p> : <p>Authorization has not reached a persisted result.</p>}</section>
      <section className="agent-detail-section"><h3>Receipt</h3><p>{run.receipt ? `${run.receipt.executionMode} · ${run.receipt.status} · ${run.receipt.message}` : run.sourceMode === "LOCAL_REPLAY" ? "No order receipt. Local replays are shadow-only and cannot enter the Bitget Demo adapter." : run.modeAtStart !== "PAPER_AUTO" ? "No order receipt. Shadow and Alert Only modes never issue an adapter capability." : "No order receipt. No adapter capability was issued."}</p></section>
      <section className="agent-detail-section"><h3>Transition timeline</h3><ol className="agent-trace">{run.transitions.map((item) => <li key={item.id}><i/><span><strong>{stateLabel(item.toState)}</strong><small>{item.reasonCode}</small><em>{transitionTime(item.reasonCode, item.createdAt)}</em></span></li>)}</ol></section>
      {run.outcome && <section className="agent-detail-section"><h3>Outcome monitoring</h3><div className="agent-monitoring-card"><Clock3/><span><small>{run.outcome.status === "PENDING" ? "OBSERVATION IN PROGRESS" : stateLabel(run.outcome.status)}</small><strong>{nextOutcomeCheck ?? `SCORED · ${shortTime(run.outcome.scoredAt)}`}</strong></span></div>{run.outcome.status === "PENDING" && <dl className="agent-monitoring-times"><div><dt>SCHEDULE REGISTERED</dt><dd>{shortTime(monitoringScheduledAt)}</dd></div><div><dt>NEXT OPEN</dt><dd>{run.outcome.nextOpenPriceMicros === null ? `Due ${shortTime(run.outcome.observationDueAt)}` : `Captured · ${shortTime(run.outcome.observationDueAt)}`}</dd></div><div><dt>+60 MINUTES</dt><dd>{run.outcome.plus60mPriceMicros === null ? `Due ${shortTime(new Date(new Date(run.outcome.observationDueAt).getTime() + 60 * 60_000).toISOString())}` : "Captured"}</dd></div><div><dt>CASH CLOSE</dt><dd>{run.outcome.cashClosePriceMicros === null ? "Queued" : "Captured"}</dd></div></dl>}<p>{run.outcome.status === "PENDING"
        ? "A pending outcome is not stuck: SessionGuard keeps it open until the required Bitget next-open, +60-minute, and cash-close observations have been captured."
        : run.outcome.label}</p><small className="agent-observation-origin">OBSERVATION SOURCE · {observationSourceSummary(run.outcome)}</small></section>}
    </motion.aside>
  </motion.div>;
}

export function AgentPage() {
  const [user, setUser] = useState<AuthenticatedUser | null>(null); const [status, setStatus] = useState<AgentConsoleStatus | null>(null);
  const [settings, setSettings] = useState<AgentSettingsV1 | null>(null); const [runs, setRuns] = useState<AgentRunV1[]>([]);
  const [outcomes, setOutcomes] = useState<AgentOutcomeV1[]>([]); const [replays, setReplays] = useState<ReplayOption[]>([]);
  const [selectedRun, setSelectedRun] = useState<AgentRunDetail | null>(null); const [showGrant, setShowGrant] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [streamState, setStreamState] = useState<"OFF" | "CONNECTING" | "LIVE" | "RETRYING">("OFF");

  const load = useCallback(async () => {
    const [statusResult, runsResult, outcomesResult] = await Promise.all([productionApi.agentStatus(), productionApi.agentRuns(), productionApi.agentOutcomes()]);
    setStatus(statusResult.status); setSettings(statusResult.status.settings); setRuns(runsResult.items); setOutcomes(outcomesResult.items);
  }, []);

  useEffect(() => {
    Promise.allSettled([productionApi.authMe(), productionApi.replays()]).then(([auth, replay]) => {
      if (replay.status === "fulfilled") setReplays(replay.value.scenarios);
      if (auth.status === "fulfilled") { setUser(auth.value.user); void load().catch((caught) => setError(caught.message)); }
    });
  }, [load]);

  useEffect(() => {
    if (!user) { setStreamState("OFF"); return; }
    setStreamState("CONNECTING"); const stream = new EventSource("/api/v1/agent/stream");
    const refresh = () => void load().catch(() => undefined);
    stream.addEventListener("agent", refresh); stream.addEventListener("status", refresh);
    stream.addEventListener("open", () => setStreamState("LIVE"));
    stream.addEventListener("error", () => setStreamState("RETRYING"));
    const interval = window.setInterval(refresh, 15_000);
    return () => { stream.close(); window.clearInterval(interval); setStreamState("OFF"); };
  }, [load, user]);

  const runTape = useMemo(() => buildAgentRunTape(runs), [runs]);
  const latest = runTape.items[0];
  const setup = useMemo(() => [
    { title: "Wallet identity", done: Boolean(user), detail: user ? compactAddress(user.address) : "Sign on Arbitrum One" },
    { title: "Bitget Demo", done: Boolean(status?.demo.connected && status.demo.executionEnabled), detail: status?.demo.connected ? "Connection verified" : "Connect on permission desk" },
    { title: "Symbols + alerts", done: Boolean(settings?.symbols.length && settings.notificationsEnabled), detail: settings ? `${settings.symbols.length} symbols monitored` : "Choose your watch set" },
    { title: "Shadow evidence", done: Boolean(status?.eligibility.eligible), detail: status ? `${status.eligibility.qualifyingRuns}/10 live runs · ${status.eligibility.ageRequirementMet ? "24h passed" : "24h pending"}` : "24h + 10 live runs" },
  ], [settings, status, user]);
  const visibleOutcomes = useMemo(() => [...outcomes].sort((left, right) => {
    const pendingFirst = Number(right.status === "PENDING") - Number(left.status === "PENDING");
    if (pendingFirst) return pendingFirst;
    if (left.status === "PENDING" && right.status === "PENDING") {
      return new Date(left.observationDueAt).getTime() - new Date(right.observationDueAt).getTime();
    }
    return new Date(right.scoredAt ?? right.observationDueAt).getTime()
      - new Date(left.scoredAt ?? left.observationDueAt).getTime();
  }), [outcomes]);

  const act = async <T,>(work: () => Promise<T>, success: string | ((result: T) => string)) => {
    setBusy(true); setError(""); setNotice("");
    try { const result = await work(); await load(); setNotice(typeof success === "function" ? success(result) : success); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Agent request failed"); }
    finally { setBusy(false); }
  };

  const authenticate = () => act(async () => { const result = await signInWithWallet(); setUser(result.user); }, "Wallet session verified.");
  const save = async (mode: "DISABLED" | "SHADOW" | "ALERT_ONLY" = settings?.mode === "PAPER_AUTO" ? "ALERT_ONLY" : settings?.mode ?? "SHADOW") => {
    if (!settings) return;
    const update: AgentSettingsUpdate = { mode, symbols: settings.symbols, offHoursMoveThresholdBps: settings.offHoursMoveThresholdBps,
      minCollateralBufferPct: settings.minCollateralBufferPct, automaticOrderLimitCents: settings.automaticOrderLimitCents,
      automaticOrdersPerDay: settings.automaticOrdersPerDay, automaticGrossNewNotionalCents: settings.automaticGrossNewNotionalCents,
      notificationsEnabled: settings.notificationsEnabled };
    await productionApi.updateAgentSettings(update);
  };
  const chooseMode = (mode: "DISABLED" | "SHADOW" | "ALERT_ONLY") => void act(() => save(mode), `${stateLabel(mode)} mode saved.`);
  const runReplay = (id: string, analyst: "RECORDED" | "QWEN") => void act(
    () => productionApi.agentReplay(id, analyst),
    (result) => result.status === "SKIPPED_DUPLICATE"
      ? "SKIPPED DUPLICATE · This exact replay event already has one decision."
      : `${analyst === "RECORDED" ? "Recorded" : "Live-Qwen"} replay queued.`,
  );
  const openRun = async (run: AgentRunV1) => { setBusy(true); try { setSelectedRun((await productionApi.agentRun(run.id)).run); } catch (caught) { setError(caught instanceof Error ? caught.message : "Run unavailable"); } finally { setBusy(false); } };
  const toggleSymbol = (symbol: ProductionSymbol) => {
    if (!settings) return; const selected = settings.symbols.includes(symbol);
    if (selected && settings.symbols.length === 1) { setError("At least one supported rToken must remain selected."); return; }
    setSettings({ ...settings, symbols: selected ? settings.symbols.filter((item) => item !== symbol) : [...settings.symbols, symbol] });
  };

  return <motion.div className="agent-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
    <div className="paper-grain"/><header className="agent-nav"><Brand compact/><nav aria-label="Agent navigation"><Link to="/app"><ArrowLeft/> Permission desk</Link><a href="#loop">Safety loop</a><a href="#runs">Runs</a><a href="#outcomes">Outcomes</a></nav><div>{user ? <span className="agent-wallet"><Wallet/>{compactAddress(user.address)}</span> : <button className="button button-ink" disabled={busy} onClick={() => void authenticate()}><Wallet/> Sign wallet</button>}</div></header>
    <main className="agent-shell">
      <section className="agent-hero"><div><div className="agent-eyebrow"><Sparkles/> EVENT-DRIVEN · DETERMINISTICALLY CONSTRAINED</div><h1>The loop that knows<br/><em>when not to trade.</em></h1><p>Qwen reads trusted events and proposes. SessionGuard checks the clock, evidence, portfolio, grant, and every hard limit before Bitget Demo can receive anything.</p><div className="agent-hero-actions">{!user ? <button className="button button-coral button-large" disabled={busy} onClick={() => void authenticate()}><Wallet/> Sign wallet to open console</button> : settings?.mode === "DISABLED" ? <button className="button button-coral button-large" disabled={busy} onClick={() => chooseMode("SHADOW")}><Eye/> Start safe shadow</button> : <button className="button button-ink button-large" onClick={() => document.getElementById("runs")?.scrollIntoView()}><Activity/> Inspect persisted runs</button>}<span className="agent-demo-boundary"><ShieldCheck/><span><strong>Bitget Demo only</strong><small>No live-money route exists</small></span></span></div></div><div className="agent-hero-stamp"><Bot/><strong>AGENT<br/>ONLINE</strong><small>{status?.runtimeEnabled ? "BACKGROUND LOOP" : "RUNTIME FLAG OFF"}</small></div></section>

      <section className="agent-status-strip" aria-label="Agent runtime status" aria-live="polite">
        <StatusPill icon={<Radar/>} label="MODE" value={status?.mode ?? "SIGNED OUT"} tone={status?.mode === "PAPER_AUTO" ? "good" : "neutral"}/>
        <StatusPill icon={<Activity/>} label="WORKER" value={status?.workerHealthy ? "HEALTHY" : "WAITING"} tone={status?.workerHealthy ? "good" : "warn"}/>
        <StatusPill icon={<Bot/>} label="QWEN" value={status?.qwenHealth ?? "PRIVATE"} tone={status?.qwenHealth === "HEALTHY" ? "good" : "warn"}/>
        <StatusPill icon={<FileCheck2/>} label="SEC / IR" value={status?.sourceHealth ?? "PRIVATE"} tone={status?.sourceHealth === "HEALTHY" ? "good" : "warn"}/>
        <StatusPill icon={<RefreshCw/>} label="LIVE UPDATES" value={streamState} tone={streamState === "LIVE" ? "good" : streamState === "OFF" ? "neutral" : "warn"}/>
        <StatusPill icon={<CircleDollarSign/>} label="BITGET" value={status?.demo.executionEnabled ? "DEMO READY" : "DEMO NEEDED"} tone={status?.demo.executionEnabled ? "good" : "warn"}/>
        <StatusPill icon={<KeyRound/>} label="GRANT" value={status?.grant.active ? `TO ${shortTime(status.grant.expiresAt)}` : "NO ACTIVE GRANT"} tone={status?.grant.active ? "good" : "neutral"}/>
        <StatusPill icon={<Clock3/>} label="CASH SESSION" value={status?.cashSession ? stateLabel(status.cashSession) : "PRIVATE"} tone={status?.cashSession === "CASH_OPEN" ? "good" : "warn"}/>
        <StatusPill icon={<Gauge/>} label="QUEUE" value={status ? `${status.queue.runnable} READY` : "PRIVATE"} tone={status && status.queue.oldestRunnableAgeMs >= 30_000 ? "block" : "neutral"}/>
      </section>

      <AnimatePresence>{(error || notice) && <motion.div className={`agent-message ${error ? "error" : "notice"}`} role={error ? "alert" : "status"} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>{error ? <CloudOff/> : <BadgeCheck/>}<span>{error || notice}</span><button aria-label="Dismiss message" onClick={() => { setError(""); setNotice(""); }}><X/></button></motion.div>}</AnimatePresence>

      <section className="agent-console-grid" id="loop"><div className="agent-loop-card"><div className="agent-card-head"><div><span className="agent-kicker">PERSISTED STATE MACHINE</span><h2>Observe → assess → authorize → act</h2></div><span className={`agent-state tone-${latest ? stateTone(latest.state) : "neutral"}`}><i/>{latest ? stateLabel(latest.state) : "WAITING FOR EVENT"}</span></div><AgentLoopScene state={latest?.state} permission={latest?.authorization?.permission}/><div className="agent-loop-proof"><span><Eye/><strong>Qwen proposes</strong><small>No order tool or credentials</small></span><ChevronRight/><span><ShieldCheck/><strong>Code permits</strong><small>Cannot increase model size</small></span><ChevronRight/><span><Zap/><strong>Demo acts</strong><small>Cash-open + grant only</small></span></div></div>
        <aside className="agent-onboarding"><span className="agent-kicker">ACTIVATION GATES</span><h2>Earn autonomy safely.</h2><p>PAPER_AUTO stays locked until both shadow requirements and the separate seven-day signature pass.</p><ol>{setup.map((item, index) => <li className={item.done ? "done" : ""} key={item.title}><span>{item.done ? <BadgeCheck/> : index + 1}</span><div><strong>{item.title}</strong><small>{item.detail}</small></div></li>)}</ol>{status && <div className="agent-progress"><span><i style={{ width: `${Math.min(100, status.eligibility.qualifyingRuns / 10 * 100)}%` }}/></span><small>Earliest eligible: {shortTime(status.eligibility.earliestEligibleAt)}</small></div>}<Link className="button button-outline button-full" to="/app">Open wallet & Demo setup <ChevronRight/></Link></aside>
      </section>

      <section className="agent-controls"><div className="agent-section-title"><span className="agent-kicker">HUMAN CONTROL PLANE</span><h2>Choose how far the loop may go.</h2><p>Every level runs the same analyst and deterministic guard. Only one level can produce a Demo capability.</p></div><div className="agent-mode-grid">{([
        ["DISABLED", "Off", "No background triggers are processed.", <Ban/>], ["SHADOW", "Shadow", "Full decisions, zero capabilities and zero orders.", <Eye/>],
        ["ALERT_ONLY", "Alert only", "Send actionable decisions; execution stays impossible.", <BellRing/>], ["PAPER_AUTO", "Paper auto", "Cash-open Bitget Demo only, under a seven-day scope.", <Zap/>],
      ] as Array<[AgentMode, string, string, ReactNode]>).map(([mode, title, description, icon]) => {
        const locked = (mode === "PAPER_AUTO" && (!status?.eligibility.eligible || !status.demo.executionEnabled)) ||
          (mode === "ALERT_ONLY" && settings?.mode === "DISABLED");
        return <article className={`${settings?.mode === mode ? "active" : ""} ${locked ? "locked" : ""}`} key={mode}><span>{icon}</span><div><small>{mode}</small><h3>{title}</h3><p>{description}</p></div>{mode === "PAPER_AUTO" ? <button disabled={!user || locked || busy} onClick={() => setShowGrant(true)}>{settings?.mode === mode ? "Renew scope" : locked ? "Locked" : "Review & sign"}<LockKeyhole/></button> : <button disabled={!user || busy || settings?.mode === mode} onClick={() => chooseMode(mode)}>{settings?.mode === mode ? "Current" : "Select"}</button>}</article>;
      })}</div>

        {status?.grant.expiresAt && <div className="agent-active-grant"><div><KeyRound/><span><strong>{status.grant.active ? "Background grant active" : "Background grant inactive"}</strong><small>{status.grant.active ? `Expires ${shortTime(status.grant.expiresAt)} · no automatic renewal` : "Expired or inactive; revoke to return to alert-only."}</small></span></div><button className="button button-outline" disabled={busy} onClick={() => void act(() => productionApi.revokeAgentGrant(), "Background grant revoked. No wallet signature was required.")}><Ban/> Revoke grant</button></div>}

        {settings && <div className="agent-policy-card"><div><span className="agent-kicker">TIGHTEN-ONLY SETTINGS</span><h3>Monitored rTokens</h3><div className="agent-symbols">{symbols.map((symbol) => <button aria-pressed={settings.symbols.includes(symbol)} className={settings.symbols.includes(symbol) ? "selected" : ""} onClick={() => toggleSymbol(symbol)} key={symbol}><span>{symbolMetadata[symbol].underlyingSymbol.slice(0, 2)}</span><strong>{symbolMetadata[symbol].displaySymbol}</strong><small>{settings.symbols.includes(symbol) ? "MONITORED" : "OFF"}</small></button>)}</div></div><div className="agent-sliders"><label><span>Off-hours trigger <strong>{settings.offHoursMoveThresholdBps} bps</strong></span><input type="range" min="10" max="100" step="5" value={settings.offHoursMoveThresholdBps} onChange={(event) => setSettings({ ...settings, offHoursMoveThresholdBps: Number(event.target.value) })}/></label><label><span>Auto order ceiling <strong>{money(settings.automaticOrderLimitCents)}</strong></span><input type="range" min="100" max="25000" step="100" value={settings.automaticOrderLimitCents} onChange={(event) => setSettings({ ...settings, automaticOrderLimitCents: Number(event.target.value) })}/><small className="agent-ceiling-note">$250 is the absolute ceiling. Portfolio and market risk normally authorize less.</small></label><label className="agent-check"><input type="checkbox" checked={settings.notificationsEnabled} onChange={(event) => setSettings({ ...settings, notificationsEnabled: event.target.checked })}/><span>Deliver agent alerts to verified channels</span></label><button className="button button-ink" disabled={busy || !user} onClick={() => void act(() => save(), "Agent settings saved.")}><ShieldCheck/> Save constraints</button></div></div>}
      </section>

      <section className="agent-replays"><div className="agent-section-title"><span className="agent-kicker">DISCLOSED ORCHESTRATOR REPLAYS</span><h2>Watch the refusal, not a frozen chart.</h2><p>These run through the same durable loop. They are always labelled local simulation and never enter the Bitget adapter.</p></div><div className="agent-replay-grid">{replays.filter((item) => ["sunday-oracle", "cash-nvidia"].includes(item.id)).map((item) => <article key={item.id}><span className="agent-replay-source">LOCAL REPLAY · BITGET-ALIGNED FIXTURE</span><h3>{item.name}</h3><p>{item.description}</p><div><button className="button button-coral" disabled={!user || busy || !status?.runtimeEnabled} onClick={() => runReplay(item.id, "RECORDED")}><Play/> Run recorded analyst</button><button className="button button-outline" disabled={!user || busy || status?.qwenHealth === "DISABLED"} onClick={() => runReplay(item.id, "QWEN")}><Bot/> Run live Qwen</button></div></article>)}</div></section>

      <section className="agent-runs" id="runs"><div className="agent-section-title row"><div><span className="agent-kicker">IMMUTABLE RUN EVIDENCE</span><h2>Latest decisions</h2></div>{user && <button className="button button-outline" disabled={busy} onClick={() => void load()}><RefreshCw/> Refresh</button>}</div>{runTape.collapsedCount > 0 && <div className="agent-dedupe-note" role="status"><ShieldCheck/><span><strong>{runTape.collapsedCount} repeated legacy {runTape.collapsedCount === 1 ? "record" : "records"} grouped</strong><small>One unchanged source event or risk state now produces one visible decision. Every original row remains available in the immutable audit export.</small></span></div>}<div className="agent-run-table"><div className="agent-run-head"><span>STATE</span><span>ASSET / TRIGGER</span><span>ANALYST</span><span>PROPOSAL → ALLOWED</span><span>RUN STARTED</span><span/></div>{runTape.items.length ? runTape.items.map((run) => <button className="agent-run-row" onClick={() => void openRun(run)} key={run.id}><span><i className={`tone-${stateTone(run.state)}`}/>{stateLabel(run.state)}</span><span><strong>{symbolMetadata[run.symbol].displaySymbol}</strong><small>{run.context?.trigger.type ?? "QUEUED"}</small></span><span><strong>{run.analystOrigin === "RECORDED" ? "RECORDED FIXTURE" : "QWEN"}</strong><small>{run.sourceMode === "LOCAL_REPLAY" ? "LOCAL REPLAY" : "LIVE BITGET"}</small></span><span><strong>{run.assessment ? `${run.assessment.action} ${money(run.assessment.proposedNotionalCents)}` : run.state === "FAILED_CLOSED" ? "NO VALID PROPOSAL" : "ASSESSING"}</strong><small>{run.authorization ? `${run.authorization.permission} ${money(run.authorization.allowedNotionalCents)}` : run.state === "FAILED_CLOSED" ? `FAIL CLOSED · ${money(0)}` : "Permission pending"}</small></span><span>{shortTime(run.createdAt)}</span><ChevronRight/></button>) : <div className="agent-empty"><FileCheck2/><strong>{user ? "No agent runs yet." : "Run history is wallet-private."}</strong><span>{user ? "Enable shadow or launch a disclosed replay." : "Sign in to inspect persisted evidence."}</span></div>}</div></section>

      <section className="agent-outcomes" id="outcomes"><div className="agent-section-title"><span className="agent-kicker">BITGET-ONLY OUTCOMES</span><h2>Honest result labels.</h2><p>No fake Sharpe, no underlying-stock feed, and no “saved” claim when data is missing.</p></div><div className="agent-outcome-grid">{visibleOutcomes.slice(0, 6).map((outcome) => <article key={outcome.id}><div><span className={`tone-${outcome.status === "AVOIDED_LOSS" ? "good" : outcome.status === "MISSED_UPSIDE" ? "warn" : "neutral"}`}>{stateLabel(outcome.status)}</span><small>{symbolMetadata[outcome.symbol].displaySymbol}</small></div><strong>{outcome.pnlCents === null ? "—" : money(outcome.pnlCents)}</strong><p>{outcome.label}</p><small>Decision {money(outcome.proposedNotionalCents)} · {outcomeProgressSummary(outcome)} · {observationSourceSummary(outcome)}</small></article>)}{!outcomes.length && <div className="agent-empty outcome"><Gauge/><strong>Outcomes appear after observation windows.</strong><span>Missing fresh Bitget data remains insufficient—not interpolated.</span></div>}</div></section>

      <section className="agent-boundary"><ShieldCheck/><div><strong>Autonomy with a hard perimeter.</strong><span>Official events · Bitget rTokens · deterministic permission · Bitget Demo only</span></div><code>LIVE MONEY = IMPOSSIBLE</code></section>
    </main>
    <AnimatePresence>{showGrant && settings && user && <GrantReview settings={settings} address={user.address} busy={busy} onClose={() => setShowGrant(false)} onSigned={() => { setShowGrant(false); void load(); setNotice("PAPER_AUTO grant verified for exactly seven days."); }}/>}</AnimatePresence>
    <AnimatePresence>{selectedRun && <RunDrawer run={selectedRun} onClose={() => setSelectedRun(null)}/>}</AnimatePresence>
  </motion.div>;
}
