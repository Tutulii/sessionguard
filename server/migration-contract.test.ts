import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentSchemaSql, agentSchemaVersion } from "./agent-postgres-schema.js";
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

  it("keeps the agent runtime, dedupe, and timestamp-repair migrations reviewable", () => {
    const runtime = readFileSync(new URL("../migrations/0002_agent_runtime.sql", import.meta.url), "utf8");
    const dedupe = readFileSync(new URL("../migrations/0003_trigger_dedupe_state.sql", import.meta.url), "utf8");
    const timestamps = readFileSync(new URL("../migrations/0004_canonical_job_timestamps.sql", import.meta.url), "utf8");
    for (const table of ["official_events", "agent_settings", "agent_triggers", "agent_runs", "agent_jobs", "agent_outcomes"]) {
      expect(runtime).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(agentSchemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(dedupe).toContain("CREATE TABLE IF NOT EXISTS agent_collateral_risk_states");
    expect(agentSchemaSql).toContain("CREATE TABLE IF NOT EXISTS agent_collateral_risk_states");
    expect(timestamps).toContain("UPDATE agent_jobs SET job_json=job_json || jsonb_build_object");
    expect(timestamps).toContain("AT TIME ZONE 'UTC'");
    expect(agentSchemaSql).toContain("AT TIME ZONE 'UTC'");
    expect(timestamps).toContain(`'${agentSchemaVersion}'`);
  });
});
