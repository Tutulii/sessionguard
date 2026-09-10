import { describe, expect, it } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { EnvelopeVault, LocalDataKeyManager } from "./envelope-vault.js";
import { NotificationService } from "./notifications.js";
import { SqlitePlatformRepository } from "./platform-repository.js";

describe("verified production notification channels", () => {
  it("binds Telegram once, encrypts push destinations, and preserves tenant ownership", async () => {
    const repository = new SqlitePlatformRepository();
    const coordinator = new MemoryCoordinator();
    await repository.init();
    const first = await repository.createOrLoginUser("0x3333333333333333333333333333333333333333", 500);
    const other = await repository.createOrLoginUser("0x4444444444444444444444444444444444444444", 500);
    const vault = new EnvelopeVault(new LocalDataKeyManager("channel-verification-key-longer-than-32-characters"));
    const service = new NotificationService(repository, coordinator, vault, "https://sessionguard.test", "SessionGuardBot");
    try {
      await service.ensureInApp(first.id);
      const pending = await service.addTelegram(first.id);
      const token = new URL(pending.connectUrl).searchParams.get("start")!;
      const connected = await service.connectTelegram(token, "123456789012345");
      expect(connected).toMatchObject({ type: "TELEGRAM", verified: true });
      await expect(service.connectTelegram(token, "123456789012345")).rejects.toThrow("TELEGRAM_TOKEN_USED");
      expect(JSON.stringify(await repository.getChannel(connected.id, first.id))).not.toContain("123456789012345");

      const subscription = { endpoint: "https://push.example/subscription/private-token",
        keys: { p256dh: "browser-public-key", auth: "browser-auth-secret" } };
      const push = await service.addWebPush(first.id, subscription);
      expect(push).toMatchObject({ type: "WEB_PUSH", verified: true, label: "This browser" });
      expect(JSON.stringify(await repository.getChannel(push.id, first.id))).not.toContain(subscription.endpoint);
      expect((await service.listChannels(first.id)).map((channel) => channel.type).sort()).toEqual(["IN_APP", "TELEGRAM", "WEB_PUSH"]);
      await expect(service.removeChannel(other.id, push.id)).rejects.toThrow("NOTIFICATION_CHANNEL_NOT_REMOVABLE");
    } finally { await repository.close(); }
  });
});
