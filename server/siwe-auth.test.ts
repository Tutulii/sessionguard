import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { MemoryCoordinator } from "./coordinator.js";
import { SqlitePlatformRepository } from "./platform-repository.js";
import { SiweAuthService } from "./siwe-auth.js";

describe("SIWE production authentication", () => {
  it("authenticates Arbitrum ownership and rejects replay", async () => {
    const repository = new SqlitePlatformRepository();
    const coordinator = new MemoryCoordinator();
    await repository.init();
    const auth = new SiweAuthService(repository, coordinator, "https://sessionguard.test");
    const wallet = Wallet.createRandom();
    const challenge = await auth.createChallenge(wallet.address);
    const signature = await wallet.signMessage(challenge.message);
    const verified = await auth.verify(challenge.message, signature);
    expect(verified.user.address).toBe(wallet.address.toLowerCase());
    expect((await auth.authenticate(verified.session.id))?.user.id).toBe(verified.user.id);
    await expect(auth.verify(challenge.message, signature)).rejects.toThrow("SIWE_NONCE_INVALID_OR_USED");
    await repository.close();
  });

  it("enforces the 500-user cap for new wallets", async () => {
    const repository = new SqlitePlatformRepository();
    const coordinator = new MemoryCoordinator();
    await repository.init();
    const auth = new SiweAuthService(repository, coordinator, "https://sessionguard.test", 0);
    const wallet = Wallet.createRandom();
    const challenge = await auth.createChallenge(wallet.address);
    await expect(auth.verify(challenge.message, await wallet.signMessage(challenge.message))).rejects.toThrow("PUBLIC_BETA_CAP_REACHED");
    await repository.close();
  });
});
