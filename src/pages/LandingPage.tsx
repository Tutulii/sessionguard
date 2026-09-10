import { motion, useScroll, useTransform } from "framer-motion";
import {
  ArrowRight,
  Activity,
  BadgeCheck,
  Ban,
  Clock3,
  FileCheck2,
  Gauge,
  MoonStar,
  ShieldCheck,
  Sparkles,
  Sun,
} from "lucide-react";
import { Link } from "react-router-dom";
import { GuardianScene } from "../components/GuardianScene";
import { Brand, LandingNav, Mark } from "../components/Brand";

const reveal = {
  initial: { opacity: 0, y: 28 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.25 },
  transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const },
};

function SessionClock({ kind }: { kind: "cash" | "rtoken" }) {
  const cash = kind === "cash";
  return (
    <motion.article
      className={`clock-card ${cash ? "cash-clock" : "rtoken-clock"}`}
      whileHover={{ y: -8, rotate: cash ? -1 : 1 }}
      transition={{ type: "spring", stiffness: 260, damping: 18 }}
    >
      <div className="clock-card-top">
        <span className="clock-icon">{cash ? <Sun size={23} /> : <MoonStar size={23} />}</span>
        <span className={`status-lozenge ${cash ? "closed" : "live"}`}>
          <i /> {cash ? "Closed" : "Trading"}
        </span>
      </div>
      <p>{cash ? "NASDAQ / NYSE" : "BITGET RTOKEN"}</p>
      <strong>{cash ? "Sunday · 14:42 ET" : "rORCL · $303.32"}</strong>
      <div className="clock-face" aria-hidden="true">
        <span className="clock-hand hour" />
        <motion.span
          className="clock-hand minute"
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: cash ? 18 : 5, ease: "linear" }}
        />
        <span className="clock-center" />
      </div>
      <small>{cash ? "No native price discovery" : "+0.90% vs cash-aligned close"}</small>
    </motion.article>
  );
}

