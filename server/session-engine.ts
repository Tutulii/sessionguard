import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import type { MarketSession } from "../shared/types.js";

export const NEW_YORK_TZ = "America/New_York";

const SPECIAL_CLOSURES = new Set(["2025-01-09"]);

function shiftDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function weekday(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nthWeekday(year: number, month: number, targetDay: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const delta = (targetDay - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + delta + (nth - 1) * 7)).toISOString().slice(0, 10);
}

function lastWeekday(year: number, month: number, targetDay: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const delta = (last.getUTCDay() - targetDay + 7) % 7;
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - delta)).toISOString().slice(0, 10);
}

function observedDate(year: number, month: number, day: number): string {
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (actual.getUTCDay() === 6) actual.setUTCDate(actual.getUTCDate() - 1);
  if (actual.getUTCDay() === 0) actual.setUTCDate(actual.getUTCDate() + 1);
  return actual.toISOString().slice(0, 10);
}

// Meeus/Jones/Butcher Gregorian Easter calculation.
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export function isNyseHoliday(isoDate: string): boolean {
  if (SPECIAL_CLOSURES.has(isoDate)) return true;
  const year = Number(isoDate.slice(0, 4));
  const holidays = new Set([
    observedDate(year, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    shiftDate(easterSunday(year), -2),
    lastWeekday(year, 5, 1),
    observedDate(year, 6, 19),
    observedDate(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observedDate(year, 12, 25),
  ]);
  // A Saturday New Year's Day is observed on the prior calendar year.
  holidays.add(observedDate(year + 1, 1, 1));
  return holidays.has(isoDate);
}

export function isEarlyClose(isoDate: string): boolean {
  const year = Number(isoDate.slice(0, 4));
  const day = weekday(isoDate);
  if (day === 0 || day === 6 || isNyseHoliday(isoDate)) return false;
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const fridayAfterThanksgiving = shiftDate(thanksgiving, 1);
  const christmasEve = `${year}-12-24`;
  const julyThird = `${year}-07-03`;
  return isoDate === fridayAfterThanksgiving || isoDate === christmasEve || isoDate === julyThird;
}

function localParts(at: Date) {
  const isoDate = formatInTimeZone(at, NEW_YORK_TZ, "yyyy-MM-dd");
  const hour = Number(formatInTimeZone(at, NEW_YORK_TZ, "HH"));
  const minute = Number(formatInTimeZone(at, NEW_YORK_TZ, "mm"));
  return { isoDate, weekday: weekday(isoDate), minutes: hour * 60 + minute };
}

export function isCashBusinessDay(at: Date): boolean {
  const parts = localParts(at);
  return parts.weekday !== 0 && parts.weekday !== 6 && !isNyseHoliday(parts.isoDate);
}

export function classifyMarketSession(at = new Date()): MarketSession {
  const { isoDate, minutes } = localParts(at);
  if (!isCashBusinessDay(at)) return "WEEKEND_HOLIDAY";
  const closeMinutes = isEarlyClose(isoDate) ? 13 * 60 : 16 * 60;
  if (minutes >= 9 * 60 + 30 && minutes < closeMinutes) return "CASH_OPEN";
  if ((minutes >= 4 * 60 && minutes < 9 * 60 + 30) || (minutes >= closeMinutes && minutes < 20 * 60)) {
    return "EXTENDED";
  }
  return "CLOSED";
}

export function cashCloseForDate(at: Date): Date {
  const isoDate = formatInTimeZone(at, NEW_YORK_TZ, "yyyy-MM-dd");
  const hour = isEarlyClose(isoDate) ? "13:00:00" : "16:00:00";
  return fromZonedTime(`${isoDate}T${hour}`, NEW_YORK_TZ);
}

export function previousCashClose(at = new Date()): Date {
  const currentDate = formatInTimeZone(at, NEW_YORK_TZ, "yyyy-MM-dd");
  for (let offset = 0; offset < 14; offset += 1) {
    const isoDate = shiftDate(currentDate, -offset);
    const noon = fromZonedTime(`${isoDate}T12:00:00`, NEW_YORK_TZ);
    if (!isCashBusinessDay(noon)) continue;
    const close = fromZonedTime(`${isoDate}T${isEarlyClose(isoDate) ? "13:00:00" : "16:00:00"}`, NEW_YORK_TZ);
    if (close.getTime() <= at.getTime()) return close;
  }
  throw new Error("Unable to locate a prior cash close");
}

export function nextCashOpen(at = new Date()): Date {
  const currentDate = formatInTimeZone(at, NEW_YORK_TZ, "yyyy-MM-dd");
  for (let offset = 0; offset < 14; offset += 1) {
    const isoDate = shiftDate(currentDate, offset);
    const noon = fromZonedTime(`${isoDate}T12:00:00`, NEW_YORK_TZ);
    if (!isCashBusinessDay(noon)) continue;
    const open = fromZonedTime(`${isoDate}T09:30:00`, NEW_YORK_TZ);
    if (open.getTime() > at.getTime()) return open;
  }
  throw new Error("Unable to locate the next cash open");
}

export function marketClockLabel(at = new Date()): string {
  return formatInTimeZone(at, NEW_YORK_TZ, "EEE, MMM d · h:mm:ss a 'ET'");
}
