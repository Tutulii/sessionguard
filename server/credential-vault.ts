import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { DemoConnectInput } from "../shared/types.js";

type VaultEntry = {
  cipherText: string;
  iv: string;
  tag: string;
  expiresAt: number;
};

export class CredentialVault {
  private readonly entries = new Map<string, VaultEntry>();
  private readonly key: Buffer;
  private readonly ttlMs: number;

  constructor(masterKey: string, ttlMs = 30 * 60_000) {
    this.key = createHash("sha256").update(masterKey).digest();
    this.ttlMs = ttlMs;
  }

  create(credentials: DemoConnectInput): string {
    const id = randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const cipherText = Buffer.concat([
      cipher.update(JSON.stringify(credentials), "utf8"),
      cipher.final(),
    ]);
    this.entries.set(id, {
      cipherText: cipherText.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      expiresAt: Date.now() + this.ttlMs,
    });
    return id;
  }

  read(id: string): DemoConnectInput | null {
    const entry = this.entries.get(id);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return null;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(entry.iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(entry.tag, "base64url"));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(entry.cipherText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    entry.expiresAt = Date.now() + this.ttlMs;
    return JSON.parse(clear) as DemoConnectInput;
  }

  destroy(id: string) {
    this.entries.delete(id);
  }

  cleanup() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}

export function hashSession(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

