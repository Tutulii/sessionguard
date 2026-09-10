import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { EnvelopeVault, LocalDataKeyManager } from "./envelope-vault.js";
import { NotificationService, NotificationWorker, type NotificationSender } from "./notifications.js";
import { SqlitePlatformRepository } from "./platform-repository.js";

describe("notification delivery reliability", () => {
  it("retries with backoff, exhausts into dead-letter state, and stops redelivery", async () => {
    const repository = new SqlitePlatformRepository(); const coordinator = new MemoryCoordinator(); await repository.init();
    const user = await repository.createOrLoginUser("0x5555555555555555555555555555555555555555", 500);
    const vault = new EnvelopeVault(new LocalDataKeyManager("notification-reliability-key-more-than-32-characters"));
    const service = new NotificationService(repository, coordinator, vault, "https://sessionguard.test");
    const created = await service.addEmail(user.id, "risk@example.com");
    await service.verifyEmail(new URL(created.verificationUrl!).searchParams.get("token")!);
    await service.emit(user.id, { kind: "CREDENTIAL", severity: "CRITICAL", title: "Provider down", body: "Fail closed." }, "provider-down");
    const send = vi.fn(async () => { throw new Error("provider unavailable"); });
    const worker = new NotificationWorker(repository, coordinator, vault, { send } satisfies NotificationSender);
    const times = [0, 61_000, 61_000 + 301_000, 61_000 + 301_000 + 901_000, 61_000 + 301_000 + 901_000 + 3_601_000];
    const origin = Date.now();
    for (const offset of times) expect(await worker.runOne(new Date(origin + offset))).toBe(true);
    expect(send).toHaveBeenCalledTimes(5);
    expect(await worker.runOne(new Date(origin + times.at(-1)! + 24 * 60 * 60_000))).toBe(false);
    await repository.close();
  });

  it("recovers a notification after a worker lease expires", async () => {
    const coordinator = new MemoryCoordinator(); const now = new Date();
    const job = { id: randomUUID(), notificationId: randomUUID(), userId: randomUUID(), channelId: randomUUID(), attempt: 0, runAt: now.toISOString() };
    await coordinator.enqueueNotification(job);
    expect(await coordinator.claimNotification(now)).toEqual(job);
    expect(await coordinator.claimNotification(new Date(now.getTime() + 59_999))).toBeNull();
    expect(await coordinator.claimNotification(new Date(now.getTime() + 60_000))).toEqual({ ...job, runAt: new Date(now.getTime() + 60_000).toISOString() });
  });
});
