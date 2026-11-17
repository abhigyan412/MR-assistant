import { describe, expect, it } from "vitest";
import { contextFromSeed } from "@/lib/context";
import { validateEventDraft } from "@/lib/events";
import type { Extraction } from "@/lib/extraction-schema";
import { parseStoredExtraction } from "@/lib/extraction-schema";
import { interpret } from "@/lib/interpret";
import { CASES } from "@/eval/cases";
import { scoreCase, scorePipeline } from "@/eval/score";
import { OPENING_STOCK } from "@/prisma/seed-data";
import { extraction, refOf } from "./fixtures";

const ctx = contextFromSeed("MR-ROHIT");
const stock = () => new Map(Object.entries(OPENING_STOCK["MR-ROHIT"]));
const run = (ext: Extraction, resolutions: { path: string; resolution: never }[] = []) =>
  interpret({
    extraction: ext,
    ctx,
    recordedAt: new Date("2026-11-18T11:00:00+05:30"),
    aliases: { doctor: new Map(), product: new Map() },
    stock: stock(),
    priorVisits: [],
    recentSamples: [],
    resolutions,
    confidenceThreshold: 0.6,
  });
const zen = { mention: "Zentapra", ref: refOf(ctx, "products", "PRD-ZEN40") };
type SR = Extraction["stockReports"][number];
const report = (r: Partial<SR>): SR => ({ kind: "received", reason: null, product: zen, quantity: 2, unit: "box", ...r });

describe("stock reports (interpret)", () => {
  it("stock received -> a non-blocking STOCK_REPORT card for the manager, no stock change yet", () => {
    const r = run(extraction({ stockReports: [report({})] }));
    expect(r.blocking).toBe(false);
    expect(r.reviewItems).toEqual([
      expect.objectContaining({
        kind: "STOCK_REPORT",
        assignee: "MANAGER",
        blocking: false,
        proposal: expect.objectContaining({ direction: "received", productId: "PRD-ZEN40", quantity: 2, unit: "box", baseQuantity: 20 }),
      }),
    ]);
  });

  it("stock out with a reason; more than the MR holds -> STOCK_INSUFFICIENT first", () => {
    const ok = run(extraction({ stockReports: [report({ kind: "out", reason: "expired", quantity: 5, unit: "strip" })] }));
    expect(ok.reviewItems[0].proposal).toMatchObject({ direction: "out", reason: "expired", baseQuantity: 5 });
    const tooMuch = run(extraction({ stockReports: [report({ kind: "out", reason: "damaged", quantity: 50, unit: "strip" })] }));
    expect(tooMuch.reviewItems.map((i) => i.kind)).toEqual(["STOCK_INSUFFICIENT"]);
  });

  it("out without a reason is 'unspecified'; product/unit questions come before the manager card", () => {
    const noUnit = run(extraction({ stockReports: [report({ kind: "out", reason: null, quantity: 20, unit: null })] }));
    expect(noUnit.reviewItems.map((i) => i.kind)).toEqual(["UNIT_UNKNOWN"]);
    const fixed = run(extraction({ stockReports: [report({ kind: "out", reason: null, quantity: 20, unit: null })] }), [
      { path: "stockReports[0]", resolution: { action: "quantity", quantity: 20, unit: "strip" } as never },
    ]);
    expect(fixed.reviewItems[0]).toMatchObject({ kind: "STOCK_REPORT", proposal: { reason: "unspecified", baseQuantity: 20 } });
    const ambiguous = run(extraction({ stockReports: [report({ product: { mention: "Telmora", ref: null } })] }));
    expect(ambiguous.reviewItems.map((i) => i.kind)).toEqual(["PRODUCT_AMBIGUOUS"]);
  });
});

describe("stock events", () => {
  it("stock_adjusted must take stock down; sample_received from an MR report must add", () => {
    const out = { type: "stock_adjusted", productId: "p", payload: { quantity: 5, unit: "strip", reason: "expired", rawProductMention: "x", approvedById: "m" } };
    expect(() => validateEventDraft({ ...out, stockDelta: -5 })).not.toThrow();
    expect(() => validateEventDraft({ ...out, stockDelta: 5 })).toThrow(/negative/);
    const rec = { type: "sample_received", productId: "p", payload: { quantity: 2, unit: "box", note: null, source: "mr_report", approvedById: "m" } };
    expect(() => validateEventDraft({ ...rec, stockDelta: 20 })).not.toThrow();
  });

  it("notes stored before stockReports existed still parse", () => {
    const old = { visits: [], chemistCalls: [], adverseEvent: { mentioned: false, summary: null }, correction: { isCorrection: false, description: null } };
    expect(parseStoredExtraction(old).success).toBe(true);
  });
});

describe("eval N24-N27 (offline)", () => {
  const byId = (id: string) => CASES.find((c) => c.id === id)!;
  it("a perfect N24 extraction scores clean and ends PROCESSED [STOCK_REPORT]", () => {
    const ost = { mention: "Ostiva", ref: refOf(ctx, "products", "PRD-OSTD3") };
    const e = extraction({ stockReports: [report({}), report({ product: ost, quantity: 12, unit: "sachet" })] });
    expect(scoreCase(byId("N24"), e, ctx, []).checks.filter((c) => !c.pass)).toEqual([]);
    expect(scorePipeline(byId("N24"), e, ctx, stock())).toMatchObject({ pass: true });
  });

  it("an invented stock change is a critical error", () => {
    const e = extraction({ stockReports: [report({})] });
    expect(scoreCase(byId("N15"), e, ctx, []).criticalFailures).toBeGreaterThan(0);
  });
});
