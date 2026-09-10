import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSchemaSql, productionSchemaVersion } from "./postgres-schema.js";

describe("reviewable production migration", () => {
  it("matches the runtime schema contract and includes retention/immutability controls", () => {
    const migration = readFileSync(new URL("../migrations/0001_production_platform.sql", import.meta.url), "utf8");
    for (const table of ["users", "wallets", "bitget_connections", "policies", "watchlists", "market_anchors",
      "market_aggregates", "portfolio_snapshots", "decisions_v1", "paper_orders", "notification_channels",
      "notifications", "notification_attempts", "audit_events"]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(productionSchemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration).toContain("CREATE OR REPLACE FUNCTION sessionguard_protect_audit_events() RETURNS trigger AS $");
    expect(productionSchemaSql).toContain("CREATE OR REPLACE FUNCTION sessionguard_protect_audit_events() RETURNS trigger AS $");
    expect(migration).toContain("sessionguard_protect_audit_events");
    expect(productionSchemaSql).toContain("sessionguard_protect_audit_events");
    expect(migration).toContain(`'${productionSchemaVersion}'`);
  });
});
