import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialVault, hashSession } from "./credential-vault.js";

const credentials = { apiKey: "api-super-secret", secretKey: "secret-super-secret", passphrase: "pass-super-secret" };

describe("ephemeral credential vault", () => {
  afterEach(() => vi.useRealTimers());

  it("stores encrypted material and returns it only through the session id", () => {
    const vault = new CredentialVault("master-key", 1000);
    const id = vault.create(credentials);
    expect(vault.read(id)).toEqual(credentials);
    expect(JSON.stringify(vault)).not.toContain(credentials.apiKey);
    expect(hashSession(id)).not.toContain(id);
  });

  it("expires and destroys credentials", () => {
    vi.useFakeTimers();
    const vault = new CredentialVault("master-key", 1000);
    const id = vault.create(credentials);
    vi.advanceTimersByTime(1001);
    expect(vault.read(id)).toBeNull();
    const next = vault.create(credentials);
    vault.destroy(next);
    expect(vault.read(next)).toBeNull();
  });
});
