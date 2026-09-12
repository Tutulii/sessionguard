import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type {
  GuardDecision,
  PaperOrderReceiptV1,
  PlatformNotification,
  PortfolioSnapshot,
  ProductionMarketSnapshot,
  ProductionSymbol,
  UserPolicy,
} from "../shared/production-types.js";
import { platformPolicy, supportedSymbols } from "../shared/production-types.js";
import type {
  AnchorRecord,
  DailyOrderUsage,
  EnvelopeRecord,
  DemoConnectionRecord,
  NotificationAttempt,
  PlatformRepository,
  StoredChannel,
  UserRecord,
} from "./platform-repository.js";
import { productionSchemaSql, productionSchemaVersion } from "./postgres-schema.js";

function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function user(row: QueryResultRow): UserRecord {
  return { id: String(row.id), address: String(row.address), chainId: 42161, createdAt: iso(row.created_at), lastLoginAt: iso(row.last_login_at) };
}

export class PostgresPlatformRepository implements PlatformRepository {
  readonly pool: Pool;

  constructor(connectionString: string, options: { max?: number; ssl?: boolean } = {}) {
    this.pool = new Pool({
      connectionString,
      max: options.max ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    });
    // pg emits idle-client failures on the Pool itself. Without an error
    // listener, a transient database restart becomes an uncaught EventEmitter
    // error and terminates the whole web/worker process. Queries still reject
    // normally and readiness remains fail-closed while PostgreSQL is down.
    this.pool.on("error", () => undefined);
  }

