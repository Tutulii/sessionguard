import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayScenarios } from "../shared/replays.js";
import { assessWithQwen, unavailableAssessment } from "./qwen.js";

const originalKey = process.env.QWEN_API_KEY;

describe("structured Qwen adapter", () => {
  beforeEach(() => {
    process.env.QWEN_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = originalKey;
  });

  it("accepts only schema-valid JSON and preserves source evidence", async () => {
    const expected = replayScenarios[1].assessment;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(expected)}\n\`\`\`` } }] }), { status: 200 })));
    const result = await assessWithQwen(replayScenarios[1].event, 150);
    expect(result).toEqual(expected);
  });

  it("rejects invalid model output", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{\"summary\":\"missing fields\"}" } }] }), { status: 200 })));
    await expect(assessWithQwen(replayScenarios[1].event, 150)).rejects.toThrow();
  });

  it("surfaces network and timeout failures for the API fail-closed path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout"); }));
    await expect(assessWithQwen(replayScenarios[1].event, 150)).rejects.toThrow("timeout");
  });

  it("provides a zero-confidence HOLD fallback", () => {
    const result = unavailableAssessment(replayScenarios[1].event);
    expect(result).toMatchObject({ proposedAction: "HOLD", confidence: 0, novelty: "UNCLEAR" });
  });
});
