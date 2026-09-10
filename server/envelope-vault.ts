import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import type { PersistentDemoConnectInput } from "../shared/production-types.js";
import type { DemoConnectionRecord, EnvelopeRecord, PlatformRepository } from "./platform-repository.js";

export interface DataKeyManager {
  readonly provider: string;
  generateDataKey(context: Record<string, string>): Promise<{ plaintext: Buffer; encrypted: Buffer }>;
  decryptDataKey(encrypted: Buffer, context: Record<string, string>): Promise<Buffer>;
}

function aad(userId: string, purpose: string) {
  return Buffer.from(`sessionguard:v1:${userId}:${purpose}`, "utf8");
}

export class LocalDataKeyManager implements DataKeyManager {
  readonly provider = "LOCAL_TEST_KMS";
  private readonly wrappingKey: Buffer;

  constructor(masterKey: string) {
    if (masterKey.length < 32) throw new Error("LOCAL_KMS_MASTER_KEY must contain at least 32 characters");
    this.wrappingKey = createHash("sha256").update(masterKey).digest();
  }

  async generateDataKey(context: Record<string, string>) {
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.wrappingKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(context)));
    const encrypted = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { plaintext, encrypted };
  }

  async decryptDataKey(encrypted: Buffer, context: Record<string, string>) {
    if (encrypted.length < 29) throw new Error("Encrypted data key is malformed");
    const iv = encrypted.subarray(0, 12);
    const tag = encrypted.subarray(encrypted.length - 16);
    const payload = encrypted.subarray(12, encrypted.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", this.wrappingKey, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(context)));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  }
}

export class AwsKmsDataKeyManager implements DataKeyManager {
  readonly provider = "AWS_KMS";
  private readonly client: KMSClient;

  constructor(private readonly keyId: string, region: string) {
    if (!keyId) throw new Error("KMS_KEY_ID is required");
    this.client = new KMSClient({ region });
  }

  async generateDataKey(context: Record<string, string>) {
    const result = await this.client.send(new GenerateDataKeyCommand({
      KeyId: this.keyId,
      KeySpec: "AES_256",
      EncryptionContext: context,
    }));
    if (!result.Plaintext || !result.CiphertextBlob) throw new Error("KMS did not return a complete data key");
    return { plaintext: Buffer.from(result.Plaintext), encrypted: Buffer.from(result.CiphertextBlob) };
  }

  async decryptDataKey(encrypted: Buffer, context: Record<string, string>) {
    const result = await this.client.send(new DecryptCommand({
      KeyId: this.keyId,
      CiphertextBlob: encrypted,
      EncryptionContext: context,
    }));
    if (!result.Plaintext) throw new Error("KMS did not decrypt the data key");
    return Buffer.from(result.Plaintext);
  }
}

export class EnvelopeVault {
  constructor(private readonly keyManager: DataKeyManager) {}

  async encryptJson(userId: string, purpose: string, value: unknown): Promise<EnvelopeRecord> {
    const context = { application: "sessionguard", userId, purpose };
    const { plaintext: dataKey, encrypted } = await this.keyManager.generateDataKey(context);
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
      cipher.setAAD(aad(userId, purpose));
      const cipherText = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return {
        cipherText: cipherText.toString("base64url"),
        iv: iv.toString("base64url"),
        authTag: cipher.getAuthTag().toString("base64url"),
        encryptedDataKey: encrypted.toString("base64url"),
        keyProvider: this.keyManager.provider,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
    } finally {
      dataKey.fill(0);
    }
  }

  async decryptJson<T>(userId: string, purpose: string, record: EnvelopeRecord): Promise<T> {
    if (record.version !== 1) throw new Error("Unsupported envelope version");
    if (record.keyProvider !== this.keyManager.provider) throw new Error("Envelope key provider mismatch");
    const context = { application: "sessionguard", userId, purpose };
    const dataKey = await this.keyManager.decryptDataKey(Buffer.from(record.encryptedDataKey, "base64url"), context);
    try {
      const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(record.iv, "base64url"));
      decipher.setAAD(aad(userId, purpose));
      decipher.setAuthTag(Buffer.from(record.authTag, "base64url"));
      const clear = Buffer.concat([
        decipher.update(Buffer.from(record.cipherText, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(clear) as T;
    } finally {
      dataKey.fill(0);
    }
  }
}

export class PersistentCredentialVault {
  constructor(private readonly repository: PlatformRepository, private readonly envelope: EnvelopeVault) {}

  async save(userId: string, credentials: PersistentDemoConnectInput, executionEnabled: boolean) {
    const previous = await this.repository.getConnection(userId);
    const now = new Date().toISOString();
    const record: DemoConnectionRecord = {
      userId,
      envelope: await this.envelope.encryptJson(userId, "bitget-demo-credentials", credentials),
      executionEnabled,
      lastValidatedAt: now,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.repository.saveConnection(record);
    return record;
  }

  async read(userId: string) {
    const record = await this.repository.getConnection(userId);
    if (!record) return null;
    return {
      credentials: await this.envelope.decryptJson<PersistentDemoConnectInput>(userId, "bitget-demo-credentials", record.envelope),
      executionEnabled: record.executionEnabled,
      lastValidatedAt: record.lastValidatedAt,
    };
  }

  async destroy(userId: string) { await this.repository.deleteConnection(userId); }
}
