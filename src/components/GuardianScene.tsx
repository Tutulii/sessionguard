import { motion } from "framer-motion";
import type { Verdict } from "../../shared/types";

export function GuardianScene({ verdict = "BLOCK", compact = false }: { verdict?: Verdict; compact?: boolean }) {
  const open = verdict === "TRADE";
  const alert = verdict === "ALERT";
  return (
    <div className={`guardian-scene verdict-${verdict.toLowerCase()} ${compact ? "is-compact" : ""}`}>
      <svg viewBox="0 0 680 440" role="img" aria-label={`SessionGuard market gate: ${verdict}`}>
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#183d38" />
            <stop offset="1" stopColor="#28534c" />
          </linearGradient>
          <pattern id="windows" width="22" height="24" patternUnits="userSpaceOnUse">
            <rect x="5" y="5" width="6" height="8" rx="2" fill="#f4c85f" opacity=".7" />
          </pattern>
        </defs>
        <rect x="4" y="4" width="672" height="432" rx="34" fill="url(#sky)" stroke="#102d29" strokeWidth="8" />
        <motion.circle
          cx="540"
          cy="88"
          r="47"
          fill="#f7d775"
          animate={{ opacity: [0.85, 1, 0.85], scale: [1, 1.04, 1] }}
          transition={{ repeat: Infinity, duration: 4 }}
        />
        <circle cx="524" cy="76" r="8" fill="#d5b757" opacity=".5" />
        <circle cx="555" cy="99" r="5" fill="#d5b757" opacity=".45" />
        {[80, 160, 250, 420, 610].map((x, index) => (
          <motion.circle
            key={x}
            cx={x}
            cy={55 + (index % 3) * 34}
            r={2.5 + (index % 2)}
            fill="#f4eddf"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ repeat: Infinity, duration: 2 + index * 0.35, delay: index * 0.2 }}
          />
        ))}
        <motion.g animate={{ x: [0, 34, 0] }} transition={{ repeat: Infinity, duration: 11, ease: "easeInOut" }}>
          <path d="M62 115c10-20 45-19 52 3 17-7 35 4 38 20H43c2-13 8-20 19-23Z" fill="#e9e1d4" opacity=".2" />
        </motion.g>
        <path d="M0 315 85 261l66 34 82-82 92 77 84-120 92 105 79-49 100 74v136H0V315Z" fill="#102f2b" />
        <path d="M0 329 85 275l66 35 82-82 92 78 84-121 92 106 79-49 100 74v120H0V329Z" fill="url(#windows)" opacity=".95" />
        <path d="M0 365h680v71H0z" fill="#eadfce" />
        <path d="M0 382h680" stroke="#c7bcae" strokeWidth="4" strokeDasharray="22 16" />

        <motion.g
          className="gate-arm-group"
          style={{ originX: "278px", originY: "315px" }}
          animate={{ rotate: open ? -68 : alert ? -24 : 0 }}
          transition={{ type: "spring", stiffness: 95, damping: 13 }}
        >
          <rect x="264" y="296" width="294" height="34" rx="15" fill="#f4eddf" stroke="#102d29" strokeWidth="7" />
          {[292, 356, 420, 484].map((x) => (
            <path key={x} d={`M${x} 299l30 28`} stroke="#ef654b" strokeWidth="17" />
          ))}
          <motion.g
            animate={{ rotate: open ? 68 : alert ? 24 : 0, opacity: open ? 0 : 1 }}
            initial={{ rotate: open ? 68 : alert ? 24 : 0, opacity: open ? 0 : 1 }}
            style={{ originX: "548px", originY: "313px" }}
          >
            <path d="m548 274 28 11 11 28-11 28-28 11-28-11-11-28 11-28 28-11Z" fill={alert ? "#f4c85f" : "#ef654b"} stroke="#102d29" strokeWidth="7" />
            <text x="548" y="320" textAnchor="middle" className="gate-sign-text">{alert ? "WAIT" : "STOP"}</text>
          </motion.g>
        </motion.g>
        <rect x="244" y="300" width="66" height="134" rx="18" fill="#f4c85f" stroke="#102d29" strokeWidth="8" />
        <motion.circle
          cx="277"
          cy="319"
          r="12"
          fill={open ? "#78b79c" : alert ? "#f4c85f" : "#ef654b"}
          stroke="#102d29"
          strokeWidth="5"
          animate={{ opacity: [1, 0.45, 1] }}
          transition={{ repeat: Infinity, duration: 1.4 }}
        />

        <motion.g
          className="guardian-character"
          animate={{ y: [0, -5, 0] }}
          transition={{ repeat: Infinity, duration: 3.4, ease: "easeInOut" }}
        >
          <ellipse cx="146" cy="407" rx="76" ry="15" fill="#102d29" opacity=".18" />
          <path d="M100 255c4-39 24-62 55-62 32 0 52 23 57 62l12 109H88l12-109Z" fill="#f06a4f" stroke="#102d29" strokeWidth="8" />
          <path d="M129 200c0-26 13-46 39-46s42 20 42 46v32c0 28-18 49-42 49s-39-21-39-49v-32Z" fill="#d59a76" stroke="#102d29" strokeWidth="8" />
          <path d="M126 203c3-38 22-61 48-61 28 0 45 23 43 58-19-4-30-13-39-27-9 17-26 27-52 30Z" fill="#142f2b" />
          <circle cx="153" cy="215" r="4" fill="#102d29" />
          <circle cx="190" cy="215" r="4" fill="#102d29" />
          <path d="M163 242c10 6 19 5 26-1" fill="none" stroke="#102d29" strokeWidth="4" strokeLinecap="round" />
          <path d="m152 280 17 22 17-22 20 80h-75l21-80Z" fill="#f4eddf" stroke="#102d29" strokeWidth="6" />
          <path d="m169 302-9 30 9 18 10-18-10-30Z" fill="#f4c85f" stroke="#102d29" strokeWidth="4" />
          <motion.path
            d="M208 292c30-4 45 3 58 23"
            fill="none"
            stroke="#d59a76"
            strokeWidth="18"
            strokeLinecap="round"
            animate={{ rotate: open ? -22 : 0 }}
            style={{ originX: "208px", originY: "292px" }}
          />
          <circle cx="269" cy="316" r="12" fill="#d59a76" stroke="#102d29" strokeWidth="5" />
          <path d="M111 360v55M195 360v55" stroke="#102d29" strokeWidth="18" strokeLinecap="round" />
          <path d="M83 419h55M172 419h54" stroke="#102d29" strokeWidth="17" strokeLinecap="round" />
        </motion.g>
        <motion.g
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <rect x="328" y="32" width="166" height="57" rx="20" fill="#f4eddf" stroke="#102d29" strokeWidth="6" />
          <text x="350" y="56" className="scene-bubble-label">US CASH MARKET</text>
          <text x="350" y="76" className="scene-bubble-value">{open ? "OPEN" : "CLOSED"}</text>
        </motion.g>
      </svg>
      <motion.div
        className="scene-verdict"
        key={verdict}
        initial={{ scale: 0.8, rotate: -4, opacity: 0 }}
        animate={{ scale: 1, rotate: -2, opacity: 1 }}
        transition={{ type: "spring", stiffness: 220, damping: 16 }}
      >
        <small>Permission</small>
        <strong>{verdict}</strong>
      </motion.div>
    </div>
  );
}
