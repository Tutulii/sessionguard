import { describe, expect, it } from "vitest";
import { EnvelopeVault, LocalDataKeyManager, PersistentCredentialVault } from "./envelope-vault.js";
import { SqlitePlatformRepository } from "./platform-repository.js";

describe("production envelope vault", () => {
  it("persists only an authenticated envelope and decrypts on demand", async () => {
    const repository = new SqlitePlatformRepository();
    await repository.init();
    const user = await repository.createOrLoginUser("0x1111111111111111111111111111111111111111", 500);
    const envelope = new EnvelopeVault(new LocalDataKeyManager("a-test-master-key-with-more-than-32-characters"));
    const vault = new PersistentCredentialVault(repository, envelope);
    const credentials = { apiKey: "secret-api-key", secretKey: "secret-secret-key", passphrase: "secret-passphrase" };
    await vault.save(user.id, credentials, true);
    const raw = await repository.getConnection(user.id);
    expect(JSON.stringify(raw)).not.toContain(credentials.apiKey);
    expect(JSON.stringify(raw)).not.toContain(credentials.secretKey);
    expect(await vault.read(user.id)).toMatchObject({ credentials, executionEnabled: true });
    await vault.destroy(user.id);
    expect(await vault.read(user.id)).toBeNull();
    await repository.close();
  });

  it("binds encrypted values to their user and purpose", async () => {
    const vault = new EnvelopeVault(new LocalDataKeyManager("another-test-master-key-with-32-characters"));
    const encrypted = await vault.encryptJson("user-a", "email", { email: "person@example.com" });
    await expect(vault.decryptJson("user-b", "email", encrypted)).rejects.toThrow();
    await expect(vault.decryptJson("user-a", "telegram", encrypted)).rejects.toThrow();
  });
});
