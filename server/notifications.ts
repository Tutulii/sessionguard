import { randomBytes, randomUUID } from "node:crypto";
import webpush from "web-push";
import type {
  NotificationChannel,
  PlatformNotification,
} from "../shared/production-types.js";
import type { Coordinator, NotificationJob } from "./coordinator.js";
import { EnvelopeVault } from "./envelope-vault.js";
import type { NotificationAttempt, PlatformRepository, StoredChannel } from "./platform-repository.js";

type ChannelDestination =
  | { email: string }
  | { chatId: string }
  | { endpoint: string; keys: { p256dh: string; auth: string } };

type VerificationRecord = { channelId: string; userId: string; kind: "EMAIL" | "TELEGRAM" };

export interface NotificationSender {
  send(channel: StoredChannel, destination: ChannelDestination, notification: PlatformNotification): Promise<string>;
}

export class ExternalNotificationSender implements NotificationSender {
  constructor(private readonly config: {
    appOrigin: string;
    resendApiKey?: string;
    emailFrom?: string;
    telegramBotToken?: string;
    vapidSubject?: string;
    vapidPublicKey?: string;
    vapidPrivateKey?: string;
  }) {
    if (config.vapidSubject && config.vapidPublicKey && config.vapidPrivateKey) {
      webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
    }
  }

  async send(channel: StoredChannel, destination: ChannelDestination, notification: PlatformNotification) {
    if (channel.type === "EMAIL") {
      if (!("email" in destination) || !this.config.resendApiKey || !this.config.emailFrom) throw new Error("EMAIL_PROVIDER_UNAVAILABLE");
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.resendApiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: this.config.emailFrom, to: [destination.email], subject: notification.title,
          text: `${notification.body}\n\nOpen SessionGuard: ${this.config.appOrigin}/app` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`EMAIL_HTTP_${response.status}`);
      const result = await response.json() as { id?: string };
      return result.id ?? "email-accepted";
    }
    if (channel.type === "TELEGRAM") {
      if (!("chatId" in destination) || !this.config.telegramBotToken) throw new Error("TELEGRAM_PROVIDER_UNAVAILABLE");
      const response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: destination.chatId, text: `SessionGuard · ${notification.title}\n${notification.body}` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`TELEGRAM_HTTP_${response.status}`);
      return "telegram-accepted";
    }
    if (channel.type === "WEB_PUSH") {
      if (!("endpoint" in destination) || !this.config.vapidPrivateKey) throw new Error("WEB_PUSH_PROVIDER_UNAVAILABLE");
      const result = await webpush.sendNotification(destination, JSON.stringify({
        title: notification.title, body: notification.body, url: "/app", tag: notification.kind,
      }), { TTL: 300, urgency: notification.severity === "CRITICAL" ? "high" : "normal" });
      return `web-push-${result.statusCode}`;
    }
    throw new Error("IN_APP_DOES_NOT_USE_EXTERNAL_DELIVERY");
  }
}

export class NotificationService {
  constructor(
    private readonly repository: PlatformRepository,
    private readonly coordinator: Coordinator,
    private readonly vault: EnvelopeVault,
    private readonly appOrigin: string,
    private readonly telegramBotName = "SessionGuardBot",
    private readonly sendVerificationEmail?: (email: string, url: string) => Promise<void>,
  ) {}

  async ensureInApp(userId: string) {
    const existing = (await this.repository.listChannels(userId)).find((channel) => channel.type === "IN_APP");
    if (existing) return this.publicChannel(existing);
    const channel: StoredChannel = { id: randomUUID(), userId, type: "IN_APP", label: "In-app inbox", verified: true, createdAt: new Date().toISOString(), destination: null };
    await this.repository.saveChannel(channel);
    return this.publicChannel(channel);
  }

  async addEmail(userId: string, email: string) {
    const channel: StoredChannel = {
      id: randomUUID(), userId, type: "EMAIL", label: email.replace(/^(.{2}).*(@.*)$/, "$1•••$2"), verified: false,
      createdAt: new Date().toISOString(), destination: await this.vault.encryptJson(userId, "notification-email", { email }),
    };
    await this.repository.saveChannel(channel);
    const token = randomBytes(24).toString("base64url");
    await this.coordinator.cacheSet<VerificationRecord>(`notification-verify:${token}`, { channelId: channel.id, userId, kind: "EMAIL" }, 3600);
    const verificationUrl = `${this.appOrigin}/api/v1/notifications/verify-email?token=${encodeURIComponent(token)}`;
    await this.sendVerificationEmail?.(email, verificationUrl);
    return { channel: this.publicChannel(channel), verificationUrl: this.sendVerificationEmail ? undefined : verificationUrl };
  }

  async verifyEmail(token: string) {
    const record = await this.coordinator.cacheGet<VerificationRecord>(`notification-verify:${token}`);
    if (!record || record.kind !== "EMAIL") throw new Error("VERIFICATION_TOKEN_INVALID");
    if (!await this.coordinator.consumeOnce("notification-verify", token, 3_600_000)) throw new Error("VERIFICATION_TOKEN_USED");
    const channel = await this.repository.getChannel(record.channelId, record.userId);
    if (!channel) throw new Error("NOTIFICATION_CHANNEL_NOT_FOUND");
    channel.verified = true;
    await this.repository.saveChannel(channel);
    return this.publicChannel(channel);
  }

