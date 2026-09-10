import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  GuardDecision,
  NotificationChannel,
  PaperOrderReceiptV1,
  PlatformNotification,
  PortfolioSnapshot,
  ProductionMarketSnapshot,
  ProductionSymbol,
  UserPolicy,
} from "../shared/production-types.js";
import { platformPolicy, supportedSymbols } from "../shared/production-types.js";

export type UserRecord = {
  id: string;
  address: string;
  chainId: 42161;
  createdAt: string;
  lastLoginAt: string;
};

export type EnvelopeRecord = {
  cipherText: string;
  iv: string;
  authTag: string;
  encryptedDataKey: string;
  keyProvider: string;
  version: number;
  updatedAt: string;
};

export type DemoConnectionRecord = {
  userId: string;
  envelope: EnvelopeRecord;
  executionEnabled: boolean;
  lastValidatedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type AnchorRecord = {
  symbol: ProductionSymbol;
  priceMicros: number;
  referenceTimestamp: string;
  sessionDate: string;
  quality: "OBSERVED" | "DEGRADED";
  capturedAt: string;
};

export type StoredChannel = NotificationChannel & {
  userId: string;
  destination: EnvelopeRecord | null;
};

export type NotificationAttempt = {
  id: string;
  notificationId: string;
  channelId: string;
  attempt: number;
  status: "PENDING" | "DELIVERED" | "FAILED" | "DEAD_LETTER";
  providerMessage: string;
  attemptedAt: string;
};

export type DailyOrderUsage = { count: number; grossNewNotionalCents: number };

export interface PlatformRepository {
  init(): Promise<void>;
  ready(): Promise<boolean>;
  countUsers(): Promise<number>;
  findUserByAddress(address: string): Promise<UserRecord | null>;
  getUser(id: string): Promise<UserRecord | null>;
  createOrLoginUser(address: string, maxUsers: number): Promise<UserRecord>;
  deleteUser(id: string): Promise<void>;
  saveConnection(record: DemoConnectionRecord): Promise<void>;
  getConnection(userId: string): Promise<DemoConnectionRecord | null>;
  deleteConnection(userId: string): Promise<void>;
  listConnectedUsers(): Promise<string[]>;
  savePolicy(userId: string, policy: UserPolicy, version: string): Promise<void>;
  getPolicy(userId: string): Promise<{ policy: UserPolicy; version: string } | null>;
  saveAnchor(anchor: AnchorRecord): Promise<void>;
  getAnchor(symbol: ProductionSymbol, sessionDate?: string): Promise<AnchorRecord | null>;
  saveMarketAggregate(snapshot: ProductionMarketSnapshot): Promise<void>;
  savePortfolio(snapshot: PortfolioSnapshot): Promise<void>;
  getPortfolio(userId: string): Promise<PortfolioSnapshot | null>;
  saveDecision(decision: GuardDecision): Promise<void>;
  getDecision(id: string, userId: string): Promise<GuardDecision | null>;
  listDecisions(userId: string, limit: number, offset: number): Promise<GuardDecision[]>;
  reserveOrder(receipt: PaperOrderReceiptV1, notionalCents: number, side: "buy" | "sell"): Promise<{ created: boolean; receipt: PaperOrderReceiptV1 }>;
  updateOrder(receipt: PaperOrderReceiptV1): Promise<void>;
  getOrderByDecision(decisionId: string, userId: string): Promise<PaperOrderReceiptV1 | null>;
  getDailyOrderUsage(userId: string, since: string): Promise<DailyOrderUsage>;
  listReconciliationOrders(limit: number): Promise<PaperOrderReceiptV1[]>;
  saveChannel(channel: StoredChannel): Promise<void>;
  getChannel(id: string, userId: string): Promise<StoredChannel | null>;
  listChannels(userId: string): Promise<StoredChannel[]>;
  deleteChannel(id: string, userId: string): Promise<void>;
  saveNotification(notification: PlatformNotification): Promise<void>;
  listNotifications(userId: string, limit: number): Promise<PlatformNotification[]>;
  acknowledgeNotification(id: string, userId: string, at: string): Promise<void>;
  saveNotificationAttempt(attempt: NotificationAttempt): Promise<void>;
  saveAudit(userId: string | null, action: string, subjectId: string | null, metadata: Record<string, unknown>): Promise<void>;
  prune(now: Date): Promise<void>;
  close(): Promise<void>;
}

const sqliteSchema = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, chain_id INTEGER NOT NULL,
    created_at TEXT NOT NULL, last_login_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bitget_connections (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    envelope_json TEXT NOT NULL, execution_enabled INTEGER NOT NULL,
    last_validated_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS policies (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    policy_json TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS market_anchors (
    symbol TEXT NOT NULL, session_date TEXT NOT NULL, price_micros INTEGER NOT NULL,
    reference_timestamp TEXT NOT NULL, quality TEXT NOT NULL, captured_at TEXT NOT NULL,
    PRIMARY KEY(symbol, session_date)
  );
  CREATE TABLE IF NOT EXISTS market_aggregates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, received_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS market_aggregates_retention_idx ON market_aggregates(received_at);
  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    captured_at TEXT NOT NULL, snapshot_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS decisions_v1 (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, symbol TEXT NOT NULL, permission TEXT NOT NULL,
    input_hash TEXT NOT NULL, decision_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS decisions_v1_user_idx ON decisions_v1(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS paper_orders (
    id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_order_id TEXT NOT NULL UNIQUE, side TEXT NOT NULL, notional_cents INTEGER NOT NULL,
    submitted_at TEXT NOT NULL, receipt_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS paper_orders_usage_idx ON paper_orders(user_id, submitted_at);
  CREATE TABLE IF NOT EXISTS notification_channels (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, label TEXT NOT NULL, verified INTEGER NOT NULL,
    created_at TEXT NOT NULL, destination_json TEXT
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, notification_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS notification_attempts (
    id TEXT PRIMARY KEY, notification_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    attempted_at TEXT NOT NULL, attempt_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, subject_id TEXT,
    metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_retention_idx ON audit_events(created_at);
  CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'AUDIT_EVENTS_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS audit_events_retained_delete BEFORE DELETE ON audit_events
    WHEN julianday(OLD.created_at) >= julianday('now', '-365 days')
    BEGIN SELECT RAISE(ABORT, 'AUDIT_EVENTS_RETAINED'); END;
  CREATE TABLE IF NOT EXISTS watchlists (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    symbols_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`;

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class SqlitePlatformRepository implements PlatformRepository {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  async init() { this.db.exec(sqliteSchema); }
  async ready() { return Boolean(this.db.prepare("SELECT 1 AS ok").get()); }
  async countUsers() { return Number((this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count); }

  async findUserByAddress(address: string) {
    const row = this.db.prepare("SELECT * FROM users WHERE address = ?").get(address.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? this.user(row) : null;
  }

  async getUser(id: string) {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.user(row) : null;
  }

  async createOrLoginUser(address: string, maxUsers: number) {
    const normalized = address.toLowerCase();
    const existing = await this.findUserByAddress(normalized);
    const now = new Date().toISOString();
    if (existing) {
      this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, existing.id);
      this.db.prepare("INSERT OR IGNORE INTO watchlists(user_id, symbols_json, updated_at) VALUES (?, ?, ?)")
        .run(existing.id, JSON.stringify(supportedSymbols), now);
      return { ...existing, lastLoginAt: now };
    }
    if (await this.countUsers() >= maxUsers) throw new Error("PUBLIC_BETA_CAP_REACHED");
    const user: UserRecord = { id: randomUUID(), address: normalized, chainId: 42161, createdAt: now, lastLoginAt: now };
    this.db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?)").run(user.id, user.address, user.chainId, user.createdAt, user.lastLoginAt);
    this.db.prepare("INSERT INTO watchlists(user_id, symbols_json, updated_at) VALUES (?, ?, ?)")
      .run(user.id, JSON.stringify(supportedSymbols), now);
    return user;
  }

  async deleteUser(id: string) { this.db.prepare("DELETE FROM users WHERE id = ?").run(id); }

  async saveConnection(record: DemoConnectionRecord) {
    this.db.prepare(`INSERT INTO bitget_connections VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET envelope_json=excluded.envelope_json,
      execution_enabled=excluded.execution_enabled, last_validated_at=excluded.last_validated_at,
      updated_at=excluded.updated_at`).run(record.userId, JSON.stringify(record.envelope), record.executionEnabled ? 1 : 0,
      record.lastValidatedAt, record.createdAt, record.updatedAt);
  }

  async getConnection(userId: string) {
    const row = this.db.prepare("SELECT * FROM bitget_connections WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined;
    return row ? {
      userId: String(row.user_id), envelope: parse<EnvelopeRecord>(String(row.envelope_json)), executionEnabled: Boolean(row.execution_enabled),
      lastValidatedAt: String(row.last_validated_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    } : null;
  }

  async deleteConnection(userId: string) { this.db.prepare("DELETE FROM bitget_connections WHERE user_id = ?").run(userId); }
  async listConnectedUsers() { return (this.db.prepare("SELECT user_id FROM bitget_connections").all() as Array<{ user_id: string }>).map((row) => row.user_id); }

  async savePolicy(userId: string, policy: UserPolicy, version: string) {
    this.db.prepare(`INSERT INTO policies VALUES (?, ?, ?, ?) ON CONFLICT(user_id)
      DO UPDATE SET policy_json=excluded.policy_json, version=excluded.version, updated_at=excluded.updated_at`)
      .run(userId, JSON.stringify(policy), version, new Date().toISOString());
  }

  async getPolicy(userId: string) {
    const row = this.db.prepare("SELECT policy_json, version FROM policies WHERE user_id = ?").get(userId) as { policy_json: string; version: string } | undefined;
    return row ? { policy: parse<UserPolicy>(row.policy_json), version: row.version } : null;
  }

  async saveAnchor(anchor: AnchorRecord) {
    this.db.prepare(`INSERT INTO market_anchors VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(symbol, session_date)
      DO UPDATE SET price_micros=excluded.price_micros, reference_timestamp=excluded.reference_timestamp,
      quality=excluded.quality, captured_at=excluded.captured_at`)
      .run(anchor.symbol, anchor.sessionDate, anchor.priceMicros, anchor.referenceTimestamp, anchor.quality, anchor.capturedAt);
  }

  async getAnchor(symbol: ProductionSymbol, sessionDate?: string) {
    const row = (sessionDate
      ? this.db.prepare("SELECT * FROM market_anchors WHERE symbol = ? AND session_date = ?").get(symbol, sessionDate)
      : this.db.prepare("SELECT * FROM market_anchors WHERE symbol = ? ORDER BY session_date DESC LIMIT 1").get(symbol)) as Record<string, unknown> | undefined;
    return row ? this.anchor(row) : null;
  }

  async saveMarketAggregate(snapshot: ProductionMarketSnapshot) {
    this.db.prepare("INSERT INTO market_aggregates(symbol, received_at, snapshot_json) VALUES (?, ?, ?)")
      .run(snapshot.symbol, snapshot.receivedTimestamp, JSON.stringify(snapshot));
  }

  async savePortfolio(snapshot: PortfolioSnapshot) {
    this.db.prepare(`INSERT INTO portfolio_snapshots VALUES (?, ?, ?) ON CONFLICT(user_id)
      DO UPDATE SET captured_at=excluded.captured_at, snapshot_json=excluded.snapshot_json`)
      .run(snapshot.userId, snapshot.capturedAt, JSON.stringify(snapshot));
  }

  async getPortfolio(userId: string) {
    const row = this.db.prepare("SELECT snapshot_json FROM portfolio_snapshots WHERE user_id = ?").get(userId) as { snapshot_json: string } | undefined;
    return row ? parse<PortfolioSnapshot>(row.snapshot_json) : null;
  }

  async saveDecision(decision: GuardDecision) {
    const sanitized = { ...decision };
    delete sanitized.decisionToken;
    this.db.prepare(`INSERT INTO decisions_v1 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id)
      DO UPDATE SET decision_json=excluded.decision_json`)
      .run(decision.id, decision.userId, decision.createdAt, decision.symbol, decision.permission, decision.inputHash, JSON.stringify(sanitized));
  }

  async getDecision(id: string, userId: string) {
    const row = this.db.prepare("SELECT decision_json FROM decisions_v1 WHERE id = ? AND user_id = ?").get(id, userId) as { decision_json: string } | undefined;
    return row ? parse<GuardDecision>(row.decision_json) : null;
  }

  async listDecisions(userId: string, limit: number, offset: number) {
    return (this.db.prepare("SELECT decision_json FROM decisions_v1 WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(userId, limit, offset) as Array<{ decision_json: string }>).map((row) => parse<GuardDecision>(row.decision_json));
  }

  async reserveOrder(receipt: PaperOrderReceiptV1, notionalCents: number, side: "buy" | "sell") {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = this.db.prepare("SELECT receipt_json FROM paper_orders WHERE decision_id = ? AND user_id = ?")
        .get(receipt.decisionId, receipt.userId) as { receipt_json: string } | undefined;
      if (existingRow) {
        this.db.exec("COMMIT");
        return { created: false, receipt: parse<PaperOrderReceiptV1>(existingRow.receipt_json) };
      }
      const since = new Date(Date.UTC(new Date(receipt.submittedAt).getUTCFullYear(), new Date(receipt.submittedAt).getUTCMonth(),
        new Date(receipt.submittedAt).getUTCDate())).toISOString();
      const usage = this.db.prepare(`SELECT COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN side='buy' THEN notional_cents ELSE 0 END), 0) AS gross
        FROM paper_orders WHERE user_id = ? AND submitted_at >= ?
        AND json_extract(receipt_json, '$.status') <> 'REJECTED'`).get(receipt.userId, since) as { count: number; gross: number };
      if (Number(usage.count) >= platformPolicy.dailyOrderCount) throw new Error("DAILY_ORDER_COUNT_LIMIT");
      if (side === "buy" && Number(usage.gross) + notionalCents > platformPolicy.dailyGrossNewNotionalCents) {
        throw new Error("DAILY_GROSS_NOTIONAL_LIMIT");
      }
      this.db.prepare("INSERT INTO paper_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(receipt.id, receipt.decisionId, receipt.userId, receipt.clientOrderId, side, notionalCents, receipt.submittedAt, JSON.stringify(receipt));
      this.db.exec("COMMIT");
      return { created: true, receipt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async updateOrder(receipt: PaperOrderReceiptV1) {
    this.db.prepare("UPDATE paper_orders SET receipt_json = ? WHERE id = ? AND user_id = ?")
      .run(JSON.stringify(receipt), receipt.id, receipt.userId);
  }

  async getOrderByDecision(decisionId: string, userId: string) {
    const row = this.db.prepare("SELECT receipt_json FROM paper_orders WHERE decision_id = ? AND user_id = ?").get(decisionId, userId) as { receipt_json: string } | undefined;
    return row ? parse<PaperOrderReceiptV1>(row.receipt_json) : null;
  }

  async getDailyOrderUsage(userId: string, since: string) {
    const row = this.db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN side='buy' THEN notional_cents ELSE 0 END), 0) AS gross
      FROM paper_orders WHERE user_id = ? AND submitted_at >= ?
      AND json_extract(receipt_json, '$.status') <> 'REJECTED'`).get(userId, since) as { count: number; gross: number };
    return { count: Number(row.count), grossNewNotionalCents: Number(row.gross) };
  }

  async listReconciliationOrders(limit: number) {
    const rows = this.db.prepare("SELECT receipt_json FROM paper_orders ORDER BY submitted_at ASC").all() as Array<{ receipt_json: string }>;
    const submittedDue = Date.now() - 5 * 60_000;
    return rows.map((row) => parse<PaperOrderReceiptV1>(row.receipt_json))
      .filter((receipt) => ["RESERVED", "SUBMITTING", "RECONCILING"].includes(receipt.status) ||
        (receipt.status === "SUBMITTED" && new Date(receipt.updatedAt).getTime() <= submittedDue))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, limit);
  }

  async saveChannel(channel: StoredChannel) {
    this.db.prepare(`INSERT INTO notification_channels VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id)
      DO UPDATE SET label=excluded.label, verified=excluded.verified, destination_json=excluded.destination_json`)
      .run(channel.id, channel.userId, channel.type, channel.label, channel.verified ? 1 : 0, channel.createdAt,
        channel.destination ? JSON.stringify(channel.destination) : null);
  }

  async getChannel(id: string, userId: string) {
    const row = this.db.prepare("SELECT * FROM notification_channels WHERE id = ? AND user_id = ?").get(id, userId) as Record<string, unknown> | undefined;
    return row ? this.channel(row) : null;
  }

  async listChannels(userId: string) {
    return (this.db.prepare("SELECT * FROM notification_channels WHERE user_id = ? ORDER BY created_at").all(userId) as Array<Record<string, unknown>>)
      .map((row) => this.channel(row));
  }

  async deleteChannel(id: string, userId: string) { this.db.prepare("DELETE FROM notification_channels WHERE id = ? AND user_id = ?").run(id, userId); }

  async saveNotification(notification: PlatformNotification) {
    this.db.prepare("INSERT OR IGNORE INTO notifications VALUES (?, ?, ?, ?)")
      .run(notification.id, notification.userId, notification.createdAt, JSON.stringify(notification));
  }

  async listNotifications(userId: string, limit: number) {
    return (this.db.prepare("SELECT notification_json FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit) as Array<{ notification_json: string }>).map((row) => parse<PlatformNotification>(row.notification_json));
  }

  async acknowledgeNotification(id: string, userId: string, at: string) {
    const row = this.db.prepare("SELECT notification_json FROM notifications WHERE id = ? AND user_id = ?").get(id, userId) as { notification_json: string } | undefined;
    if (!row) return;
    const notification = parse<PlatformNotification>(row.notification_json);
    this.db.prepare("UPDATE notifications SET notification_json = ? WHERE id = ? AND user_id = ?")
      .run(JSON.stringify({ ...notification, readAt: at }), id, userId);
  }

  async saveNotificationAttempt(attempt: NotificationAttempt) {
    this.db.prepare("INSERT OR REPLACE INTO notification_attempts VALUES (?, ?, ?, ?, ?)")
      .run(attempt.id, attempt.notificationId, attempt.channelId, attempt.attemptedAt, JSON.stringify(attempt));
  }

  async saveAudit(userId: string | null, action: string, subjectId: string | null, metadata: Record<string, unknown>) {
    this.db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), userId, action, subjectId, JSON.stringify(metadata), new Date().toISOString());
  }

  async prune(now: Date) {
    const marketBefore = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const notificationsBefore = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    const auditBefore = new Date(now.getTime() - 365 * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM market_aggregates WHERE received_at < ?").run(marketBefore);
    this.db.prepare("DELETE FROM notification_attempts WHERE attempted_at < ?").run(notificationsBefore);
    this.db.prepare("DELETE FROM notifications WHERE created_at < ?").run(notificationsBefore);
    this.db.prepare("DELETE FROM decisions_v1 WHERE created_at < ?").run(auditBefore);
    this.db.prepare("DELETE FROM paper_orders WHERE submitted_at < ?").run(auditBefore);
    this.db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(auditBefore);
  }

  async close() { this.db.close(); }

  private user(row: Record<string, unknown>): UserRecord {
    return { id: String(row.id), address: String(row.address), chainId: 42161, createdAt: String(row.created_at), lastLoginAt: String(row.last_login_at) };
  }
  private anchor(row: Record<string, unknown>): AnchorRecord {
    return { symbol: String(row.symbol) as ProductionSymbol, priceMicros: Number(row.price_micros), referenceTimestamp: String(row.reference_timestamp),
      sessionDate: String(row.session_date), quality: String(row.quality) as AnchorRecord["quality"], capturedAt: String(row.captured_at) };
  }
  private channel(row: Record<string, unknown>): StoredChannel {
    return { id: String(row.id), userId: String(row.user_id), type: String(row.type) as StoredChannel["type"], label: String(row.label),
      verified: Boolean(row.verified), createdAt: String(row.created_at), destination: row.destination_json ? parse(String(row.destination_json)) : null };
  }
}
