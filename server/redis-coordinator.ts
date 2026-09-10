import { randomBytes } from "node:crypto";
import { createClient } from "redis";
import type { AuthSessionRecord, Coordinator, NonceRecord, NotificationJob } from "./coordinator-contract.js";
import { AUTH_IDLE_MS } from "./coordinator-contract.js";

const NOTIFICATION_LEASE_MS = 60_000;

export class RedisCoordinator implements Coordinator {
  private readonly client;
  private readonly subscriber;
  private readonly listeners = new Map<string, Set<(payload: string) => void>>();

  constructor(url: string) {
    this.client = createClient({ url, socket: { reconnectStrategy: (attempts) => Math.min(5_000, 100 * 2 ** attempts) } });
    this.subscriber = this.client.duplicate();
  }

  async init() {
    if (!this.client.isOpen) await this.client.connect();
    if (!this.subscriber.isOpen) await this.subscriber.connect();
  }
  async ready() { try { return await this.client.ping() === "PONG"; } catch { return false; } }
  async saveNonce(record: NonceRecord, ttlSeconds: number) { await this.client.set(`sg:nonce:${record.nonce}`, JSON.stringify(record), { EX: ttlSeconds }); }
  async takeNonce(nonce: string) { const value = await this.client.getDel(`sg:nonce:${nonce}`); return value ? JSON.parse(value) as NonceRecord : null; }

  async saveSession(record: AuthSessionRecord) {
    const ttl = this.sessionTtl(record);
    if (ttl > 0) await this.client.set(`sg:session:${record.id}`, JSON.stringify(record), { PX: ttl });
  }

  async getSession(id: string, touch = true) {
    const value = await this.client.get(`sg:session:${id}`);
    if (!value) return null;
    const record = JSON.parse(value) as AuthSessionRecord;
    const now = Date.now();
    if (new Date(record.lastSeenAt).getTime() + AUTH_IDLE_MS <= now || new Date(record.absoluteExpiresAt).getTime() <= now) {
      await this.deleteSession(id);
      return null;
    }
    if (touch) {
      record.lastSeenAt = new Date(now).toISOString();
      await this.saveSession(record);
    }
    return record;
  }

  async deleteSession(id: string) { await this.client.del(`sg:session:${id}`); }
  async consumeOnce(namespace: string, value: string, ttlMs: number) { return await this.client.set(`sg:once:${namespace}:${value}`, "1", { NX: true, PX: ttlMs }) === "OK"; }

  async rateLimit(key: string, maximum: number, windowSeconds: number) {
    const redisKey = `sg:rate:${key}`;
    const result = await this.client.multi().incr(redisKey).expire(redisKey, windowSeconds, "NX").exec();
    const count = Number(result[0]);
    return { allowed: count <= maximum, remaining: Math.max(0, maximum - count) };
  }

  async cacheGet<T>(key: string) { const value = await this.client.get(`sg:cache:${key}`); return value ? JSON.parse(value) as T : null; }
  async cacheSet<T>(key: string, value: T, ttlSeconds: number) { await this.client.set(`sg:cache:${key}`, JSON.stringify(value), { EX: ttlSeconds }); }
  async publish(channel: string, payload: unknown) { await this.client.publish(`sg:${channel}`, JSON.stringify(payload)); }

  async subscribe(channel: string, listener: (payload: string) => void) {
    const key = `sg:${channel}`;
    const handlers = this.listeners.get(key) ?? new Set<(payload: string) => void>();
    handlers.add(listener);
    this.listeners.set(key, handlers);
    if (handlers.size === 1) {
      await this.subscriber.subscribe(key, (message) => {
        for (const handler of this.listeners.get(key) ?? []) handler(message);
      });
    }
    return async () => {
      const active = this.listeners.get(key);
      active?.delete(listener);
      if (active && !active.size) {
        this.listeners.delete(key);
        await this.subscriber.unsubscribe(key);
      }
    };
  }

  async enqueueNotification(job: NotificationJob) {
    await this.client.multi()
      .set(`sg:notify:job:${job.id}`, JSON.stringify(job), { EX: 7 * 86_400 })
      .zRem("sg:notify:processing", job.id)
      .zAdd("sg:notify:scheduled", { score: new Date(job.runAt).getTime(), value: job.id })
      .exec();
  }

  async claimNotification(now: Date) {
    const script = `
      local expired=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[1],'LIMIT',0,100)
      for _,id in ipairs(expired) do
        redis.call('ZREM',KEYS[2],id)
        if redis.call('EXISTS',KEYS[3]..id)==1 then redis.call('ZADD',KEYS[1],ARGV[1],id) end
      end
      local ids=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1],'LIMIT',0,1)
      if #ids==0 then return nil end
      local id=ids[1]
      redis.call('ZREM',KEYS[1],id)
      redis.call('ZADD',KEYS[2],ARGV[2],id)
      return redis.call('GET',KEYS[3]..id)
    `;
    const value = await this.client.eval(script, {
      keys: ["sg:notify:scheduled", "sg:notify:processing", "sg:notify:job:"],
      arguments: [String(now.getTime()), String(now.getTime() + NOTIFICATION_LEASE_MS)],
    });
    return value ? JSON.parse(String(value)) as NotificationJob : null;
  }

  async completeNotification(jobId: string) {
    await this.client.multi().zRem("sg:notify:scheduled", jobId).zRem("sg:notify:processing", jobId).del(`sg:notify:job:${jobId}`).exec();
  }

  async retryNotification(job: NotificationJob) { await this.enqueueNotification(job); }
  async deadLetterNotification(job: NotificationJob) {
    await this.client.multi().zRem("sg:notify:scheduled", job.id).zRem("sg:notify:processing", job.id)
      .del(`sg:notify:job:${job.id}`).lPush("sg:notify:dead", JSON.stringify(job)).exec();
  }

  async acquireLock(key: string, ttlMs: number) {
    const token = randomBytes(24).toString("hex");
    const redisKey = `sg:lock:${key}`;
    if (await this.client.set(redisKey, token, { NX: true, PX: ttlMs }) !== "OK") return null;
    return async () => {
      await this.client.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", { keys: [redisKey], arguments: [token] });
    };
  }

  async close() {
    if (this.subscriber.isOpen) await this.subscriber.quit();
    if (this.client.isOpen) await this.client.quit();
  }

  private sessionTtl(record: AuthSessionRecord) {
    return Math.max(0, Math.min(AUTH_IDLE_MS, new Date(record.absoluteExpiresAt).getTime() - Date.now()));
  }
}
