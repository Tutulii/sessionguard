import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  BadgeCheck,
  Ban,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  CloudOff,
  Download,
  ExternalLink,
  FileCheck2,
  Filter,
  Gauge,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MoonStar,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TimerReset,
  TrendingDown,
  TrendingUp,
  Unplug,
  X,
  Zap,
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { replayScenarios as bundledReplays } from "../../shared/replays";
import {
  defaultAccount,
  defaultPolicy,
  type AccountContext,
  type DecisionReceipt,
  type MarketEvent,
  type MarketSnapshot,
  type ReplayScenario,
  type SupportedSymbol,
  type TradingPolicy,
  type Verdict,
} from "../../shared/types";
import { AppNav } from "../components/Brand";
import { GuardianScene } from "../components/GuardianScene";
import { MarketChart } from "../components/MarketChart";
import { api } from "../lib/api";

type DeskMode = "replay" | "live";
type GatePhase = "idle" | "event" | "agent" | "rules" | "complete";

const symbolLabels: Record<SupportedSymbol, { ticker: string; company: string; accent: string }> = {
  RNVDAUSDT: { ticker: "rNVDA", company: "NVIDIA", accent: "NV" },
  RTSLAUSDT: { ticker: "rTSLA", company: "Tesla", accent: "TS" },
  RORCLUSDT: { ticker: "rORCL", company: "Oracle", accent: "OR" },
};

const replayPreview: Record<string, { verdict: Verdict; reason: string }> = {
  "sunday-oracle": {
    verdict: "BLOCK",
    reason: "Cash market dark — new weekend exposure is forbidden.",
  },
  "cash-nvidia": {
    verdict: "TRADE",
    reason: "Session, spread, evidence, and collateral checks pass.",
  },
  "extended-tesla": {
    verdict: "ALERT",
    reason: "Qwen recommends HOLD in a thinner extended session.",
  },
};

const phaseOrder: GatePhase[] = ["event", "agent", "rules", "complete"];

function money(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  }).format(value);
}

function signed(value: number, suffix = "") {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function compactTime(value: string) {
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.round((new Date(value).getTime() - Date.now()) / 60_000),
    "minute",
  );
}

function sessionCopy(session: MarketSnapshot["session"]) {
  if (session === "CASH_OPEN") return { label: "Cash market open", short: "CASH OPEN", tone: "open" };
  if (session === "EXTENDED") return { label: "Extended session", short: "EXTENDED", tone: "alert" };
  if (session === "WEEKEND_HOLIDAY") return { label: "Weekend / holiday", short: "CASH DARK", tone: "block" };
  return { label: "Cash market closed", short: "CLOSED", tone: "block" };
}

function previewGap(position: number, equity: number, buffer: number, gapPct: number) {
  const pnl = position * (gapPct / 100);
  return {
    pnl,
    buffer: Math.max(0, buffer - (Math.abs(pnl) / equity) * 100),
  };
}

function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`desk-pill tone-${tone}`}>{children}</span>;
}

function IconLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="icon-label">{icon}{children}</span>;
}

