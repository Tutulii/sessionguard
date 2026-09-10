import { motion } from "framer-motion";
import { Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import type { ProductionMarketSnapshot } from "../../shared/production-types";

export type ReplayScenarioSummary = {
  name: string;
  kicker: string;
  description: string;
};

function boundedFrame(snapshot: ProductionMarketSnapshot, frameIndex: number) {
  return Math.max(0, Math.min(frameIndex, Math.max(0, snapshot.chart.length - 1)));
}

export function deriveReplayFrame(snapshot: ProductionMarketSnapshot, frameIndex: number): ProductionMarketSnapshot {
  if (snapshot.dataMode !== "REPLAY" || snapshot.chart.length === 0) return snapshot;
  const index = boundedFrame(snapshot, frameIndex);
  const point = snapshot.chart[index];
  const bidOffset = Math.max(0, snapshot.rTokenPriceMicros - snapshot.bidPriceMicros);
  const askOffset = Math.max(0, snapshot.askPriceMicros - snapshot.rTokenPriceMicros);
  const bidPriceMicros = Math.max(1, point.priceMicros - bidOffset);
  const askPriceMicros = Math.max(bidPriceMicros, point.priceMicros + askOffset);
  const midpoint = Math.max(1, (bidPriceMicros + askPriceMicros) / 2);
  const offHoursMoveBps = snapshot.anchorPriceMicros === null
    ? null
    : Math.round(((point.priceMicros / snapshot.anchorPriceMicros - 1) * 10_000) * 100) / 100;

  return {
    ...snapshot,
    rTokenPriceMicros: point.priceMicros,
    bidPriceMicros,
    askPriceMicros,
    spreadBps: Math.round((((askPriceMicros - bidPriceMicros) / midpoint) * 10_000) * 100) / 100,
    offHoursMoveBps,
    providerTimestamp: point.time,
  };
}

function clock(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(value));
}

function ProductionChart({ snapshot, frameIndex }: {
  snapshot: ProductionMarketSnapshot;
  frameIndex?: number;
}) {
  const width = 720;
  const height = 220;
  const pad = 16;
  const values = snapshot.chart.map((point) => point.priceMicros);
  const min = Math.min(...values, snapshot.anchorPriceMicros ?? Infinity);
  const max = Math.max(...values, snapshot.anchorPriceMicros ?? -Infinity);
  const range = Math.max(1, max - min);
  const xAt = (index: number) => pad + (index / Math.max(1, snapshot.chart.length - 1)) * (width - pad * 2);
  const yAt = (value: number) => height - pad - ((value - min) / range) * (height - pad * 2);
  const path = snapshot.chart.map((point, index) => `${index ? "L" : "M"}${xAt(index).toFixed(2)},${yAt(point.priceMicros).toFixed(2)}`).join(" ");
  const anchorY = snapshot.anchorPriceMicros === null ? null : yAt(snapshot.anchorPriceMicros);
  const activeIndex = frameIndex === undefined ? Math.max(0, snapshot.chart.length - 1) : boundedFrame(snapshot, frameIndex);
  const active = snapshot.chart[activeIndex];
  const activeX = xAt(activeIndex);
  const activeY = active ? yAt(active.priceMicros) : height / 2;
  const revealWidth = frameIndex === undefined ? width : Math.min(width, activeX + 5);

  return (
    <svg className="prod-chart" role="img" aria-label={`${snapshot.displaySymbol} Bitget rToken price chart${frameIndex === undefined ? "" : `, replay frame ${activeIndex + 1} of ${snapshot.chart.length}`}`} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id="prod-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ef735b" stopOpacity=".35"/><stop offset="1" stopColor="#ef735b" stopOpacity="0"/></linearGradient>
        <clipPath id="prod-chart-reveal"><motion.rect className="prod-chart-clip" x="0" y="0" height={height} animate={{ width: revealWidth }} initial={false} transition={{ duration: .42, ease: "easeOut" }}/></clipPath>
      </defs>
      {anchorY !== null && <line x1={pad} x2={width - pad} y1={anchorY} y2={anchorY} className="prod-anchor-line" />}
      <g clipPath="url(#prod-chart-reveal)">
        <path d={`${path} L${width - pad},${height - pad} L${pad},${height - pad} Z`} className="prod-chart-fill" />
        <path d={path} className="prod-chart-line" />
      </g>
      {frameIndex !== undefined && active && <>
        <motion.line className="prod-replay-cursor" x1={activeX} x2={activeX} y1={pad} y2={height - pad} animate={{ x1: activeX, x2: activeX }} initial={false}/>
        <motion.circle className="prod-replay-dot" r="7" animate={{ cx: activeX, cy: activeY }} initial={false} transition={{ duration: .42, ease: "easeOut" }}/>
      </>}
    </svg>
  );
}

