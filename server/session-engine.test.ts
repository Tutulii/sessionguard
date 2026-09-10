import { describe, expect, it } from "vitest";
import {
  cashCloseForDate,
  classifyMarketSession,
  isEarlyClose,
  isNyseHoliday,
  nextCashOpen,
  previousCashClose,
} from "./session-engine.js";

describe("NYSE-aware session engine", () => {
  it("separates cash, extended, weekday overnight, and weekend sessions", () => {
    expect(classifyMarketSession(new Date("2026-09-09T14:00:00Z"))).toBe("CASH_OPEN");
    expect(classifyMarketSession(new Date("2026-09-09T12:00:00Z"))).toBe("EXTENDED");
    expect(classifyMarketSession(new Date("2026-09-09T23:00:00Z"))).toBe("EXTENDED");
    expect(classifyMarketSession(new Date("2026-09-10T01:00:00Z"))).toBe("CLOSED");
    expect(classifyMarketSession(new Date("2026-09-13T18:42:00Z"))).toBe("WEEKEND_HOLIDAY");
  });

  it("recognizes calculated holidays and exceptional closures", () => {
    expect(isNyseHoliday("2026-09-07")).toBe(true);
    expect(isNyseHoliday("2026-11-26")).toBe(true);
    expect(isNyseHoliday("2025-01-09")).toBe(true);
    expect(isNyseHoliday("2026-09-08")).toBe(false);
  });

  it("uses the early close on the Friday after Thanksgiving", () => {
    expect(isEarlyClose("2026-11-27")).toBe(true);
    expect(cashCloseForDate(new Date("2026-11-27T17:00:00Z")).toISOString()).toBe("2026-11-27T18:00:00.000Z");
    expect(classifyMarketSession(new Date("2026-11-27T18:30:00Z"))).toBe("EXTENDED");
  });

  it("calculates prior close and next open correctly across US DST", () => {
    expect(previousCashClose(new Date("2026-03-08T18:00:00Z")).toISOString()).toBe("2026-03-06T21:00:00.000Z");
    expect(nextCashOpen(new Date("2026-03-08T18:00:00Z")).toISOString()).toBe("2026-03-09T13:30:00.000Z");
    expect(nextCashOpen(new Date("2026-11-01T18:00:00Z")).toISOString()).toBe("2026-11-02T14:30:00.000Z");
  });
});
