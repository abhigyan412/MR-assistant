import { describe, expect, it } from "vitest";
import {
  addMonths,
  istDate,
  resolveDayOffset,
  resolveDue,
  resolveOccurredAt,
  weekdayOf,
  type DuePhrase,
} from "@/lib/dates";

const due = (p: Partial<DuePhrase> & { kind: DuePhrase["kind"] }): DuePhrase => ({
  amount: null,
  weekday: null,
  day: null,
  month: null,
  ...p,
});

// Wednesday 18 Nov 2026, 11:00 IST — the eval's default note time.
const WED_11_IST = new Date("2026-11-18T11:00:00+05:30");

describe("IST date handling (never server UTC)", () => {
  it("note recorded at 23:30 IST saying 'kal' (yesterday) resolves to the previous IST day", () => {
    const at = new Date("2026-11-18T23:30:00+05:30"); // = 18:00 UTC
    expect(istDate(at)).toBe("2026-11-18");
    expect(resolveDayOffset(at, -1)).toBe("2026-11-17");
  });

  it("note recorded at 23:30 IST saying 'kal' (tomorrow) resolves to the next IST day", () => {
    const at = new Date("2026-11-18T23:30:00+05:30");
    expect(resolveDue(at, due({ kind: "days", amount: 1 })).date).toBe("2026-11-19");
  });

  it("just after midnight IST the IST date differs from the UTC date", () => {
    const at = new Date("2026-11-19T00:30:00+05:30"); // = 18 Nov 19:00 UTC
    expect(at.toISOString().slice(0, 10)).toBe("2026-11-18"); // what a UTC bug would use
    expect(istDate(at)).toBe("2026-11-19");
    expect(resolveDayOffset(at, -1)).toBe("2026-11-18"); // "kal mila tha" = 18th, not 17th
  });

  it("same-day visit without a stated time keeps the recording instant", () => {
    const r = resolveOccurredAt(WED_11_IST, 0, null);
    expect(r.occurredOn).toBe("2026-11-18");
    expect(r.occurredAt.getTime()).toBe(WED_11_IST.getTime());
  });

  it("stated visit time is IST wall-clock time", () => {
    const r = resolveOccurredAt(WED_11_IST, -1, "18:30");
    expect(r.occurredOn).toBe("2026-11-17");
    expect(r.occurredAt.toISOString()).toBe("2026-11-17T13:00:00.000Z");
  });
});

describe("follow-up date rules", () => {
  it("'next week' = +7 days and is flagged pending partner confirmation", () => {
    const r = resolveDue(WED_11_IST, due({ kind: "weeks", amount: 1 }));
    expect(r.date).toBe("2026-11-25");
    expect(r.pendingPartnerConfirmation).toBe(true);
  });

  it("'15 din baad' = +15 days", () => {
    expect(resolveDue(WED_11_IST, due({ kind: "days", amount: 15 })).date).toBe("2026-12-03");
  });

  it("weekday = next occurrence after the note date", () => {
    expect(weekdayOf("2026-11-18")).toBe("wednesday");
    expect(resolveDue(WED_11_IST, due({ kind: "weekday", weekday: "friday" })).date).toBe("2026-11-20");
    expect(resolveDue(WED_11_IST, due({ kind: "weekday", weekday: "monday" })).date).toBe("2026-11-23");
  });

  it("the same weekday as the note means next week, not today", () => {
    expect(resolveDue(WED_11_IST, due({ kind: "weekday", weekday: "wednesday" })).date).toBe("2026-11-25");
  });

  it("months clamp to the end of a shorter month", () => {
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(resolveDue(WED_11_IST, due({ kind: "months", amount: 1 })).date).toBe("2026-12-18");
  });

  it("day-of-month only: this month if not passed, else next month", () => {
    expect(resolveDue(WED_11_IST, due({ kind: "date", day: 25 })).date).toBe("2026-11-25");
    expect(resolveDue(WED_11_IST, due({ kind: "date", day: 3 })).date).toBe("2026-12-03");
  });

  it("explicit month in the past rolls to next year", () => {
    expect(resolveDue(WED_11_IST, due({ kind: "date", day: 5, month: 1 })).date).toBe("2027-01-05");
  });

  it("invalid or unspecified dates resolve to null, never a guess", () => {
    expect(resolveDue(WED_11_IST, due({ kind: "date", day: 31, month: 2 })).date).toBeNull();
    expect(resolveDue(WED_11_IST, due({ kind: "unspecified" })).date).toBeNull();
    expect(resolveDue(WED_11_IST, null).date).toBeNull();
  });
});