export function ReplayMarketTimeline({
  snapshot,
  frameIndex,
  playing,
  scenario,
  onToggle,
  onReset,
  onSeek,
  onFinish,
}: {
  snapshot: ProductionMarketSnapshot;
  frameIndex?: number;
  playing: boolean;
  scenario?: ReplayScenarioSummary;
  onToggle: () => void;
  onReset: () => void;
  onSeek: (frame: number) => void;
  onFinish: () => void;
}) {
  const isReplay = snapshot.dataMode === "REPLAY" && frameIndex !== undefined;
  const lastFrame = Math.max(0, snapshot.chart.length - 1);
  const frame = boundedFrame(snapshot, frameIndex ?? lastFrame);
  const ready = frame >= lastFrame;
  const eventFrame = Math.max(1, Math.ceil(lastFrame * .66));
  const eventVisible = frame >= eventFrame;
  const activePoint = snapshot.chart[frame];

  return <>
    <ProductionChart snapshot={snapshot} frameIndex={isReplay ? frame : undefined}/>
    {isReplay && <section className="replay-player" aria-label="Scenario replay player">
      <div className="replay-player-head">
        <div>
          <span className={`replay-state ${ready ? "is-ready" : playing ? "is-playing" : "is-paused"}`}><i/>{ready ? "DECISION POINT READY" : playing ? "PLAYING RECORDED TICKS" : "REPLAY PAUSED"}</span>
          <strong>{scenario?.name ?? "Recorded scenario"}</strong>
        </div>
        <span className="replay-frame-count">FRAME {frame + 1} / {snapshot.chart.length}</span>
      </div>

      <input
        className="replay-scrubber"
        type="range"
        min="0"
        max={lastFrame}
        step="1"
        value={frame}
        aria-label="Replay timeline"
        aria-valuetext={`Frame ${frame + 1} of ${snapshot.chart.length}, ${activePoint ? clock(activePoint.time) : "time unavailable"}`}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      <div className="replay-time-row"><span>{snapshot.chart[0] ? clock(snapshot.chart[0].time) : "—"}</span><strong>{activePoint ? clock(activePoint.time) : "—"}</strong><span>{snapshot.chart[lastFrame] ? clock(snapshot.chart[lastFrame].time) : "—"}</span></div>

      <div className="replay-controls">
        <button type="button" onClick={onReset} aria-label="Reset replay"><RotateCcw/> Reset</button>
        <button type="button" className="replay-primary" onClick={onToggle} aria-label={playing ? "Pause replay" : "Play replay"}>{playing ? <Pause/> : <Play/>}{playing ? "Pause" : ready ? "Play again" : "Play replay"}</button>
        <button type="button" onClick={onFinish} aria-label="Jump to decision point"><SkipForward/> Decision point</button>
      </div>

      <div className={`replay-event ${eventVisible ? "is-visible" : ""}`} aria-live="polite">
        <span>{eventVisible ? "EVENT NOW IN CONTEXT" : "EVENT NOT REACHED"}</span>
        <p>{eventVisible ? scenario?.description : "Play the recorded Bitget ticks to reveal the event and unlock the guard at the final frame."}</p>
      </div>
    </section>}
  </>;
}
