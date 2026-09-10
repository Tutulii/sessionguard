import type { AuthSessionRecord, Coordinator, NonceRecord, NotificationJob } from "./coordinator-contract.js";
import { AUTH_IDLE_MS } from "./coordinator-contract.js";

const NOTIFICATION_LEASE_MS = 60_000;

export class MemoryCoordinator implements Coordinator {
  private readonly nonces = new Map<string, { value: NonceRecord; expiresAt: number }>();
  private readonly sessions = new Map<string, AuthSessionRecord>();
  private readonly once = new Map<string, number>();
  private readonly counters = new Map<string, { value: number; expiresAt: number }>();
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly listeners = new Map<string, Set<(payload: string) => void>>();
  private readonly jobs = new Map<string, NotificationJob>();
  private readonly processingJobs = new Map<string, { job: NotificationJob; leaseExpiresAt: number }>();
  private readonly deadLetters = new Map<string, NotificationJob>();
  private readonly locks = new Map<string, number>();

  async init() {}
  async ready() { return true; }

  async saveNonce(record: NonceRecord, ttlSeconds: number) {
    this.nonces.set(record.nonce, { value: record, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async takeNonce(nonce: string) {
    const found = this.nonces.get(nonce);
    this.nonces.delete(nonce);
    return found && found.expiresAt > Date.now() ? found.value : null;
  }

  async saveSession(record: AuthSessionRecord) { this.sessions.set(record.id, record); }

  async getSession(id: string, touch = true) {
    const record = this.sessions.get(id);
    const now = Date.now();
    if (!record || new Date(record.absoluteExpiresAt).getTime() <= now || new Date(record.lastSeenAt).getTime() + AUTH_IDLE_MS <= now) {
      this.sessions.delete(id);
      return null;
    }
    if (touch) {
      record.lastSeenAt = new Date(now).toISOString();
      this.sessions.set(id, record);
    }
    return { ...record };
  }

  async deleteSession(id: string) { this.sessions.delete(id); }

  async consumeOnce(namespace: string, value: string, ttlMs: number) {
    this.cleanup();
    const key = `${namespace}:${value}`;
    if (this.once.has(key)) return false;
    this.once.set(key, Date.now() + ttlMs);
    return true;
  }

  async rateLimit(key: string, maximum: number, windowSeconds: number) {
    const now = Date.now();
    const current = this.counters.get(key);
    const next = !current || current.expiresAt <= now
      ? { value: 1, expiresAt: now + windowSeconds * 1000 }
      : { value: current.value + 1, expiresAt: current.expiresAt };
    this.counters.set(key, next);
    return { allowed: next.value <= maximum, remaining: Math.max(0, maximum - next.value) };
  }

  async cacheGet<T>(key: string) {
    const found = this.cache.get(key);
    if (!found || found.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return found.value as T;
  }

  async cacheSet<T>(key: string, value: T, ttlSeconds: number) {
    this.cache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async publish(channel: string, payload: unknown) {
    const encoded = JSON.stringify(payload);
    for (const listener of this.listeners.get(channel) ?? []) listener(encoded);
  }

  async subscribe(channel: string, listener: (payload: string) => void) {
    const handlers = this.listeners.get(channel) ?? new Set<(payload: string) => void>();
    handlers.add(listener);
    this.listeners.set(channel, handlers);
    return async () => {
      handlers.delete(listener);
      if (!handlers.size) this.listeners.delete(channel);
    };
  }

  async enqueueNotification(job: NotificationJob) {
    this.processingJobs.delete(job.id);
    this.jobs.set(job.id, job);
  }

  async claimNotification(now: Date) {
    for (const [id, leased] of this.processingJobs) {
      if (leased.leaseExpiresAt <= now.getTime()) {
        this.processingJobs.delete(id);
        this.jobs.set(id, { ...leased.job, runAt: now.toISOString() });
      }
    }
    const due = [...this.jobs.values()]
      .filter((job) => new Date(job.runAt).getTime() <= now.getTime())
      .sort((left, right) => left.runAt.localeCompare(right.runAt))[0];
    if (!due) return null;
    this.jobs.delete(due.id);
    this.processingJobs.set(due.id, { job: due, leaseExpiresAt: now.getTime() + NOTIFICATION_LEASE_MS });
    return due;
  }

  async completeNotification(jobId: string) {
    this.processingJobs.delete(jobId);
    this.jobs.delete(jobId);
  }

  async retryNotification(job: NotificationJob) { await this.enqueueNotification(job); }
  async deadLetterNotification(job: NotificationJob) {
    await this.completeNotification(job.id);
    this.deadLetters.set(job.id, job);
  }

  async acquireLock(key: string, ttlMs: number) {
    const now = Date.now();
    if ((this.locks.get(key) ?? 0) > now) return null;
    const expiresAt = now + ttlMs;
    this.locks.set(key, expiresAt);
    return async () => {
      if (this.locks.get(key) === expiresAt) this.locks.delete(key);
    };
  }

  async close() { this.listeners.clear(); }

  private cleanup() {
    const now = Date.now();
    for (const [key, expiresAt] of this.once) if (expiresAt <= now) this.once.delete(key);
  }
}