  async addTelegram(userId: string) {
    const channel: StoredChannel = { id: randomUUID(), userId, type: "TELEGRAM", label: "Telegram pending", verified: false, createdAt: new Date().toISOString(), destination: null };
    await this.repository.saveChannel(channel);
    const token = randomBytes(18).toString("base64url");
    await this.coordinator.cacheSet<VerificationRecord>(`telegram-connect:${token}`, { channelId: channel.id, userId, kind: "TELEGRAM" }, 900);
    return { channel: this.publicChannel(channel), connectUrl: `https://t.me/${this.telegramBotName}?start=${token}` };
  }

  async connectTelegram(token: string, chatId: string) {
    const record = await this.coordinator.cacheGet<VerificationRecord>(`telegram-connect:${token}`);
    if (!record || record.kind !== "TELEGRAM") throw new Error("TELEGRAM_TOKEN_INVALID");
    if (!await this.coordinator.consumeOnce("telegram-connect", token, 900_000)) throw new Error("TELEGRAM_TOKEN_USED");
    const channel = await this.repository.getChannel(record.channelId, record.userId);
    if (!channel) throw new Error("NOTIFICATION_CHANNEL_NOT_FOUND");
    channel.label = `Telegram · ${chatId.slice(-4)}`;
    channel.verified = true;
    channel.destination = await this.vault.encryptJson(record.userId, "notification-telegram", { chatId });
    await this.repository.saveChannel(channel);
    return this.publicChannel(channel);
  }

  async addWebPush(userId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    const channel: StoredChannel = {
      id: randomUUID(), userId, type: "WEB_PUSH", label: "This browser", verified: true, createdAt: new Date().toISOString(),
      destination: await this.vault.encryptJson(userId, "notification-web-push", subscription),
    };
    await this.repository.saveChannel(channel);
    return this.publicChannel(channel);
  }

  async listChannels(userId: string) {
    await this.ensureInApp(userId);
    return (await this.repository.listChannels(userId)).map((channel) => this.publicChannel(channel));
  }

  async removeChannel(userId: string, id: string) {
    const channel = await this.repository.getChannel(id, userId);
    if (!channel || channel.type === "IN_APP") throw new Error("NOTIFICATION_CHANNEL_NOT_REMOVABLE");
    await this.repository.deleteChannel(id, userId);
  }

  async emit(userId: string, input: Omit<PlatformNotification, "id" | "userId" | "createdAt" | "readAt">, dedupeKey: string) {
    const unique = await this.coordinator.consumeOnce("notification-dedupe", `${userId}:${dedupeKey}`, 24 * 60 * 60_000);
    if (!unique) return null;
    await this.ensureInApp(userId);
    const notification: PlatformNotification = { ...input, id: randomUUID(), userId, readAt: null, createdAt: new Date().toISOString() };
    await this.repository.saveNotification(notification);
    await this.coordinator.publish(`notifications:${userId}`, notification);
    for (const channel of await this.repository.listChannels(userId)) {
      if (channel.type !== "IN_APP" && channel.verified) {
        await this.coordinator.enqueueNotification({ id: randomUUID(), notificationId: notification.id, userId, channelId: channel.id, attempt: 0, runAt: new Date().toISOString() });
      }
    }
    return notification;
  }

  private publicChannel(channel: StoredChannel): NotificationChannel {
    return { id: channel.id, type: channel.type, label: channel.label, verified: channel.verified, createdAt: channel.createdAt };
  }
}

export class NotificationWorker {
  private readonly retryDelays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

  constructor(
    private readonly repository: PlatformRepository,
    private readonly coordinator: Coordinator,
    private readonly vault: EnvelopeVault,
    private readonly sender: NotificationSender,
    private readonly onDelivered?: (latencySeconds: number) => void,
  ) {}

  async runOne(now = new Date()) {
    const job = await this.coordinator.claimNotification(now);
    if (!job) return false;
    const channel = await this.repository.getChannel(job.channelId, job.userId);
    const notification = (await this.repository.listNotifications(job.userId, 100)).find((item) => item.id === job.notificationId);
    if (!channel || !channel.verified || !channel.destination || !notification) {
      await this.coordinator.completeNotification(job.id);
      return true;
    }
    const purpose = channel.type === "EMAIL" ? "notification-email"
      : channel.type === "TELEGRAM" ? "notification-telegram" : "notification-web-push";
    try {
      const destination = await this.vault.decryptJson<ChannelDestination>(job.userId, purpose, channel.destination);
      const providerMessage = await this.sender.send(channel, destination, notification);
      await this.repository.saveNotificationAttempt(this.attempt(job, "DELIVERED", providerMessage));
      await this.coordinator.completeNotification(job.id);
      this.onDelivered?.(Math.max(0, (Date.now() - new Date(notification.createdAt).getTime()) / 1_000));
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "DELIVERY_FAILED";
      const nextAttempt = job.attempt + 1;
      if (nextAttempt >= this.retryDelays.length) {
        await this.repository.saveNotificationAttempt(this.attempt(job, "DEAD_LETTER", message));
        await this.coordinator.deadLetterNotification({ ...job, attempt: nextAttempt });
      } else {
        await this.repository.saveNotificationAttempt(this.attempt(job, "FAILED", message));
        await this.coordinator.retryNotification({ ...job, attempt: nextAttempt, runAt: new Date(now.getTime() + this.retryDelays[nextAttempt - 1]).toISOString() });
      }
    }
    return true;
  }

  private attempt(job: NotificationJob, status: NotificationAttempt["status"], providerMessage: string): NotificationAttempt {
    return { id: randomUUID(), notificationId: job.notificationId, channelId: job.channelId, attempt: job.attempt + 1,
      status, providerMessage, attemptedAt: new Date().toISOString() };
  }
}
