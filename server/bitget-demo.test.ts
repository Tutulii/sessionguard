import { MockServer, seedState } from "@bitget-ai/bitget-agent-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeDemoOrder, simulateWithOfficialSdk, validateDemoCredentials } from "./bitget-demo.js";
import { isRealityInstrument } from "./production-bitget.js";

describe("official Bitget SDK paper boundary", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = new MockServer();
    await mock.start();
    seedState(mock.getState());
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("validates credentials with a real authenticated SDK read", async () => {
    const result = await validateDemoCredentials({ apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" }, mock.baseUrl);
    expect(Array.isArray(result.account)).toBe(true);
    expect(result.rTokenTradingSupported).toBe(false);
  });

  it("accepts Bitget current yes reality marker only for the exact online instrument", () => {
    expect(isRealityInstrument({ symbol: "RNVDAUSDT", isReality: "yes", status: "online" }, "RNVDAUSDT")).toBe(true);
    expect(isRealityInstrument({ symbol: "RNVDAUSDT", isReality: "no", status: "online" }, "RNVDAUSDT")).toBe(false);
    expect(isRealityInstrument({ symbol: "RNVDAUSDT", isReality: "yes", status: "offline" }, "RNVDAUSDT")).toBe(false);
    expect(isRealityInstrument({ symbol: "RTSLAUSDT", isReality: "yes", status: "online" }, "RNVDAUSDT")).toBe(false);
  });

  it("places only a paper-configured market order through the intent tool", async () => {
    const result = await placeDemoOrder({
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
      symbol: "RNVDAUSDT",
      side: "buy",
      notionalUsd: 150,
      rTokenPrice: 188.44,
      baseUrl: mock.baseUrl,
    });
    expect(result.orderId).toBeTruthy();
    expect([...mock.getState().orders.values()][0]).toMatchObject({ symbol: "RNVDAUSDT", side: "buy", orderType: "market" });
  });

  it("uses the SDK's hermetic simulator for judge replay execution", async () => {
    const result = await simulateWithOfficialSdk({ symbol: "RNVDAUSDT", side: "buy", notionalUsd: 100, rTokenPrice: 188.44 });
    expect(result.orderId).toBeTruthy();
  });
});
