import { motion } from "framer-motion";
import type { MarketSnapshot } from "../../shared/types";

function chartGeometry(snapshot: MarketSnapshot) {
  const values = snapshot.chart.map((point) => point.price);
  if (snapshot.alignedReference) values.push(snapshot.alignedReference);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const x = (index: number) => 24 + (index / Math.max(1, snapshot.chart.length - 1)) * 552;
  const y = (price: number) => 176 - ((price - min) / range) * 128;
  const path = snapshot.chart
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.price).toFixed(1)}`)
    .join(" ");
  return { path, y, min, max };
}

export function MarketChart({ snapshot }: { snapshot: MarketSnapshot }) {
  const { path, y, min, max } = chartGeometry(snapshot);
  const referenceY = snapshot.alignedReference ? y(snapshot.alignedReference) : null;
  const chartLabel = `${snapshot.displaySymbol} price chart with cash-aligned reference`;
  return (
    <div className="market-chart">
      <svg viewBox="0 0 600 210" role="img" aria-label={chartLabel}>
        <title>{chartLabel}</title>
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f06a4f" stopOpacity=".3" />
            <stop offset="1" stopColor="#f06a4f" stopOpacity="0" />
          </linearGradient>
          <filter id="softGlow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {[48, 91, 134, 177].map((line) => (
          <line key={line} x1="24" x2="576" y1={line} y2={line} className="chart-gridline" />
        ))}
        {referenceY !== null && (
          <g>
            <motion.line
              x1="24"
              x2="576"
              y1={referenceY}
              y2={referenceY}
              className="reference-line"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.8 }}
            />
            <text x="28" y={referenceY - 8} className="reference-label">CASH-ALIGNED CLOSE</text>
          </g>
        )}
        <motion.path
          d={`${path} L576,194 L24,194 Z`}
          fill="url(#chartFill)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.6 }}
        />
        <motion.path
          key={path}
          d={path}
          fill="none"
          className="price-line"
          filter="url(#softGlow)"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.2, ease: "easeOut" }}
        />
        <motion.circle
          cx="576"
          cy={y(snapshot.rTokenPrice)}
          r="5"
          className="price-dot"
          animate={{ r: [5, 8, 5] }}
          transition={{ repeat: Infinity, duration: 1.8 }}
        />
        <text x="24" y="205" className="chart-axis">{min.toFixed(2)}</text>
        <text x="538" y="205" className="chart-axis">{max.toFixed(2)}</text>
      </svg>
    </div>
  );
}