  async init() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [8675309]);
      await client.query(productionSchemaSql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING", [productionSchemaVersion]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ready() {
    try { return (await this.pool.query("SELECT 1 AS ok")).rowCount === 1; } catch { return false; }
  }

  async countUsers() {
    const result = await this.pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
    return Number(result.rows[0]?.count ?? 0);
  }

  async findUserByAddress(address: string) {
    const result = await this.pool.query("SELECT * FROM users WHERE address=$1", [address.toLowerCase()]);
    return result.rows[0] ? user(result.rows[0]) : null;
  }

  async getUser(id: string) {
    const result = await this.pool.query("SELECT * FROM users WHERE id=$1", [id]);
    return result.rows[0] ? user(result.rows[0]) : null;
  }

  async createOrLoginUser(address: string, maxUsers: number) {
    const normalized = address.toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const found = await client.query("SELECT * FROM users WHERE address=$1", [normalized]);
      const now = new Date().toISOString();
      if (found.rows[0]) {
        const updated = await client.query("UPDATE users SET last_login_at=$1 WHERE id=$2 RETURNING *", [now, found.rows[0].id]);
        await client.query("INSERT INTO watchlists(user_id,symbols_json,updated_at) VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING",
          [found.rows[0].id, JSON.stringify(supportedSymbols), now]);
        await client.query("COMMIT");
        return user(updated.rows[0]);
      }
      const count = Number((await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users")).rows[0]?.count ?? 0);
      if (count >= maxUsers) throw new Error("PUBLIC_BETA_CAP_REACHED");
      const record: UserRecord = { id: randomUUID(), address: normalized, chainId: 42161, createdAt: now, lastLoginAt: now };
      await client.query("INSERT INTO users(id,address,chain_id,created_at,last_login_at) VALUES($1,$2,$3,$4,$5)",
        [record.id, record.address, record.chainId, record.createdAt, record.lastLoginAt]);
      await client.query("INSERT INTO wallets(address,user_id,chain_id) VALUES($1,$2,$3)", [record.address, record.id, record.chainId]);
      await client.query("INSERT INTO watchlists(user_id,symbols_json,updated_at) VALUES($1,$2,$3)",
        [record.id, JSON.stringify(supportedSymbols), now]);
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async deleteUser(id: string) { await this.pool.query("DELETE FROM users WHERE id=$1", [id]); }

  async saveConnection(record: DemoConnectionRecord) {
    await this.pool.query(`INSERT INTO bitget_connections(user_id,envelope_json,execution_enabled,last_validated_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET envelope_json=excluded.envelope_json,
      execution_enabled=excluded.execution_enabled,last_validated_at=excluded.last_validated_at,updated_at=excluded.updated_at`,
      [record.userId, record.envelope, record.executionEnabled, record.lastValidatedAt, record.createdAt, record.updatedAt]);
  }

  async getConnection(userId: string) {
    const result = await this.pool.query("SELECT * FROM bitget_connections WHERE user_id=$1", [userId]);
    const row = result.rows[0];
    return row ? { userId: String(row.user_id), envelope: json<EnvelopeRecord>(row.envelope_json), executionEnabled: Boolean(row.execution_enabled),
      lastValidatedAt: iso(row.last_validated_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) } : null;
  }

  async deleteConnection(userId: string) { await this.pool.query("DELETE FROM bitget_connections WHERE user_id=$1", [userId]); }
  async listConnectedUsers() { return (await this.pool.query<{ user_id: string }>("SELECT user_id::text FROM bitget_connections")).rows.map((row) => row.user_id); }

  async savePolicy(userId: string, policy: UserPolicy, version: string) {
    await this.pool.query(`INSERT INTO policies(user_id,policy_json,version) VALUES($1,$2,$3)
      ON CONFLICT(user_id) DO UPDATE SET policy_json=excluded.policy_json,version=excluded.version,updated_at=now()`, [userId, policy, version]);
  }

  async getPolicy(userId: string) {
    const row = (await this.pool.query("SELECT policy_json,version FROM policies WHERE user_id=$1", [userId])).rows[0];
    return row ? { policy: json<UserPolicy>(row.policy_json), version: String(row.version) } : null;
  }

  async saveAnchor(anchor: AnchorRecord) {
    await this.pool.query(`INSERT INTO market_anchors(symbol,session_date,price_micros,reference_timestamp,quality,captured_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(symbol,session_date) DO UPDATE SET price_micros=excluded.price_micros,
      reference_timestamp=excluded.reference_timestamp,quality=excluded.quality,captured_at=excluded.captured_at`,
      [anchor.symbol, anchor.sessionDate, anchor.priceMicros, anchor.referenceTimestamp, anchor.quality, anchor.capturedAt]);
  }

  async getAnchor(symbol: ProductionSymbol, sessionDate?: string) {
    const result = sessionDate
      ? await this.pool.query("SELECT * FROM market_anchors WHERE symbol=$1 AND session_date=$2", [symbol, sessionDate])
      : await this.pool.query("SELECT * FROM market_anchors WHERE symbol=$1 ORDER BY session_date DESC LIMIT 1", [symbol]);
    const row = result.rows[0];
    return row ? { symbol: String(row.symbol) as ProductionSymbol, priceMicros: Number(row.price_micros),
      referenceTimestamp: iso(row.reference_timestamp), sessionDate: String(row.session_date).slice(0, 10),
      quality: String(row.quality) as AnchorRecord["quality"], capturedAt: iso(row.captured_at) } : null;
  }

  async saveMarketAggregate(snapshot: ProductionMarketSnapshot) {
    await this.pool.query("INSERT INTO market_aggregates(symbol,received_at,snapshot_json) VALUES($1,$2,$3)",
      [snapshot.symbol, snapshot.receivedTimestamp, snapshot]);
  }

  async savePortfolio(snapshot: PortfolioSnapshot) {
    await this.pool.query(`INSERT INTO portfolio_snapshots(user_id,captured_at,snapshot_json) VALUES($1,$2,$3)
      ON CONFLICT(user_id) DO UPDATE SET captured_at=excluded.captured_at,snapshot_json=excluded.snapshot_json`,
      [snapshot.userId, snapshot.capturedAt, snapshot]);
  }

  async getPortfolio(userId: string) {
    const row = (await this.pool.query("SELECT snapshot_json FROM portfolio_snapshots WHERE user_id=$1", [userId])).rows[0];
    return row ? json<PortfolioSnapshot>(row.snapshot_json) : null;
  }

  async saveDecision(decision: GuardDecision) {
    const sanitized = { ...decision };
    delete sanitized.decisionToken;
    await this.pool.query(`INSERT INTO decisions_v1(id,user_id,created_at,symbol,permission,input_hash,decision_json)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET decision_json=excluded.decision_json`,
      [decision.id, decision.userId, decision.createdAt, decision.symbol, decision.permission, decision.inputHash, sanitized]);
  }

  async getDecision(id: string, userId: string) {
    const row = (await this.pool.query("SELECT decision_json FROM decisions_v1 WHERE id=$1 AND user_id=$2", [id, userId])).rows[0];
    return row ? json<GuardDecision>(row.decision_json) : null;
  }

  async listDecisions(userId: string, limit: number, offset: number) {
    const rows = (await this.pool.query("SELECT decision_json FROM decisions_v1 WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3", [userId, limit, offset])).rows;
    return rows.map((row) => json<GuardDecision>(row.decision_json));
  }

  async reserveOrder(receipt: PaperOrderReceiptV1, notionalCents: number, side: "buy" | "sell") {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [receipt.userId]);
      const existing = await client.query("SELECT receipt_json FROM paper_orders WHERE decision_id=$1 AND user_id=$2", [receipt.decisionId, receipt.userId]);
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { created: false, receipt: json<PaperOrderReceiptV1>(existing.rows[0].receipt_json) };
      }
      const usage = (await client.query<{ count: string; gross: string }>(`SELECT COUNT(*)::text AS count,
        COALESCE(SUM(CASE WHEN side='buy' THEN notional_cents ELSE 0 END),0)::text AS gross
        FROM paper_orders WHERE user_id=$1 AND submitted_at >= date_trunc('day',$2::timestamptz)
        AND receipt_json->>'status' <> 'REJECTED'`, [receipt.userId, receipt.submittedAt])).rows[0];
      if (Number(usage?.count ?? 0) >= platformPolicy.dailyOrderCount) throw new Error("DAILY_ORDER_COUNT_LIMIT");
      if (side === "buy" && Number(usage?.gross ?? 0) + notionalCents > platformPolicy.dailyGrossNewNotionalCents) {
        throw new Error("DAILY_GROSS_NOTIONAL_LIMIT");
      }
      await client.query(`INSERT INTO paper_orders(id,decision_id,user_id,client_order_id,side,notional_cents,submitted_at,receipt_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [receipt.id, receipt.decisionId, receipt.userId, receipt.clientOrderId, side, notionalCents, receipt.submittedAt, receipt]);
      await client.query("COMMIT");
      return { created: true, receipt };
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally { client.release(); }
  }

  async updateOrder(receipt: PaperOrderReceiptV1) {
    await this.pool.query("UPDATE paper_orders SET receipt_json=$1 WHERE id=$2 AND user_id=$3", [receipt, receipt.id, receipt.userId]);
  }

  async getOrderByDecision(decisionId: string, userId: string) {
    const row = (await this.pool.query("SELECT receipt_json FROM paper_orders WHERE decision_id=$1 AND user_id=$2", [decisionId, userId])).rows[0];
    return row ? json<PaperOrderReceiptV1>(row.receipt_json) : null;
  }

  async getDailyOrderUsage(userId: string, since: string): Promise<DailyOrderUsage> {
    const row = (await this.pool.query<{ count: string; gross: string }>(`SELECT COUNT(*)::text AS count,
      COALESCE(SUM(CASE WHEN side='buy' THEN notional_cents ELSE 0 END),0)::text AS gross
      FROM paper_orders WHERE user_id=$1 AND submitted_at >= $2
      AND receipt_json->>'status' <> 'REJECTED'`, [userId, since])).rows[0];
    return { count: Number(row?.count ?? 0), grossNewNotionalCents: Number(row?.gross ?? 0) };
  }

  async listReconciliationOrders(limit: number) {
    const rows = (await this.pool.query(`SELECT receipt_json FROM paper_orders
      WHERE receipt_json->>'status' IN ('RESERVED', 'SUBMITTING', 'RECONCILING')
        OR (receipt_json->>'status' = 'SUBMITTED'
          AND COALESCE((receipt_json->>'updatedAt')::timestamptz, submitted_at) <= now() - interval '5 minutes')
      ORDER BY COALESCE((receipt_json->>'updatedAt')::timestamptz, submitted_at) ASC LIMIT $1`, [limit])).rows;
    return rows.map((row) => json<PaperOrderReceiptV1>(row.receipt_json));
  }

  async saveChannel(channel: StoredChannel) {
    await this.pool.query(`INSERT INTO notification_channels(id,user_id,type,label,verified,created_at,destination_json)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET label=excluded.label,verified=excluded.verified,destination_json=excluded.destination_json`,
      [channel.id, channel.userId, channel.type, channel.label, channel.verified, channel.createdAt, channel.destination]);
  }

  async getChannel(id: string, userId: string) {
    const row = (await this.pool.query("SELECT * FROM notification_channels WHERE id=$1 AND user_id=$2", [id, userId])).rows[0];
    return row ? this.channel(row) : null;
  }

  async listChannels(userId: string) {
    return (await this.pool.query("SELECT * FROM notification_channels WHERE user_id=$1 ORDER BY created_at", [userId])).rows.map((row) => this.channel(row));
  }

  async deleteChannel(id: string, userId: string) { await this.pool.query("DELETE FROM notification_channels WHERE id=$1 AND user_id=$2", [id, userId]); }

  async saveNotification(notification: PlatformNotification) {
    await this.pool.query("INSERT INTO notifications(id,user_id,created_at,notification_json) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [notification.id, notification.userId, notification.createdAt, notification]);
  }

  async listNotifications(userId: string, limit: number) {
    return (await this.pool.query("SELECT notification_json FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2", [userId, limit])).rows
      .map((row) => json<PlatformNotification>(row.notification_json));
  }

  async acknowledgeNotification(id: string, userId: string, at: string) {
    const row = (await this.pool.query("SELECT notification_json FROM notifications WHERE id=$1 AND user_id=$2", [id, userId])).rows[0];
    if (!row) return;
    await this.pool.query("UPDATE notifications SET notification_json=$1 WHERE id=$2 AND user_id=$3", [{ ...json<Record<string, unknown>>(row.notification_json), readAt: at }, id, userId]);
  }

  async saveNotificationAttempt(attempt: NotificationAttempt) {
    await this.pool.query(`INSERT INTO notification_attempts(id,notification_id,channel_id,attempted_at,attempt_json)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,attempt_json=excluded.attempt_json`,
      [attempt.id, attempt.notificationId, attempt.channelId, attempt.attemptedAt, attempt]);
  }

  async saveAudit(userId: string | null, action: string, subjectId: string | null, metadata: Record<string, unknown>) {
    await this.pool.query("INSERT INTO audit_events(id,user_id,action,subject_id,metadata_json,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [randomUUID(), userId, action, subjectId, metadata, new Date().toISOString()]);
  }

  async prune(now: Date) {
    await this.pool.query("DELETE FROM market_aggregates WHERE received_at < $1", [new Date(now.getTime() - 30 * 86_400_000)]);
    await this.pool.query("DELETE FROM notification_attempts WHERE attempted_at < $1", [new Date(now.getTime() - 90 * 86_400_000)]);
    await this.pool.query("DELETE FROM notifications WHERE created_at < $1", [new Date(now.getTime() - 90 * 86_400_000)]);
    const year = new Date(now.getTime() - 365 * 86_400_000);
    await this.pool.query("DELETE FROM decisions_v1 WHERE created_at < $1", [year]);
    await this.pool.query("DELETE FROM audit_events WHERE created_at < $1", [year]);
  }

  async close() { await this.pool.end(); }

  private channel(row: QueryResultRow): StoredChannel {
    return { id: String(row.id), userId: String(row.user_id), type: String(row.type) as StoredChannel["type"], label: String(row.label),
      verified: Boolean(row.verified), createdAt: iso(row.created_at), destination: row.destination_json ? json(row.destination_json) : null };
  }

  private async rollback(client: PoolClient) {
    try { await client.query("ROLLBACK"); } catch { /* connection is discarded by pg if unusable */ }
  }
}
