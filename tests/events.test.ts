import { describe, expect, it } from "vitest";
import { EVENT_TYPE_NAMES, validateEventDraft } from "@/lib/events";

describe("event registry", () => {
  it("has the 7 MVP types plus admin-only sample_received", () => {
    expect(EVENT_TYPE_NAMES.sort()).toEqual(
      ["doctor_query", "doctor_visit", "follow_up", "joint_work", "pob", "product_detailed", "sample_given", "sample_received"].sort()
    );
  });

  it("accepts a valid sample_given with a negative stockDelta", () => {
    const r = validateEventDraft({
      type: "sample_given",
      payload: { quantity: 1, unit: "box", rawProductMention: "Telmora 40" },
      productId: "p",
      visitEventId: "v",
      stockDelta: -10,
    });
    expect(r.schemaVersion).toBe(1);
  });

  it("rejects unknown types and bad payloads", () => {
    expect(() => validateEventDraft({ type: "rcpa_entry", payload: {} })).toThrow(/Unknown event type/);
    expect(() =>
      validateEventDraft({
        type: "sample_given",
        payload: { quantity: 2.5, unit: "strip", rawProductMention: "x" },
        productId: "p",
        visitEventId: "v",
        stockDelta: -2,
      })
    ).toThrow(/Invalid sample_given payload/);
  });

  it("requires the indexed columns each type needs", () => {
    expect(() =>
      validateEventDraft({ type: "joint_work", payload: { rawMention: "ABM sir" }, visitEventId: "v" })
    ).toThrow(/requires managerId/);
  });

  it("only stock-moving types may set stockDelta, with the right sign", () => {
    expect(() =>
      validateEventDraft({
        type: "pob",
        payload: { quantity: 10, unit: "strip", orderedBy: "doctor", chemistName: null, rawProductMention: "x" },
        productId: "p",
        stockDelta: -10,
      })
    ).toThrow(/must not set stockDelta/);
    expect(() =>
      validateEventDraft({
        type: "sample_given",
        payload: { quantity: 2, unit: "strip", rawProductMention: "x" },
        productId: "p",
        visitEventId: "v",
        stockDelta: 2,
      })
    ).toThrow(/negative stockDelta/);
    expect(() =>
      validateEventDraft({
        type: "sample_received",
        payload: { quantity: 2, unit: "strip", note: null, source: "admin_entry" },
        productId: "p",
        stockDelta: -2,
      })
    ).toThrow(/positive stockDelta/);
  });

  it("a reversal may carry the opposite sign", () => {
    expect(() =>
      validateEventDraft({
        type: "sample_given",
        payload: { quantity: 3, unit: "strip", rawProductMention: "Zentapra" },
        productId: "p",
        visitEventId: "v",
        stockDelta: 3,
        reversesEventId: "e1",
      })
    ).not.toThrow();
  });
});