export function LandingPage() {
  const { scrollYProgress } = useScroll();
  const drift = useTransform(scrollYProgress, [0, 1], [0, 160]);

  return (
    <motion.div
      className="landing-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="paper-grain" />
      <motion.div className="floating-orb orb-one" style={{ y: drift }} />
      <motion.div className="floating-orb orb-two" style={{ y: useTransform(drift, (value) => -value * 0.65) }} />
      <LandingNav />

      <main>
        <section className="landing-hero shell">
          <div className="hero-copy">
            <motion.div
              className="eyebrow"
              initial={{ opacity: 0, x: -18 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.12 }}
            >
              <span><ShieldCheck size={15} /></span>
              Permission layer for 24/7 stock tokens
            </motion.div>
            <motion.h1
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18, duration: 0.75 }}
            >
              The market sleeps.<br />
              <em>Your rules don’t.</em>
            </motion.h1>
            <motion.p
              className="hero-lede"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.65 }}
            >
              SessionGuard stops traders from mistaking an always-on rToken quote
              for live US cash-market price discovery.
            </motion.p>
            <motion.div
              className="hero-actions"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.42 }}
            >
              <Link className="button button-coral button-large" to="/app?replay=sunday-oracle">
                Run the Sunday replay <ArrowRight size={18} />
              </Link>
              <a className="text-link" href="#process">See the permission flow <span>↓</span></a>
            </motion.div>
            <motion.div
              className="trust-row"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.65 }}
            >
              <span><BadgeCheck size={17} /> Bitget-only data</span>
              <span><ShieldCheck size={17} /> Paper only</span>
              <span><FileCheck2 size={17} /> Every block logged</span>
            </motion.div>
          </div>

          <motion.div
            className="hero-art"
            initial={{ opacity: 0, scale: 0.92, rotate: 1.5 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            transition={{ delay: 0.25, duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="price-note note-top">
              <small>WEEKEND PRINT</small>
              <strong>$303.32</strong>
              <span>Looks real. Different market.</span>
            </div>
            <GuardianScene verdict="BLOCK" />
            <motion.div
              className="blocked-ticket"
              animate={{ y: [0, -7, 0], rotate: [-2, 0, -2] }}
              transition={{ repeat: Infinity, duration: 3.8 }}
            >
              <Ban size={22} />
              <div><strong>BUY BLOCKED</strong><small>Cash market dark · +90 bps vs anchor</small></div>
            </motion.div>
          </motion.div>
        </section>

        <section className="ticker-ribbon" aria-label="Sample rToken market tape">
          <motion.div
            className="ticker-track"
            animate={{ x: [0, -850] }}
            transition={{ repeat: Infinity, duration: 22, ease: "linear" }}
          >
            {[0, 1].flatMap((group) => [
              <span key={`${group}-1`}><b>rNVDA</b> $188.44 <i className="up">+0.31%</i></span>,
              <span key={`${group}-2`}><b>US CASH</b> CLOSED <i>WEEKEND</i></span>,
              <span key={`${group}-3`}><b>rTSLA</b> $416.18 <i className="up">+0.79%</i></span>,
              <span key={`${group}-4`}><b>GUARD</b> ALERT ONLY <i className="warn">RULE 01</i></span>,
              <span key={`${group}-5`}><b>rORCL</b> $303.32 <i className="up">+0.90%</i></span>,
            ])}
          </motion.div>
        </section>

        <section className="two-clocks section-shell" id="problem">
          <motion.div className="section-heading centered" {...reveal}>
            <span className="section-index">01 / THE MISMATCH</span>
            <h2>Two clocks.<br /><em>One tempting price.</em></h2>
            <p>The quote keeps moving after the venue that anchors it has gone dark.</p>
          </motion.div>
          <div className="clock-stage">
            <motion.div className="clock-connector" initial={{ scaleX: 0 }} whileInView={{ scaleX: 1 }} viewport={{ once: true }} transition={{ duration: 1.2 }}>
              <span>≠</span>
            </motion.div>
            <SessionClock kind="cash" />
            <SessionClock kind="rtoken" />
          </div>
          <motion.div className="editorial-callout" {...reveal}>
            <Sparkles size={22} />
            <p><strong>A price can be executable without being a native-stock print.</strong> SessionGuard labels that distinction before the idea reaches an order.</p>
          </motion.div>
        </section>

        <section className="process-section" id="process">
          <div className="section-shell">
            <motion.div className="section-heading light" {...reveal}>
              <span className="section-index">02 / THE PERMISSION FLOW</span>
              <h2>Observe with Bitget.<br /><em>Authorize with code.</em></h2>
            </motion.div>
            <div className="process-grid">
              {[
                { n: "01", icon: <Activity />, title: "Bitget quote", body: "Current rToken price and provider timestamp establish the tradable print." },
                { n: "02", icon: <Clock3 />, title: "Session stamp", body: "New York time, holidays, early closes, and data freshness define the session." },
                { n: "03", icon: <Gauge />, title: "Portfolio stress", body: "Code checks the Bitget anchor, spread, gap exposure, collateral, and size limits." },
                { n: "04", icon: <ShieldCheck />, title: "Gate decides", body: "TRADE, ALERT, or BLOCK. No caller can skip this box." },
              ].map((step, index) => (
                <motion.article
                  className="process-card"
                  key={step.n}
                  initial={{ opacity: 0, y: 35, rotate: index % 2 ? 1.5 : -1.5 }}
                  whileInView={{ opacity: 1, y: 0, rotate: 0 }}
                  viewport={{ once: true, amount: 0.4 }}
                  transition={{ delay: index * 0.12, duration: 0.65 }}
                  whileHover={{ y: -10 }}
                >
                  <div className="process-card-top"><span>{step.n}</span>{step.icon}</div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                  {index < 3 && <motion.i animate={{ x: [0, 6, 0] }} transition={{ repeat: Infinity, duration: 1.6 }}>→</motion.i>}
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        <section className="proof-section section-shell" id="proof">
          <motion.div className="proof-browser" {...reveal}>
            <div className="browser-bar">
              <div><span /><span /><span /></div>
              <p>sessionguard.app / weekend replay</p>
              <ShieldCheck size={17} />
            </div>
            <div className="proof-ui">
              <div className="proof-copy">
                <span className="status-lozenge closed"><i /> WEEKEND / HOLIDAY</span>
                <p>rORCL is <b>0.90% above</b> its last cash-aligned reference.</p>
                <div className="proof-numbers">
                  <span><small>ORDER</small><strong>$250</strong></span>
                  <span><small>−8% GAP</small><strong>−$92</strong></span>
                  <span><small>ALLOWED</small><strong>$0</strong></span>
                </div>
                <div className="proof-rule"><Ban size={18} /> Proposed buy. Rule 01 allowed zero.</div>
              </div>
              <GuardianScene verdict="BLOCK" compact />
            </div>
          </motion.div>
          <motion.div className="proof-side" {...reveal}>
            <span className="section-index">03 / PROOF, NOT PROMISES</span>
            <h2>The blocked lines <em>are the product.</em></h2>
            <p>Every prevented order becomes an inspectable receipt: source, market session, off-hours movement, gap math, and the rule that won.</p>
            <ul>
              <li><Gauge size={18} /><span><strong>Measured restraint</strong> Track avoided exposure, not fantasy returns.</span></li>
              <li><FileCheck2 size={18} /><span><strong>Exportable evidence</strong> JSON and CSV logs for the hackathon paper trail.</span></li>
              <li><ShieldCheck size={18} /><span><strong>Paper execution</strong> Signed, one-use permission for Bitget Demo only.</span></li>
            </ul>
            <Link className="button button-ink button-large" to="/app">
              Enter the control room <ArrowRight size={18} />
            </Link>
          </motion.div>
        </section>

        <section className="closing-cta section-shell">
          <motion.div {...reveal}>
            <Mark size={56} />
            <span className="section-index">SESSIONGUARD</span>
            <h2>Know which market<br />you’re trading.</h2>
            <p>Before an off-hours quote becomes an order.</p>
            <Link className="button button-paper button-large" to="/app?replay=sunday-oracle">
              Inspect a blocked trade <ArrowRight size={18} />
            </Link>
          </motion.div>
          <div className="closing-moon" aria-hidden="true"><MoonStar /></div>
        </section>
      </main>

      <footer className="landing-footer shell">
        <Brand compact />
        <p>Built for Bitget AI Base Camp · Agentic Trading</p>
        <span>Paper environment · No live-money route</span>
      </footer>
    </motion.div>
  );
}
