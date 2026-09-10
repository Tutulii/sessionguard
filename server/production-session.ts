import { formatInTimeZone } from "date-fns-tz";
import type { ProductionSession } from "../shared/production-types.js";
import { isEarlyClose, isNyseHoliday, NEW_YORK_TZ, nextCashOpen, previousCashClose } from "./session-engine.js";

function parts(at: Date) {
  const isoDate = formatInTimeZone(at, NEW_YORK_TZ, "yyyy-MM-dd");
  const weekday = Number(formatInTimeZone(at, NEW_YORK_TZ, "i"));
  const hour = Number(formatInTimeZone(at, NEW_YORK_TZ, "HH"));
  const minute = Number(formatInTimeZone(at, NEW_YORK_TZ, "mm"));
  return { isoDate, weekday, minutes: hour * 60 + minute };
}

export function classifyProductionSession(at = new Date(), marketAvailable = true): ProductionSession {
  if (!marketAvailable) return "MARKET_UNAVAILABLE";
  const local = parts(at);
  if (local.weekday === 6 || local.weekday === 7) return "WEEKEND";
  if (isNyseHoliday(local.isoDate)) return "HOLIDAY";
  const close = isEarlyClose(local.isoDate) ? 13 * 60 : 16 * 60;
  if (local.minutes >= 9 * 60 + 30 && local.minutes < close) return "CASH_OPEN";
  // In SessionGuard, EXTENDED means any weekday period outside the cash auction.
  // It does not claim that an underlying exchange venue is currently accepting orders.
  return "EXTENDED";
}

export function productionSessionDate(at = new Date()) {
  return formatInTimeZone(at, NEW_YORK_TZ, "yyyy-MM-dd");
}

export const ANCHOR_CAPTURE_GRACE_MS = 2 * 60_000;

export function anchorCloseForCapture(at = new Date()) {
  const candidate = previousCashClose(at);
  return at.getTime() - candidate.getTime() < ANCHOR_CAPTURE_GRACE_MS
    ? previousCashClose(new Date(candidate.getTime() - 1))
    : candidate;
}

export function previousAnchorSessionDate(at = new Date()) {
  return formatInTimeZone(anchorCloseForCapture(at), NEW_YORK_TZ, "yyyy-MM-dd");
}

export { nextCashOpen, previousCashClose };
