import { describe, expect, it } from "vitest";
import { PostgresAgentRepository } from "./agent-repository.js";
import { PostgresPlatformRepository } from "./postgres-repository.js";

describe("PostgreSQL pool resilience", () => {
  it("handles unexpected idle-client errors instead of crashing the process", async () => {
    const platform = new PostgresPlatformRepository("postgresql://invalid:invalid@127.0.0.1:1/invalid");
    const agent = new PostgresAgentRepository("postgresql://invalid:invalid@127.0.0.1:1/invalid");

    expect(platform.pool.listenerCount("error")).toBe(1);
    expect(agent.pool.listenerCount("error")).toBe(1);
    expect(() => platform.pool.emit("error", new Error("connection terminated"))).not.toThrow();
    expect(() => agent.pool.emit("error", new Error("connection terminated"))).not.toThrow();
    await platform.pool.end();
    await agent.pool.end();
  });
});
