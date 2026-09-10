import { Bell, ExternalLink } from "lucide-react";
import { Link, NavLink } from "react-router-dom";

export function Mark({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 44 44"
      aria-hidden="true"
      className="brand-mark"
    >
      <path d="M22 3 38 9v12c0 9.8-6.3 16.8-16 20C12.3 37.8 6 30.8 6 21V9l16-6Z" fill="#173b35" />
      <path d="M22 7.2 34 11.7v9.4c0 7.2-4.4 12.7-12 15.7V7.2Z" fill="#f4c85f" />
      <path d="M19.7 11.4a9.1 9.1 0 1 0 0 18.2 7.2 7.2 0 1 1 0-18.2Z" fill="#f4eddf" />
      <path d="M26.7 14.7v10.6M22.8 20h7.8" stroke="#173b35" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="brand" aria-label="SessionGuard home">
      <Mark size={compact ? 34 : 40} />
      <span className="brand-copy">
        <strong>SessionGuard</strong>
        {!compact && <small>Agentic risk layer</small>}
      </span>
    </Link>
  );
}

export function LandingNav() {
  return (
    <header className="landing-nav shell">
      <Brand />
      <nav aria-label="Landing navigation">
        <a href="#problem">The mismatch</a>
        <a href="#process">How it works</a>
        <a href="#proof">Proof, not promises</a>
      </nav>
      <Link className="button button-ink nav-cta" to="/app">
        Open live desk <ExternalLink size={15} />
      </Link>
    </header>
  );
}

export function AppNav({ onConnect, onNotifications, connected }: { onConnect: () => void; onNotifications: () => void; connected: boolean }) {
  return (
    <header className="app-nav">
      <Brand compact />
      <nav aria-label="App navigation">
        <NavLink to="/app" end>Overview</NavLink>
        <a href="#decisions">Decisions</a>
        <a href="#policy">Policy</a>
      </nav>
      <div className="app-nav-actions">
        <button className="icon-button" aria-label="Notifications" onClick={onNotifications}>
          <Bell size={18} />
          <span className="notification-dot" />
        </button>
        <button className={`connection-pill ${connected ? "is-connected" : ""}`} onClick={onConnect}>
          <span /> {connected ? "Demo connected" : "Connect demo"}
        </button>
      </div>
    </header>
  );
}

