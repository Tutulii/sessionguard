import { afterEach, describe, expect, it } from "vitest";
import { createProductionApp } from "./production-app.js";

describe("public-beta cached API load smoke", () => {
  let app: Awaited<ReturnType<typeof createProductionApp>> | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it("keeps replay snapshot p95 below the 300 ms objective under 100 concurrent requests", async () => {
    app = await createProductionApp({ production: false, appOrigin: "http://localhost" });
    const durations: number[] = [];
    const responses = await Promise.all(Array.from({ length: 100 }, async () => {
      const started = performance.now();
      const response = await app!.inject({ method: "GET", url: "/api/v1/market/snapshots/RNVDAUSDT?mode=REPLAY&replayId=cash-nvidia" });
      durations.push(performance.now() - started);
      return response;
    }));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * .95) - 1];
    expect(p95).toBeLessThan(300);
  });
});