function MetricCard({
  label,
  value,
  note,
  icon,
  tone = "",
}: {
  label: string;
  value: string;
  note: string;
  icon: ReactNode;
  tone?: string;
}) {
  return (
    <motion.article
      className={`metric-card ${tone}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4 }}
    >
      <div className="metric-label">{icon}<span>{label}</span></div>
      <strong>{value}</strong>
      <small>{note}</small>
    </motion.article>
  );
}

function ModeSwitch({ mode, setMode }: { mode: DeskMode; setMode: (mode: DeskMode) => void }) {
  return (
    <div className="mode-switch" role="group" aria-label="Data source">
      <motion.span
        className="mode-switch-slider"
        animate={{ x: mode === "live" ? "100%" : "0%" }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
      />
      <button aria-pressed={mode === "replay"} className={mode === "replay" ? "active" : ""} onClick={() => setMode("replay")}>
        <Play size={14} /> Replay
      </button>
      <button aria-pressed={mode === "live"} className={mode === "live" ? "active" : ""} onClick={() => setMode("live")}>
        <Activity size={14} /> Live
      </button>
    </div>
  );
}

function ProcessingRail({ phase }: { phase: GatePhase }) {
  const activeIndex = phase === "idle" ? -1 : phaseOrder.indexOf(phase);
  const steps = [
    { phase: "event" as const, label: "Verify event", icon: <FileCheck2 size={17} /> },
    { phase: "agent" as const, label: "Qwen reads", icon: <BrainCircuit size={17} /> },
    { phase: "rules" as const, label: "Rules enforce", icon: <ShieldCheck size={17} /> },
    { phase: "complete" as const, label: "Receipt", icon: <BadgeCheck size={17} /> },
  ];
  return (
    <div className="processing-rail" role="status" aria-label="Decision progress" aria-live="polite">
      {steps.map((step, index) => {
        const done = activeIndex >= index;
        const current = activeIndex === index && phase !== "complete";
        return (
          <div className={`processing-step ${done ? "done" : ""} ${current ? "current" : ""}`} key={step.phase}>
            <span>{current ? <LoaderCircle className="spin" size={17} /> : done ? <Check size={17} /> : step.icon}</span>
            <small>{step.label}</small>
            {index < steps.length - 1 && <i />}
          </div>
        );
      })}
    </div>
  );
}

function EventCard({ event, live }: { event: MarketEvent; live: boolean }) {
  return (
    <article className="event-card">
      <div className="card-title-row">
        <div>
          <span className="card-kicker">VERIFIED INPUT</span>
          <h3>Official event</h3>
        </div>
        <Pill tone="good"><BadgeCheck size={13} /> {event.source}</Pill>
      </div>
      <div className="event-source-line">
        <span className={`source-pulse ${live ? "is-live" : ""}`} />
        <span>{event.sourceName}</span>
        <small>{timeLabel(event.publishedAt)}</small>
      </div>
      <h4>{event.headline}</h4>
      <p>{event.summary}</p>
      <a href={event.sourceUrl} target="_blank" rel="noreferrer">
        Inspect source <ExternalLink size={13} />
      </a>
    </article>
  );
}

function AssessmentCard({ receipt, scenario }: { receipt: DecisionReceipt | null; scenario: ReplayScenario | null }) {
  const assessment = receipt?.decision.assessment ?? scenario?.assessment;
  if (!assessment) {
    return (
      <article className="assessment-card empty-panel">
        <BrainCircuit size={25} />
        <p>Select a verified event to begin.</p>
      </article>
    );
  }
  const confidence = Math.round(assessment.confidence * 100);
  return (
    <article className="assessment-card">
      <div className="card-title-row">
        <div>
          <span className="card-kicker">INTERPRETATION</span>
          <h3>Qwen assessment</h3>
        </div>
        <Pill tone={assessment.proposedAction === "HOLD" ? "warn" : "good"}>{assessment.proposedAction}</Pill>
      </div>
      <p className="assessment-summary">“{assessment.summary}”</p>
      <div className="assessment-grid">
        <span><small>NOVELTY</small><strong>{assessment.novelty}</strong></span>
        <span><small>RELEVANCE</small><strong>{assessment.relevance}</strong></span>
        <span><small>CONFIDENCE</small><strong>{confidence}%</strong></span>
      </div>
      <div className="confidence-track" role="progressbar"
        aria-label="Qwen confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={confidence}
      >
        <motion.i initial={{ width: 0 }} animate={{ width: `${confidence}%` }} />
      </div>
      <small className="model-boundary"><LockKeyhole size={13} /> Qwen proposes. Deterministic policy authorizes.</small>
    </article>
  );
}

function PermissionPanel({
  receipt,
  preview,
  running,
  phase,
  onRun,
  onExecute,
  connected,
  executionEnabled,
  onNeedsConnect,
  mode,
}: {
  receipt: DecisionReceipt | null;
  preview: { verdict: Verdict; reason: string };
  running: boolean;
  phase: GatePhase;
  onRun: () => void;
  onExecute: () => void;
  connected: boolean;
  executionEnabled: boolean;
  onNeedsConnect: () => void;
  mode: DeskMode;
}) {
  const verdict = receipt?.decision.verdict ?? preview.verdict;
  const reasons = receipt?.decision.reasons ?? [preview.reason];
  const canExecute = Boolean(receipt?.decision.decisionToken && verdict === "TRADE");
  const tradeDecision = Boolean(receipt && verdict === "TRADE");
  return (
    <motion.article className={`permission-panel verdict-${verdict.toLowerCase()}`} layout>
      <div className="permission-panel-head">
        <div>
          <span className="card-kicker">DETERMINISTIC OUTPUT</span>
          <h3>Permission gate</h3>
        </div>
        {!receipt && <Pill>PREVIEW</Pill>}
      </div>
      <div className="permission-stamp-wrap">
        <AnimatePresence mode="wait">
          <motion.div
            className="permission-stamp"
            key={`${verdict}-${running}`}
            initial={{ opacity: 0, scale: 1.5, rotate: -10 }}
            animate={{ opacity: running ? 0.35 : 1, scale: 1, rotate: -3 }}
            exit={{ opacity: 0, scale: 0.8 }}
          >
            {verdict === "BLOCK" ? <Ban /> : verdict === "ALERT" ? <AlertTriangle /> : <ShieldCheck />}
            <span>{running ? "CHECKING" : verdict}</span>
          </motion.div>
        </AnimatePresence>
      </div>
      <ul className="rule-results">
        {reasons.slice(0, 4).map((reason, index) => (
          <motion.li key={`${reason}-${index}`} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * 0.08 }}>
            <span>{verdict === "BLOCK" && index === 0 ? <X size={13} /> : <Check size={13} />}</span>
            {reason}
          </motion.li>
        ))}
      </ul>
      {receipt && (
        <div className="notional-result">
          <span><small>REQUESTED</small><strong>{money(receipt.decision.requestedNotionalUsd, 0)}</strong></span>
          <ArrowRight size={18} />
          <span><small>ALLOWED</small><strong>{money(receipt.decision.allowedNotionalUsd, 0)}</strong></span>
        </div>
      )}
      <button className="button button-coral button-full" onClick={onRun} disabled={running}>
        {running ? <><LoaderCircle className="spin" size={17} /> Gate is checking…</> : <><ShieldCheck size={17} /> Run permission gate</>}
      </button>
      {tradeDecision && (
        <button
          className="button button-ink button-full"
          onClick={canExecute ? onExecute : onNeedsConnect}
          disabled={mode === "live" && connected && !executionEnabled}
        >
          <Zap size={17} /> {mode === "replay"
            ? "Simulate allowed order"
            : !connected
              ? "Connect demo & rerun"
              : executionEnabled ? "Send to Bitget Demo" : "rToken demo unavailable"}
        </button>
      )}
      <ProcessingRail phase={phase} />
    </motion.article>
  );
}

function GapSimulator({
  receipt,
  account,
  setAccount,
}: {
  receipt: DecisionReceipt | null;
  account: AccountContext;
  setAccount: (next: AccountContext) => void;
}) {
  const [gapPct, setGapPct] = useState(-8);
  const position = account.currentPositionUsd + (receipt?.decision.allowedNotionalUsd ?? 0);
  const custom = previewGap(position, account.accountEquityUsd, account.collateralBufferPct, gapPct);
  const presets = receipt?.decision.gaps ?? [-3, -8, -12].map((gap) => ({
    gapPct: gap,
    pnlUsd: previewGap(position, account.accountEquityUsd, account.collateralBufferPct, gap).pnl,
    projectedBufferPct: previewGap(position, account.accountEquityUsd, account.collateralBufferPct, gap).buffer,
  }));
  return (
    <article className="gap-card">
      <div className="card-title-row">
        <div><span className="card-kicker">STRESS TEST</span><h3>Monday gap lab</h3></div>
        <Pill tone={custom.buffer < defaultPolicy.minCollateralBufferPct ? "bad" : "warn"}>
          <Gauge size={13} /> {custom.buffer.toFixed(1)}% buffer
        </Pill>
      </div>
      <p className="gap-lede">Move the Monday open. See the account impact before the headline becomes exposure.</p>
      <div className="gap-hero-number">
        <span>{gapPct}%</span>
        <div><small>ESTIMATED POSITION P&amp;L</small><strong>{money(custom.pnl)}</strong></div>
      </div>
      <input
        aria-label="Monday opening gap percentage"
        className="gap-slider"
        type="range"
        min="-15"
        max="5"
        step="1"
        value={gapPct}
        onChange={(event) => setGapPct(Number(event.target.value))}
        style={{ "--gap-fill": `${((gapPct + 15) / 20) * 100}%` } as React.CSSProperties}
      />
      <div className="gap-axis"><span>−15%</span><span>0</span><span>+5%</span></div>
      <div className="gap-presets">
        {presets.map((gap) => (
          <button key={gap.gapPct} className={gapPct === gap.gapPct ? "active" : ""} onClick={() => setGapPct(gap.gapPct)}>
            <small>{gap.gapPct}% OPEN</small>
            <strong>{money(gap.pnlUsd)}</strong>
            <span>{gap.projectedBufferPct.toFixed(1)}% buffer</span>
          </button>
        ))}
      </div>
      <label className="collateral-toggle">
        <span><CircleDollarSign size={18} /><span><strong>rToken backs margin</strong><small>Include collateral cascade risk</small></span></span>
        <input
          type="checkbox"
          checked={account.usesRTokenAsCollateral}
          onChange={(event) => setAccount({ ...account, usesRTokenAsCollateral: event.target.checked })}
        />
        <i />
      </label>
    </article>
  );
}

function PolicyPanel({
  policy,
  setPolicy,
  account,
  setAccount,
}: {
  policy: TradingPolicy;
  setPolicy: (policy: TradingPolicy) => void;
  account: AccountContext;
  setAccount: (account: AccountContext) => void;
}) {
  const sliders: Array<{
    label: string;
    key: keyof TradingPolicy;
    suffix: string;
    min: number;
    max: number;
    step: number;
  }> = [
    { label: "Max paper order", key: "maxPaperOrderUsd", suffix: "$", min: 25, max: 250, step: 25 },
    { label: "Extended size", key: "extendedSizePct", suffix: "%", min: 0, max: 25, step: 5 },
    { label: "Earnings size", key: "earningsSizePct", suffix: "%", min: 0, max: 10, step: 1 },
    { label: "Maximum basis", key: "maxBasisBps", suffix: " bps", min: 20, max: 250, step: 10 },
  ];
  return (
    <article className="policy-card" id="policy">
      <div className="card-title-row">
        <div><span className="card-kicker">HARD BOUNDARIES</span><h3>Permission policy</h3></div>
        <Settings2 size={20} />
      </div>
      <p>These values go to deterministic code—not the model prompt.</p>
      <div className="policy-sliders">
        {sliders.map((slider) => {
          const value = policy[slider.key];
          return (
            <label key={slider.key}>
              <span>{slider.label}<strong>{slider.suffix === "$" ? `$${value}` : `${value}${slider.suffix}`}</strong></span>
              <input
                type="range"
                min={slider.min}
                max={slider.max}
                step={slider.step}
                value={value}
                onChange={(event) => setPolicy({ ...policy, [slider.key]: Number(event.target.value) })}
              />
            </label>
          );
        })}
      </div>
      <div className="account-fields">
        <label>Position USD<input type="number" min="0" value={account.currentPositionUsd} onChange={(event) => setAccount({ ...account, currentPositionUsd: Number(event.target.value) })} /></label>
        <label>Equity USD<input type="number" min="100" value={account.accountEquityUsd} onChange={(event) => setAccount({ ...account, accountEquityUsd: Number(event.target.value) })} /></label>
        <label>Buffer %<input type="number" min="0" max="100" value={account.collateralBufferPct} onChange={(event) => setAccount({ ...account, collateralBufferPct: Number(event.target.value) })} /></label>
      </div>
      <button className="text-button" onClick={() => { setPolicy(defaultPolicy); setAccount(defaultAccount); }}>
        <TimerReset size={15} /> Restore safe defaults
      </button>
    </article>
  );
}

function ReceiptRow({ receipt, onOpen }: { receipt: DecisionReceipt; onOpen: () => void }) {
  const decision = receipt.decision;
  return (
    <button className="receipt-row" onClick={onOpen}>
      <span className={`receipt-verdict verdict-${decision.verdict.toLowerCase()}`}>
        {decision.verdict === "BLOCK" ? <Ban size={16} /> : decision.verdict === "ALERT" ? <AlertTriangle size={16} /> : <Check size={16} />}
      </span>
      <span className="receipt-symbol"><strong>{decision.snapshot.displaySymbol}</strong><small>{decision.snapshot.session.replace("_", " ")}</small></span>
      <span className="receipt-basis"><small>BASIS</small><strong>{decision.snapshot.basisBps === null ? "—" : signed(decision.snapshot.basisBps, " bps")}</strong></span>
      <span className="receipt-rule"><small>RULE</small><strong>{decision.ruleCodes[0]}</strong></span>
      <span className="receipt-time">{timeLabel(decision.createdAt)}</span>
      <ArrowRight size={16} />
    </button>
  );
}

function ReceiptDrawer({ receipt, onClose }: { receipt: DecisionReceipt; onClose: () => void }) {
  return (
    <motion.aside
      className="receipt-drawer"
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 220, damping: 28 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="receipt-title"
    >
      <div className="drawer-head">
        <div><span className="card-kicker">IMMUTABLE RECEIPT</span><h2 id="receipt-title">Decision detail</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close decision detail"><X /></button>
      </div>
      <div className={`drawer-verdict verdict-${receipt.decision.verdict.toLowerCase()}`}>
        <span>{receipt.decision.verdict}</span>
        <strong>{money(receipt.decision.allowedNotionalUsd)} allowed</strong>
      </div>
      <dl className="receipt-definition">
        <div><dt>Decision ID</dt><dd>{receipt.decision.id}</dd></div>
        <div><dt>Asset</dt><dd>{receipt.decision.snapshot.displaySymbol} · {receipt.decision.snapshot.companyName}</dd></div>
        <div><dt>Session</dt><dd>{receipt.decision.snapshot.session}</dd></div>
        <div><dt>rToken quote</dt><dd>{money(receipt.decision.snapshot.rTokenPrice)}</dd></div>
        <div><dt>Cash-aligned reference</dt><dd>{receipt.decision.snapshot.alignedReference ? money(receipt.decision.snapshot.alignedReference) : "Unavailable"}</dd></div>
        <div><dt>Order status</dt><dd>{receipt.order?.status ?? "NOT SENT"}</dd></div>
      </dl>
      <h3>Rules that won</h3>
      <ul className="drawer-rules">
        {receipt.decision.ruleCodes.map((code, index) => (
          <li key={`${code}-${index}`}><span>{index + 1}</span><div><strong>{code}</strong><p>{receipt.decision.reasons[index] ?? "Policy applied."}</p></div></li>
        ))}
      </ul>
      <div className="drawer-event"><FileCheck2 size={18} /><div><small>EVENT</small><strong>{receipt.event.headline}</strong></div></div>
      <a className="button button-ink button-full" href="/api/decisions/export?format=json" download>
        <Download size={16} /> Export full audit JSON
      </a>
    </motion.aside>
  );
}

function ConnectModal({
  connected,
  executionEnabled,
  busy,
  error,
  onClose,
  onConnect,
  onDisconnect,
}: {
  connected: boolean;
  executionEnabled: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConnect: (credentials: { apiKey: string; secretKey: string; passphrase: string }) => void;
  onDisconnect: () => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onConnect({
      apiKey: String(values.get("apiKey")),
      secretKey: String(values.get("secretKey")),
      passphrase: String(values.get("passphrase")),
    });
  };
  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
      <motion.div className="connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" aria-describedby="connect-description" initial={{ y: 32, scale: 0.96 }} animate={{ y: 0, scale: 1 }} exit={{ y: 30, opacity: 0 }} onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close demo connection"><X /></button>
        <div className="modal-icon"><KeyRound /></div>
        <span className="card-kicker">PAPER ENVIRONMENT ONLY</span>
        <h2 id="connect-title">Connect Bitget Demo</h2>
        <p id="connect-description">Credentials are encrypted in server memory, tied to this browser session, and expire after 30 minutes. They are never written to the database.</p>
        {connected ? (
          <div className="connected-state">
            {executionEnabled ? <BadgeCheck size={30} /> : <AlertTriangle size={30} />}
            <div>
              <strong>{executionEnabled ? "rToken demo execution enabled" : "Demo connected · rToken unavailable"}</strong>
              <small>{executionEnabled
                ? "Only paper orders are available."
                : "Authenticated execution stays disabled; official SDK replays still work."}</small>
            </div>
            <button className="button button-outline" onClick={onDisconnect} disabled={busy}><Unplug size={16} /> Disconnect</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label>Demo API key<input data-dialog-initial-focus name="apiKey" type="password" autoComplete="off" minLength={8} required placeholder="••••••••••••" /></label>
            <label>Demo secret key<input name="secretKey" type="password" autoComplete="off" minLength={8} required placeholder="••••••••••••" /></label>
            <label>Demo passphrase<input name="passphrase" type="password" autoComplete="off" required placeholder="••••••••" /></label>
            {error && <div className="form-error"><AlertTriangle size={15} /> {error}</div>}
            <button className="button button-coral button-full" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />} Verify demo account
            </button>
          </form>
        )}
        <small className="modal-footnote"><ShieldCheck size={13} /> SessionGuard has no production-money order route.</small>
      </motion.div>
    </motion.div>
  );
}

export function DashboardPage() {
  const [searchParams] = useSearchParams();
  const requestedReplay = searchParams.get("replay");
  const initialReplay = bundledReplays.find((item) => item.id === requestedReplay) ?? bundledReplays[0];
  const [mode, setModeState] = useState<DeskMode>("replay");
  const [scenarios, setScenarios] = useState<ReplayScenario[]>(bundledReplays);
  const [scenarioId, setScenarioId] = useState(initialReplay.id);
  const [symbol, setSymbol] = useState<SupportedSymbol>(initialReplay.snapshot.symbol);
  const [snapshot, setSnapshot] = useState<MarketSnapshot>(initialReplay.snapshot);
  const [event, setEvent] = useState<MarketEvent>(initialReplay.event);
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [receipt, setReceipt] = useState<DecisionReceipt | null>(null);
  const [receipts, setReceipts] = useState<DecisionReceipt[]>([]);
  const [phase, setPhase] = useState<GatePhase>("idle");
  const [running, setRunning] = useState(false);
  const [loadingLive, setLoadingLive] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(false);
  const [executionEnabled, setExecutionEnabled] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [policy, setPolicy] = useState<TradingPolicy>(defaultPolicy);
  const [account, setAccount] = useState<AccountContext>(initialReplay.intent.account ?? defaultAccount);
  const [notional, setNotional] = useState(initialReplay.intent.notionalUsd);
  const [side, setSide] = useState<"buy" | "sell">(initialReplay.intent.side);
  const [filter, setFilter] = useState<"ALL" | Verdict>("ALL");
  const [detailReceipt, setDetailReceipt] = useState<DecisionReceipt | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  useEffect(() => {
    if (!showConnect && !detailReceipt) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
      const initial = dialog?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
        ?? dialog?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]');
      initial?.focus();
    });
    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
      if (!dialog) return;
      if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        setShowConnect(false);
        setDetailReceipt(null);
        return;
      }
      if (keyboardEvent.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (keyboardEvent.shiftKey && document.activeElement === first) {
        keyboardEvent.preventDefault();
        last?.focus();
      } else if (!keyboardEvent.shiftKey && document.activeElement === last) {
        keyboardEvent.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [detailReceipt, showConnect]);


  const scenario = useMemo(
    () => scenarios.find((item) => item.id === scenarioId) ?? scenarios[0] ?? null,
    [scenarioId, scenarios],
  );
  const preview = mode === "replay" && scenario
    ? replayPreview[scenario.id] ?? { verdict: "BLOCK" as Verdict, reason: "Run the gate to calculate permission." }
    : { verdict: "BLOCK" as Verdict, reason: "Live decisions fail closed until every input is verified." };
  const marketSession = sessionCopy(snapshot.session);
  const filteredReceipts = receipts.filter((item) => filter === "ALL" || item.decision.verdict === filter);

  const refreshReceipts = useCallback(async () => {
    try {
      const result = await api.decisions();
      setReceipts(result.receipts);
    } catch {
      // The replay remains fully usable if historical persistence is temporarily unavailable.
    }
  }, []);

  useEffect(() => {
    Promise.allSettled([api.replays(), api.session(), api.decisions()]).then(([replayResult, sessionResult, decisionsResult]) => {
      if (replayResult.status === "fulfilled") setScenarios(replayResult.value.scenarios);
      if (sessionResult.status === "fulfilled") {
        setConnected(sessionResult.value.connected);
        setExecutionEnabled(sessionResult.value.executionEnabled);
      }
      if (decisionsResult.status === "fulfilled") setReceipts(decisionsResult.value.receipts);
    });
  }, []);

  const loadLive = useCallback(async (nextSymbol: SupportedSymbol, refreshEvents = false) => {
    setLoadingLive(true);
    setError("");
    try {
      const [marketResult, eventResult] = await Promise.all([
        api.snapshot(nextSymbol),
        api.events(refreshEvents),
      ]);
      setSnapshot(marketResult.snapshot);
      setEvents(eventResult.events);
      const matching = eventResult.events.find((item) => item.symbol === nextSymbol);
      if (matching) setEvent(matching);
      else setError(`No official ${symbolLabels[nextSymbol].company} event has been ingested yet. Live evaluation stays locked.`);
    } catch (caught) {
      setError(`${caught instanceof Error ? caught.message : "Live sources are unavailable."} Replay data has not replaced the live label.`);
    } finally {
      setLoadingLive(false);
    }
  }, []);

  useEffect(() => {
    if (mode !== "live") return;
    void loadLive(symbol);
    const timer = window.setInterval(() => void loadLive(symbol), 15_000);
    return () => window.clearInterval(timer);
  }, [loadLive, mode, symbol]);

  const selectScenario = (next: ReplayScenario) => {
    setScenarioId(next.id);
    setSymbol(next.snapshot.symbol);
    setSnapshot(next.snapshot);
    setEvent(next.event);
    setAccount(next.intent.account ?? defaultAccount);
    setNotional(next.intent.notionalUsd);
    setSide(next.intent.side);
    setReceipt(null);
    setPhase("idle");
    setError("");
  };

  const setMode = (next: DeskMode) => {
    setModeState(next);
    setReceipt(null);
    setPhase("idle");
    setError("");
    if (next === "replay" && scenario) selectScenario(scenario);
  };

  const selectSymbol = (next: SupportedSymbol) => {
    setSymbol(next);
    setReceipt(null);
    setPhase("idle");
    if (mode === "replay") {
      const matching = scenarios.find((item) => item.snapshot.symbol === next);
      if (matching) selectScenario(matching);
    }
  };
  const handleAssetKeyDown = (
    keyboardEvent: React.KeyboardEvent<HTMLButtonElement>,
    current: SupportedSymbol,
  ) => {
    const navigationKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
    if (!navigationKeys.has(keyboardEvent.key)) return;
    keyboardEvent.preventDefault();
    const assets = Object.keys(symbolLabels) as SupportedSymbol[];
    const currentIndex = assets.indexOf(current);
    let nextIndex = currentIndex;
    if (keyboardEvent.key === "Home") nextIndex = 0;
    else if (keyboardEvent.key === "End") nextIndex = assets.length - 1;
    else if (keyboardEvent.key === "ArrowRight" || keyboardEvent.key === "ArrowDown") nextIndex = (currentIndex + 1) % assets.length;
    else nextIndex = (currentIndex - 1 + assets.length) % assets.length;
    const next = assets[nextIndex];
    selectSymbol(next);
    window.requestAnimationFrame(() => document.getElementById(`asset-tab-${next}`)?.focus());
  };


  const runGate = async () => {
    if (running) return;
    if (mode === "live" && (!event || event.symbol !== symbol)) {
      setError("A matching verified official event is required. Refresh the live feed or use a deterministic replay.");
      return;
    }
    setRunning(true);
    setError("");
    setNotice("");
    setReceipt(null);
    setPhase("event");
    const timers = [
      window.setTimeout(() => setPhase("agent"), 520),
      window.setTimeout(() => setPhase("rules"), 1050),
    ];
    try {
      const result = await api.evaluate({
        symbol,
        side,
        notionalUsd: Math.min(250, Math.max(1, notional)),
        eventId: event.id,
        mode,
        policy,
        account,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 1450));
      setReceipt(result.receipt);
      setPhase("complete");
      setNotice(result.receipt.decision.verdict === "BLOCK" ? "Exposure intercepted and logged." : "Permission receipt created.");
      await refreshReceipts();
    } catch (caught) {
      setPhase("idle");
      setError(caught instanceof Error ? caught.message : "The permission gate could not complete.");
    } finally {
      timers.forEach(window.clearTimeout);
      setRunning(false);
    }
  };

  const execute = async () => {
    const token = receipt?.decision.decisionToken;
    if (!token) return;
    if (mode === "live" && !connected) {
      setShowConnect(true);
      return;
    }
    setRunning(true);
    setError("");
    try {
      const result = await api.order(token);
      setReceipt(result.receipt);
      setNotice(result.receipt.order?.message ?? "Paper order recorded.");
      await refreshReceipts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Paper order could not be submitted.");
    } finally {
      setRunning(false);
    }
  };

  const connect = async (credentials: { apiKey: string; secretKey: string; passphrase: string }) => {
    setConnectBusy(true);
    setConnectError("");
    try {
      const result = await api.connect(credentials);
      setConnected(true);
      setExecutionEnabled(result.executionEnabled);
      setNotice(result.executionEnabled
        ? "Bitget Demo connected. rToken paper execution is enabled for this session."
        : "Demo connected, but rToken spot is unavailable there. Authenticated execution remains disabled.");
    } catch (caught) {
      setConnectError(caught instanceof Error ? caught.message : "Demo connection failed.");
    } finally {
      setConnectBusy(false);
    }
  };

  const disconnect = async () => {
    setConnectBusy(true);
    try {
      await api.disconnect();
      setConnected(false);
      setExecutionEnabled(false);
      setShowConnect(false);
      setNotice("Demo credentials removed from server memory.");
    } finally {
      setConnectBusy(false);
    }
  };

  return (
    <motion.div className="dashboard-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="paper-grain" />
      <AppNav connected={connected} onConnect={() => setShowConnect(true)} onNotifications={() => setNotice("Alerts are shown in-app for this hackathon build; Telegram delivery is an optional extension.")} />

      <main className="dashboard-shell" id="top">
        <section className="desk-heading">
          <div>
            <div className="eyebrow"><ShieldCheck size={15} /> Agentic trading control room</div>
            <h1>Permission desk</h1>
            <p>See the session. Stress the exposure. Then—and only then—authorize a paper order.</p>
          </div>
          <div className="desk-heading-actions">
            <ModeSwitch mode={mode} setMode={setMode} />
            <button className="icon-button mobile-menu" aria-label="Open policy" aria-expanded={policyOpen} aria-controls="policy-panel" onClick={() => setPolicyOpen((value) => !value)}><Menu /></button>
          </div>
        </section>

        <section className="desk-toolbar" aria-label="Market controls">
          <div className="asset-tabs" role="tablist" aria-label="rToken asset">
            {(Object.keys(symbolLabels) as SupportedSymbol[]).map((item) => (
              <button key={item} id={`asset-tab-${item}`} role="tab" aria-controls="market-panel" aria-selected={symbol === item} tabIndex={symbol === item ? 0 : -1} className={symbol === item ? "active" : ""} onClick={() => selectSymbol(item)} onKeyDown={(keyboardEvent) => handleAssetKeyDown(keyboardEvent, item)}>
                <span>{symbolLabels[item].accent}</span>
                <span><strong>{symbolLabels[item].ticker}</strong><small>{symbolLabels[item].company}</small></span>
              </button>
            ))}
          </div>
          {mode === "replay" ? (
            <label className="scenario-select">
              <span>Scenario</span>
              <select value={scenarioId} onChange={(event) => { const next = scenarios.find((item) => item.id === event.target.value); if (next) selectScenario(next); }}>
                {scenarios.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
              </select>
              <ChevronDown size={16} />
            </label>
          ) : (
            <button className="refresh-button" onClick={() => void loadLive(symbol, true)} disabled={loadingLive}>
              <RefreshCw size={15} className={loadingLive ? "spin" : ""} /> Refresh sources
            </button>
          )}
        </section>

        <AnimatePresence>
          {(error || notice) && (
            <motion.div role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} className={`desk-message ${error ? "is-error" : "is-notice"}`} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              {error ? <CloudOff size={18} /> : <BadgeCheck size={18} />}
              <span>{error || notice}</span>
              {error && mode === "live" && <button onClick={() => setMode("replay")}>Open replay <ArrowRight size={14} /></button>}
              <button className="message-close" aria-label="Dismiss message" onClick={() => { setError(""); setNotice(""); }}><X size={15} /></button>
            </motion.div>
          )}
        </AnimatePresence>

        <section className="market-overview" id="market-panel" role="tabpanel" aria-labelledby={`asset-tab-${symbol}`}>
          <div className="market-main-card">
            <div className="market-main-head">
              <div className="asset-title">
                <span className="asset-monogram">{symbolLabels[symbol].accent}</span>
                <div><span>{symbolLabels[symbol].company} rToken</span><h2>{snapshot.displaySymbol} <small>/ USDT</small></h2></div>
              </div>
              <div className={`session-badge tone-${marketSession.tone}`}><span /><div><small>SESSION</small><strong>{marketSession.short}</strong></div></div>
            </div>
            <div className="market-price-line">
              <div><strong>{money(snapshot.rTokenPrice)}</strong><span className={(snapshot.basisBps ?? 0) >= 0 ? "positive" : "negative"}>{snapshot.basisBps === null ? "reference missing" : signed(snapshot.basisBps / 100, "% vs reference")}</span></div>
              <span><small>QUOTE UPDATED</small>{mode === "replay" ? timeLabel(snapshot.quoteTime) : compactTime(snapshot.quoteTime)}</span>
            </div>
            <MarketChart snapshot={snapshot} />
            <div className="chart-legend">
              <span><i className="legend-token" /> rToken price</span>
              <span><i className="legend-reference" /> Last cash-aligned reference</span>
              <span className="source-mode"><i /> {mode === "live" ? "BITGET LIVE" : "DETERMINISTIC REPLAY"}</span>
            </div>
          </div>
          <div className="guardian-desk-card">
            <div className="guardian-desk-copy">
              <span className="card-kicker">SESSION GUARDIAN</span>
              <h3>{marketSession.label}</h3>
              <p>{snapshot.session === "CASH_OPEN" ? "Native US price discovery is active. Policy still controls size." : "The wrapper can trade, but the underlying venue is not providing a live anchor."}</p>
            </div>
            <GuardianScene verdict={receipt?.decision.verdict ?? preview.verdict} compact />
          </div>
        </section>

        <section className="metric-grid">
          <MetricCard label="rToken quote" value={money(snapshot.rTokenPrice)} note={`Bid ${money(snapshot.bid)} · Ask ${money(snapshot.ask)}`} icon={<Activity size={18} />} />
          <MetricCard label="Cash-aligned reference" value={snapshot.alignedReference ? money(snapshot.alignedReference) : "Unavailable"} note={snapshot.referenceTime ? timeLabel(snapshot.referenceTime) : "Fail-closed input"} icon={<Clock3 size={18} />} tone={!snapshot.alignedReference ? "metric-danger" : ""} />
          <MetricCard label="Current basis" value={snapshot.basisBps === null ? "—" : signed(snapshot.basisBps, " bps")} note={`${snapshot.spreadBps.toFixed(1)} bps spread`} icon={(snapshot.basisBps ?? 0) >= 0 ? <TrendingUp size={18} /> : <TrendingDown size={18} />} tone={Math.abs(snapshot.basisBps ?? 0) > policy.maxBasisBps ? "metric-warning" : ""} />
          <MetricCard label="Next cash open" value={new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(snapshot.nextCashOpen))} note="America / New York" icon={<MoonStar size={18} />} />
        </section>

        <section className="decision-workbench">
          <div className="workbench-left">
            <EventCard event={event} live={mode === "live"} />
            <AssessmentCard receipt={receipt} scenario={mode === "replay" ? scenario : null} />
            <GapSimulator receipt={receipt} account={account} setAccount={setAccount} />
          </div>
          <div className="workbench-right">
            <div className="intent-card">
              <div className="card-title-row"><div><span className="card-kicker">PAPER INTENT</span><h3>Proposed order</h3></div><Pill>MAX $250</Pill></div>
              <div className="side-switch" role="group" aria-label="Order side">
                <button aria-pressed={side === "buy"} className={side === "buy" ? "active buy" : ""} onClick={() => setSide("buy")}>Buy / increase</button>
                <button aria-pressed={side === "sell"} className={side === "sell" ? "active sell" : ""} onClick={() => setSide("sell")}>Sell / reduce</button>
              </div>
              <label className="notional-input"><span>Notional</span><span><i>$</i><input aria-label="Paper order notional" type="number" min="1" max="250" value={notional} onChange={(event) => setNotional(Number(event.target.value))} /><small>USD</small></span></label>
              <div className="intent-summary"><span>Instrument<strong>{snapshot.displaySymbol}/USDT</strong></span><span>Environment<strong>{mode === "live" ? "Bitget Demo" : "Replay simulator"}</strong></span></div>
            </div>
            <PermissionPanel receipt={receipt} preview={preview} running={running} phase={phase} onRun={() => void runGate()} onExecute={() => void execute()} connected={connected} executionEnabled={executionEnabled} onNeedsConnect={() => setShowConnect(true)} mode={mode} />
            <div id="policy-panel" className={`desktop-policy ${policyOpen ? "show-mobile" : ""}`}><PolicyPanel policy={policy} setPolicy={setPolicy} account={account} setAccount={setAccount} /></div>
          </div>
        </section>

        <section className="decisions-section" id="decisions">
          <div className="decisions-head">
            <div><span className="section-index">AUDIT TRAIL</span><h2>Every decision leaves a receipt.</h2><p>Blocked ideas are evidence of risk avoided—not missing trades.</p></div>
            <div className="decision-actions">
              <div className="filter-group" role="group" aria-label="Filter decisions"><Filter aria-hidden="true" size={14} />{(["ALL", "BLOCK", "ALERT", "TRADE"] as const).map((item) => <button aria-pressed={filter === item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item}</button>)}</div>
              <div className="export-group">
                <a href="/api/decisions/export?format=csv" download><Download size={15} /> CSV</a>
                <a href="/api/decisions/export?format=json" download><Download size={15} /> JSON</a>
              </div>
            </div>
          </div>
          <div className="receipts-table">
            <div className="receipt-table-head"><span>STATE</span><span>ASSET / SESSION</span><span>BASIS</span><span>PRIMARY RULE</span><span>TIME</span><span /></div>
            {filteredReceipts.length ? filteredReceipts.slice(0, 10).map((item) => <ReceiptRow key={item.decision.id} receipt={item} onOpen={() => setDetailReceipt(item)} />) : (
              <div className="empty-receipts"><FileCheck2 size={28} /><strong>No matching receipts yet.</strong><span>Run the permission gate; its result will appear here.</span></div>
            )}
          </div>
        </section>

        <section className="safety-strip">
          <ShieldCheck size={28} />
          <div><strong>Built to refuse.</strong><span>Official inputs · deterministic permission · short-lived token · paper-only execution</span></div>
          <Pill tone="good"><span className="live-dot" /> NO LIVE MONEY PATH</Pill>
        </section>
      </main>

      <nav className="mobile-bottom-nav" aria-label="Mobile app navigation">
        <a href="#top"><Activity /><span>Desk</span></a>
        <a href="#decisions"><FileCheck2 /><span>Receipts</span></a>
        <button onClick={() => setPolicyOpen((value) => !value)}><SlidersHorizontal /><span>Policy</span></button>
        <button onClick={() => setShowConnect(true)}><KeyRound /><span>Demo</span></button>
      </nav>

      <AnimatePresence>{showConnect && <ConnectModal connected={connected} executionEnabled={executionEnabled} busy={connectBusy} error={connectError} onClose={() => setShowConnect(false)} onConnect={(credentials) => void connect(credentials)} onDisconnect={() => void disconnect()} />}</AnimatePresence>
      <AnimatePresence>{detailReceipt && <><motion.div className="drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDetailReceipt(null)} /><ReceiptDrawer receipt={detailReceipt} onClose={() => setDetailReceipt(null)} /></>}</AnimatePresence>
    </motion.div>
  );
}
