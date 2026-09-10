import { describe, expect, it, vi } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { EnvelopeVault, LocalDataKeyManager } from "./envelope-vault.js";
import { NotificationService, NotificationWorker, type NotificationSender } from "./notifications.js";
import { SqlitePlatformRepository } from "./platform-repository.js";

describe("production notifications", () => {
  it("verifies email, emits durable in-app state, and queues external delivery", async () => {
    const repository = new SqlitePlatformRepository();
    const coordinator = new MemoryCoordinator();
    await repository.init();
    const user = await repository.createOrLoginUser("0x1111111111111111111111111111111111111111", 500);
    const vault = new EnvelopeVault(new LocalDataKeyManager("notification-test-master-key-more-than-32-characters"));
    const service = new NotificationService(repository, coordinator, vault, "https://sessionguard.test");
    const created = await service.addEmail(user.id, "person@example.com");
    expect(created.channel.verified).toBe(false);
    const token = new URL(created.verificationUrl!).searchParams.get("token")!;
    expect((await service.verifyEmail(token)).verified).toBe(true);
    await service.emit(user.id, { kind: "DECISION_BLOCKED", severity: "WARNING", title: "Blocked", body: "Cash market dark" }, "decision-1");
    expect(await repository.listNotifications(user.id, 10)).toHaveLength(1);
    const send = vi.fn(async () => "provider-id");
    const sender: NotificationSender = { send };
    const worker = new NotificationWorker(repository, coordinator, vault, sender);
    expect(await worker.runOne()).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    await repository.close();
  });

  it("deduplicates identical alerts", async () => {
    const repository = new SqlitePlatformRepository();
    const coordinator = new MemoryCoordinator();
    await repository.init();
    const user = await repository.createOrLoginUser("0x2222222222222222222222222222222222222222", 500);
    const service = new NotificationService(repository, coordinator,
      new EnvelopeVault(new LocalDataKeyManager("notification-dedupe-master-key-more-than-32-chars")), "https://sessionguard.test");
    const payload = { kind: "SESSION_TRANSITION" as const, severity: "INFO" as const, title: "Open", body: "Cash session open" };
    await service.emit(user.id, payload, "session-open");
    await service.emit(user.id, payload, "session-open");
    expect(await repository.listNotifications(user.id, 10)).toHaveLength(1);
    await repository.close();
  });
});
