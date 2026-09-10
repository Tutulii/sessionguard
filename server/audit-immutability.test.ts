import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqlitePlatformRepository } from "./platform-repository.js";

describe("immutable audit retention", () => {
  it("rejects mutation and early deletion of audit evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sessionguard-audit-"));
    const path = join(directory, "audit.sqlite");
    try {
      const repository = new SqlitePlatformRepository(path); await repository.init();
      const user = await repository.createOrLoginUser("0x6666666666666666666666666666666666666666", 500);
      await repository.saveAudit(user.id, "TEST_EVIDENCE", user.id, { immutable: true });
      const database = new DatabaseSync(path);
      const id = String((database.prepare("SELECT id FROM audit_events LIMIT 1").get() as { id: string }).id);
      expect(() => database.prepare("UPDATE audit_events SET action='TAMPERED' WHERE id=?").run(id)).toThrow("AUDIT_EVENTS_IMMUTABLE");
      expect(() => database.prepare("DELETE FROM audit_events WHERE id=?").run(id)).toThrow("AUDIT_EVENTS_RETAINED");
      database.close(); await repository.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
