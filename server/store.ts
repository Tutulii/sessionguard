import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DecisionReceipt,
  MarketEvent,
  PermissionDecision,
} from "../shared/types.js";

function withoutExecutionCapability(decision: PermissionDecision): PermissionDecision {
  const persisted = { ...decision };
  delete persisted.decisionToken;
  delete persisted.tokenExpiresAt;
  return persisted;
}

export class DecisionStore {
  private readonly db: DatabaseSync;

  constructor(path = process.env.DATABASE_PATH ?? ".data/sessionguard.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        detected_at TEXT NOT NULL,
        symbol TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        symbol TEXT NOT NULL,
        verdict TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        event_json TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        order_json TEXT
      );
      CREATE INDEX IF NOT EXISTS decisions_created_at_idx ON decisions(created_at DESC);
      CREATE INDEX IF NOT EXISTS decisions_session_idx ON decisions(session_hash, created_at DESC);
    `);
  }

  saveEvent(event: MarketEvent) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO events (id, detected_at, symbol, event_json) VALUES (?, ?, ?, ?)",
      )
      .run(event.id, event.detectedAt, event.symbol, JSON.stringify(event));
  }

  listEvents(limit = 30): MarketEvent[] {
    const rows = this.db
      .prepare("SELECT event_json FROM events ORDER BY detected_at DESC LIMIT ?")
      .all(limit) as Array<{ event_json: string }>;
    return rows.map((row) => JSON.parse(row.event_json) as MarketEvent);
  }

  saveDecision(decision: PermissionDecision, event: MarketEvent, sessionHash: string) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO decisions
          (id, created_at, symbol, verdict, session_hash, event_json, decision_json, order_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT order_json FROM decisions WHERE id = ?), NULL))`,
      )
      .run(
        decision.id,
        decision.createdAt,
        decision.symbol,
        decision.verdict,
        sessionHash,
        JSON.stringify(event),
        JSON.stringify(withoutExecutionCapability(decision)),
        decision.id,
      );
  }

  saveOrder(decisionId: string, order: NonNullable<DecisionReceipt["order"]>) {
    this.db
      .prepare("UPDATE decisions SET order_json = ? WHERE id = ?")
      .run(JSON.stringify(order), decisionId);
  }

  getReceipt(decisionId: string): DecisionReceipt | null {
    const row = this.db
      .prepare(
        "SELECT event_json, decision_json, order_json FROM decisions WHERE id = ?",
      )
      .get(decisionId) as
      | { event_json: string; decision_json: string; order_json: string | null }
      | undefined;
    if (!row) return null;
    return {
      event: JSON.parse(row.event_json),
      decision: JSON.parse(row.decision_json),
      order: row.order_json ? JSON.parse(row.order_json) : null,
    } as DecisionReceipt;
  }

  listReceipts(sessionHash?: string, limit = 50): DecisionReceipt[] {
    const rows = (sessionHash
      ? this.db
          .prepare(
            `SELECT event_json, decision_json, order_json FROM decisions
             WHERE session_hash IN (?, 'public') ORDER BY created_at DESC LIMIT ?`,
          )
          .all(sessionHash, limit)
      : this.db
          .prepare(
            "SELECT event_json, decision_json, order_json FROM decisions ORDER BY created_at DESC LIMIT ?",
          )
          .all(limit)) as Array<{
      event_json: string;
      decision_json: string;
      order_json: string | null;
    }>;
    return rows.map((row) => ({
      event: JSON.parse(row.event_json),
      decision: JSON.parse(row.decision_json),
      order: row.order_json ? JSON.parse(row.order_json) : null,
    })) as DecisionReceipt[];
  }

  close() {
    this.db.close();
  }
}

