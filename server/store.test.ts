import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replayScenarios } from "../shared/replays.js";
import { evaluatePermission } from "./rules.js";
import { DecisionStore } from "./store.js";

const directories: string[] = [];

describe("sanitized SQLite audit store", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("deduplicates events and persists a receipt across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "sessionguard-store-"));
    directories.push(directory);
    const path = join(directory, "audit.sqlite");
    const scenario = replayScenarios[0];
    const decision = evaluatePermission({ snapshot: scenario.snapshot, assessment: scenario.assessment, intent: scenario.intent });
    const first = new DecisionStore(path);
    first.saveEvent(scenario.event);
    first.saveEvent(scenario.event);
    first.saveDecision(decision, scenario.event, "public");
    expect(first.listEvents()).toHaveLength(1);
    first.close();

    const reopened = new DecisionStore(path);
    expect(reopened.getReceipt(decision.id)?.decision.verdict).toBe("BLOCK");
    expect(reopened.listReceipts("public")).toHaveLength(1);
    reopened.close();
  });

  it("keeps private session receipts scoped while including public replay proof", () => {
    const store = new DecisionStore(":memory:");
    const scenario = replayScenarios[1];
    const publicDecision = evaluatePermission({ snapshot: scenario.snapshot, assessment: scenario.assessment, intent: scenario.intent });
    const privateDecision = { ...publicDecision, id: "private-decision" };
    store.saveDecision(publicDecision, scenario.event, "public");
    store.saveDecision(privateDecision, scenario.event, "session-a");
    expect(store.listReceipts("session-b")).toHaveLength(1);
    expect(store.listReceipts("session-a")).toHaveLength(2);
    store.close();
  });

  it("never persists short-lived execution capabilities", () => {
    const store = new DecisionStore(":memory:");
    const scenario = replayScenarios[1];
    const decision = evaluatePermission({ snapshot: scenario.snapshot, assessment: scenario.assessment, intent: scenario.intent });
    decision.decisionToken = "sensitive-single-use-token";
    decision.tokenExpiresAt = new Date(Date.now() + 60_000).toISOString();
    store.saveDecision(decision, scenario.event, "public");
    expect(store.getReceipt(decision.id)?.decision.decisionToken).toBeUndefined();
    expect(JSON.stringify(store.listReceipts("public"))).not.toContain("sensitive-single-use-token");
    store.close();
  });
});
