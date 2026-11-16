// ALL date-phrase rules live in this module. The LLM never does date math: it
// only classifies what was said ("kal" -> dayOffset -1 or +1 from tense,
// "next week" -> {kind:"weeks", amount:1}); this code turns that into dates.
//
// Every calendar date is computed in Asia/Kolkata (IST), never server UTC.
// India has no DST, so a fixed +05:30 offset is exact and needs no tz library.

export const IST_OFFSET_MINUTES = 330;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type DueKind = "days" | "weeks" | "months" | "weekday" | "date" | "unspecified";

// What the LLM returns for a follow-up's "when". Classification only.
export interface DuePhrase {
  kind: DueKind;
  amount: number | null; // days/weeks/months
  weekday: Weekday | null; // weekday
  day: number | null; // date: day of month
  month: number | null; // date: 1-12, null if not said
}

export interface ResolvedDue {
  date: string | null; // "YYYY-MM-DD" in IST
  rule: string; // which rule fired, for the audit trail
  pendingPartnerConfirmation: boolean;
}

// Rules not yet confirmed by the domain partner. Surfaced in the UI/audit so
// nobody mistakes a provisional rule for a business decision.
export const PENDING_RULES: Record<string, string> = {
  weeks: '"next week" = +7 days from the note date (pending partner confirmation)',
};

/** IST calendar date ("YYYY-MM-DD") of an instant. */
export function istDate(instant: Date): string {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE);
  return shifted.toISOString().slice(0, 10);
}

/** IST wall-clock time ("HH:MM") of an instant. */
export function istTime(instant: Date): string {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE);
  return shifted.toISOString().slice(11, 16);
}

function parseDate(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dateToUtcMs(date: string): number {
  const { y, m, d } = parseDate(date);
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, days: number): string {
  return formatUtcDate(dateToUtcMs(date) + days * MS_PER_DAY);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonths(date: string, months: number): string {
  const { y, m, d } = parseDate(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm)); // 31 Jan + 1 month -> 28/29 Feb
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(dateToUtcMs(date)).getUTCDay()];
}

/** The visit's IST date: note date + dayOffset ("kal mila tha" -> -1). */
export function resolveDayOffset(recordedAt: Date, dayOffset: number): string {
  return addDays(istDate(recordedAt), dayOffset);
}

/**
 * The instant to store as Event.occurredAt. Same-day visit with no stated
 * time -> the recording instant. Otherwise the stated IST time on the
 * resolved date, or 12:00 IST as a placeholder when no time was said.
 */
export function resolveOccurredAt(
  recordedAt: Date,
  dayOffset: number,
  time: string | null
): { occurredAt: Date; occurredOn: string; timeKnown: boolean } {
  const occurredOn = resolveDayOffset(recordedAt, dayOffset);
  if (time && /^\d{2}:\d{2}$/.test(time)) {
    return { occurredAt: istWallClockToInstant(occurredOn, time), occurredOn, timeKnown: true };
  }
  if (dayOffset === 0) {
    return { occurredAt: recordedAt, occurredOn, timeKnown: true };
  }
  return { occurredAt: istWallClockToInstant(occurredOn, "12:00"), occurredOn, timeKnown: false };
}

export function istWallClockToInstant(date: string, time: string): Date {
  const [hh, mm] = time.split(":").map(Number);
  return new Date(dateToUtcMs(date) + (hh * 60 + mm - IST_OFFSET_MINUTES) * MS_PER_MINUTE);
}

/** Resolve a follow-up "when" against the note's IST date. */
export function resolveDue(recordedAt: Date, due: DuePhrase | null): ResolvedDue {
  const today = istDate(recordedAt);
  if (!due || due.kind === "unspecified") {
    return { date: null, rule: "unspecified", pendingPartnerConfirmation: false };
  }

  switch (due.kind) {
    case "days": {
      if (due.amount === null) return unresolved("days without amount");
      return { date: addDays(today, due.amount), rule: `+${due.amount} days`, pendingPartnerConfirmation: false };
    }
    case "weeks": {
      if (due.amount === null) return unresolved("weeks without amount");
      return {
        date: addDays(today, 7 * due.amount),
        rule: `+${7 * due.amount} days (${due.amount} week${due.amount === 1 ? "" : "s"})`,
        pendingPartnerConfirmation: true,
      };
    }
    case "months": {
      if (due.amount === null) return unresolved("months without amount");
      return { date: addMonths(today, due.amount), rule: `+${due.amount} month(s)`, pendingPartnerConfirmation: false };
    }
    case "weekday": {
      if (!due.weekday) return unresolved("weekday without a day");
      // Next occurrence strictly after the note date: "Friday" said on a
      // Friday means next Friday.
      const target = WEEKDAYS.indexOf(due.weekday);
      const current = WEEKDAYS.indexOf(weekdayOf(today));
      const delta = ((target - current + 7) % 7) || 7;
      return { date: addDays(today, delta), rule: `next ${due.weekday}`, pendingPartnerConfirmation: false };
    }
    case "date": {
      if (due.day === null) return unresolved("date without a day");
      const { y, m, d } = parseDate(today);
      if (due.month !== null) {
        // Explicit month: this year, or next year if that date has passed.
        let year = y;
        if (due.month < m || (due.month === m && due.day < d)) year += 1;
        return dateIfValid(year, due.month, due.day, "explicit date");
      }
      // Day only ("15 tareekh"): this month if not yet passed, else next month.
      if (due.day >= d) return dateIfValid(y, m, due.day, "day of this month");
      const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
      return dateIfValid(next.y, next.m, due.day, "day of next month");
    }
  }
}

function dateIfValid(y: number, m: number, d: number, rule: string): ResolvedDue {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return unresolved(`invalid date ${y}-${m}-${d}`);
  return {
    date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    rule,
    pendingPartnerConfirmation: false,
  };
}

function unresolved(rule: string): ResolvedDue {
  return { date: null, rule, pendingPartnerConfirmation: false };
}
