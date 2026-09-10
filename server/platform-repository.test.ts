import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GuardDecision, PaperOrderReceiptV1 } from "../shared/production-types.js";
import { SqlitePlatformRepository } from "./platform-repository.js";

const at = "2026-09-09T12:00:00.000Z";

function decision(userId: string, id = randomUUID()): GuardDecision {
  return {
    id, userId, createdAt: at, permission: "TRADE", symbol: "RNVDAUSDT", side: "buy",
    requestedNotionalCents: 25_000, allowedNotionalCents: 25_000, maxSlippageBps: 50,
    reasonCodes: ["CASH_OPEN"], reasons: ["Fresh cash-session inputs passed."], gapScenarios: [],
    policyVersion: "2026-09-09.1:default", inputHash: "a".repeat(64), marketHash: "b".repeat(64),
    portfolioHash: "c".repeat(64), portfolioCapturedAt: at, dataMode: "REPLAY",
    snapshot: {
      symbol: "RNVDAUSDT", displaySymbol: "rNVDA", underlyingSymbol: "NVDA", companyName: "NVIDIA", sourceLabel: "REPLAY", rTokenPriceMicros: 180_000_000, bidPriceMicros: 179_900_000, askPriceMicros: 180_100_000,
      anchorPriceMicros: 179_000_000, offHoursMoveBps: 55.9, spreadBps: 10,
      session: "CASH_OPEN", source: "BITGET", dataMode: "REPLAY",
      referenceKind: "BITGET_CASH_SESSION_ANCHOR", referenceQuality: "OBSERVED",
      providerTimestamp: at, receivedTimestamp: at, quoteAgeMs: 0, referenceTimestamp: at,
nextCashOpen: "2026-09-10T13:30:00.000Z", chart: [],
    },
  };
}

function receipt(item: GuardDecision, index: number): PaperOrderReceiptV1 {
  return {
    id: randomUUID(), decisionId: item.id, userId: item.userId, clientOrderId: `sg_test_${index}`,
    executionMode: "LOCAL_REPLAY", status: "RESERVED", providerOrderId: null,
    message: "Reserved by repository test.", submittedAt: at, updatedAt: at, attemptCount: 0,
  };
}

describe("atomic paper-order repository limits", () => {
  it("reserves a decision idempotently without double counting it", async () => {
    const repository = new SqlitePlatformRepository();
    await repository.init();
    const user = await repository.createOrLoginUser("0x1111111111111111111111111111111111111111", 500);
    const item = decision(user.id);
    await repository.saveDecision(item);
    const order = receipt(item, 1);

    expect((await Promise.all([
      repository.reserveOrder(order, 25_000, "buy"),
      repository.reserveOrder(order, 25_000, "buy"),
    ])).map((result) => result.created)).toEqual([true, false]);
    expect(await repository.getDailyOrderUsage(user.id, "2026-09-09T00:00:00.000Z"))
      .toEqual({ count: 1, grossNewNotionalCents: 25_000 });
    await repository.close();
  });

  it("enforces gross-new-notional and count limits inside the reservation transaction", async () => {
    const repository = new SqlitePlatformRepository();
    await repository.init();
    const user = await repository.createOrLoginUser("0x2222222222222222222222222222222222222222", 500);

    for (let index = 0; index < 4; index += 1) {
      const item = decision(user.id); await repository.saveDecision(item);
      await repository.reserveOrder(receipt(item, index), 25_000, "buy");
    }
    const grossBlocked = decision(user.id); await repository.saveDecision(grossBlocked);
    await expect(repository.reserveOrder(receipt(grossBlocked, 5), 100, "buy"))
      .rejects.toThrow("DAILY_GROSS_NOTIONAL_LIMIT");

    for (let index = 4; index < 20; index += 1) {
      const item = decision(user.id); await repository.saveDecision(item);
      await repository.reserveOrder(receipt(item, index + 10), 100, "sell");
    }
    const countBlocked = decision(user.id); await repository.saveDecision(countBlocked);
    await expect(repository.reserveOrder(receipt(countBlocked, 99), 100, "sell"))
      .rejects.toThrow("DAILY_ORDER_COUNT_LIMIT");
    await repository.close();
  });

  it("does not charge a safely rejected pre-submission reservation against daily usage", async () => {
    const repository = new SqlitePlatformRepository();
    await repository.init();
    const user = await repository.createOrLoginUser("0x3333333333333333333333333333333333333333", 500);
    const item = decision(user.id); await repository.saveDecision(item);
    const order = receipt(item, 1);
    await repository.reserveOrder(order, 25_000, "buy");
    await repository.updateOrder({ ...order, status: "REJECTED", message: "Never submitted.", updatedAt: "2026-09-09T12:02:00.000Z" });
    expect(await repository.getDailyOrderUsage(user.id, "2026-09-09T00:00:00.000Z"))
      .toEqual({ count: 0, grossNewNotionalCents: 0 });
    await repository.close();
  });
});
