import { randomUUID } from "node:crypto";

export type NonceRecord = {
  nonce: string;
  address: string;
  message: string;
  domain: string;
  uri: string;
  expiresAt: string;
};

export type AuthSessionRecord = {
  id: string;
  userId: string;
  address: string;
  chainId: 42161;
  createdAt: string;
  lastSeenAt: string;
  lastVerifiedAt: string;
  absoluteExpiresAt: string;
};

export type NotificationJob = {
  id: string;
  notificationId: string;
  userId: string;
  channelId: string;
  attempt: number;
  runAt: string;
};

export interface Coordinator {
  init(): Promise<void>;
  ready(): Promise<boolean>;
  saveNonce(record: NonceRecord, ttlSeconds: number): Promise<void>;
  takeNonce(nonce: string): Promise<NonceRecord | null>;
  saveSession(record: AuthSessionRecord): Promise<void>;
  getSession(id: string, touch?: boolean): Promise<AuthSessionRecord | null>;
  deleteSession(id: string): Promise<void>;
  consumeOnce(namespace: string, value: string, ttlMs: number): Promise<boolean>;
  rateLimit(key: string, maximum: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }>;
  cacheGet<T>(key: string): Promise<T | null>;
  cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, listener: (payload: string) => void): Promise<() => Promise<void>>;
  enqueueNotification(job: NotificationJob): Promise<void>;
  claimNotification(now: Date): Promise<NotificationJob | null>;
  completeNotification(jobId: string): Promise<void>;
  retryNotification(job: NotificationJob): Promise<void>;
  deadLetterNotification(job: NotificationJob): Promise<void>;
  acquireLock(key: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
  close(): Promise<void>;
}

export const AUTH_IDLE_MS = 12 * 60 * 60_000;

export function createSessionRecord(user: { id: string; address: string }, now = new Date()): AuthSessionRecord {
  return {
    id: randomUUID(),
    userId: user.id,
    address: user.address,
    chainId: 42161,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    lastVerifiedAt: now.toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
  };
}
