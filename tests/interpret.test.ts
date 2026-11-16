import { describe, expect, it } from "vitest";
import { contextFromSeed } from "@/lib/context";
import { interpret, type InterpretInput, type Resolution } from "@/lib/interpret";
import { OPENING_STOCK } from "@/prisma/seed-data";
import { extraction, n01, noDue, refOf, visit } from "./fixtures";

const ctx = contextFromSeed("MR-ROHIT");
const RECORDED = new Date("2026-11-18T11:00:00+05:30");

function run(ext: InterpretInput["extraction"], over: Partial<InterpretInput> = {}) {
  return interpret({
    extraction: ext,
    ctx,
    recordedAt: RECORDED,
    aliases: { doctor: new Map(), product: new Map() },
    stock: new Map(Object.entries(OPENING_STOCK["MR-ROHIT"])),
    priorVisits: [],
    recentSamples: [],
    resolutions: [],
    confidenceThreshold: 0.6,
    ...over,
  });
}
const kinds = (r: ReturnType<typeof run>) => r.reviewItems.map((i) => i.kind).sort();
const res = (path: string, resolution: Resolution) => ({ path, resolution });

describe("interpret — happy path", () => {
  it("N01 resolves fully: visit, detailing, -3 strips, query, follow-up on 25 Nov", () => {
    const r = run(n01(ctx));
    expect(r.blocking).toBe(false);
    const v = r.plan.visits[0];
    expect(v.doctorId).toBe("DR-001");
    expect(v.occurredOn).toBe("2026-11-18");
    expect(v.detailed.map((d) => d.productId)).toEqual(["PRD-ZEN40"]);
    expect(v.samples).toEqual([{ productId: "PRD-ZEN40", mention: "Zentapra", quantity: 3, unit: "strip", baseQuantity: 3 }]);
    expect(v.queries[0].productId).toBe("PRD-ZEN40");
    expect(v.followUps[0]).toMatchObject({ dueDate: "2026-11-25", pending: true });
  });

  it("converts boxes to strips from the product master (1 box Telmora-40 = 10 strips)", () => {
    const tel = { mention: "Telmora 40", ref: refOf(ctx, "products", "PRD-TEL40") };
    const r = run(
      extraction({
        visits: [visit({ doctor: { mention: "Pooja Gupta mam", ref: refOf(ctx, "doctors", "DR-007"), evidence: null }, samples: [{ product: tel, quantity: 1, unit: "box" }] })],
      })
    );
    expect(r.blocking).toBe(false);
    expect(r.plan.visits[0].samples[0].baseQuantity).toBe(10);
  });

  it("late logging: 'kal mila tha' dates the visit to the previous IST day", () => {
    const r = run(
      extraction({ visits: [visit({ doctor: { mention: "Qureshi", ref: null, evidence: null }, dayOffset: -1 })] })
    );
    expect(r.plan.visits[0].occurredOn).toBe("2026-11-17");
  });

  it("doctor not met: visit kept with met=false, follow-up still recorded", () => {
    const r = run(
      extraction({
        visits: [
          visit({
            doctor: { mention: "Dr Bedi", ref: refOf(ctx, "doctors", "DR-006"), evidence: null },
            met: false,
            followUps: [{ action: "Visit again", due: { ...noDue, kind: "weekday", weekday: "friday" } }],
          }),
        ],
      })
    );
    expect(r.blocking).toBe(false);
    expect(r.plan.visits[0]).toMatchObject({ met: false, samples: [], detailed: [] });
    expect(r.plan.visits[0].followUps[0].dueDate).toBe("2026-11-20");
  });

  it("chemist call with POB, no doctor visit", () => {
    const r = run(
      extraction({
        chemistCalls: [
          {
            chemist: { mention: "Verma Medical Store", ref: null },
            dayOffset: 0,
            pobs: [{ product: { mention: "Zentapra", ref: null }, quantity: 20, unit: "strip" }],
          },
        ],
      })
    );
    expect(r.blocking).toBe(false);
    expect(r.plan.visits).toEqual([]);
    expect(r.plan.chemistCalls[0]).toMatchObject({ chemistId: "CH-002", pobs: [{ productId: "PRD-ZEN40", quantity: 20 }] });
  });
});

describe("interpret — review cards instead of guesses", () => {
  const sharmaTelmora = () =>
    extraction({
      visits: [
        visit({
          doctor: { mention: "Sharma ji", ref: null, evidence: null },
          detailed: [{ mention: "Telmora", ref: null }],
          samples: [{ product: { mention: "Telmora", ref: null }, quantity: 2, unit: "strip" }],
        }),
      ],
    });

  it("N04 'Sharma ji' + 'Telmora' -> doctor and product cards, nothing planned", () => {
    const r = run(sharmaTelmora());
    expect(r.blocking).toBe(true);
    expect(kinds(r)).toEqual(["DOCTOR_AMBIGUOUS", "PRODUCT_AMBIGUOUS", "PRODUCT_AMBIGUOUS"]);
    const card = r.reviewItems.find((i) => i.kind === "DOCTOR_AMBIGUOUS")!;
    expect(card.candidates!.map((c) => c.id).sort()).toEqual(["DR-002", "DR-003"]);
  });

  it("N04 after the MR taps answers -> fully resolved", () => {
    const r = run(sharmaTelmora(), {
      resolutions: [
        res("visits[0].doctor", { action: "pick", id: "DR-003" }),
        res("visits[0].detailed[0]", { action: "pick", id: "PRD-TEL40" }),
        res("visits[0].samples[0].product", { action: "pick", id: "PRD-TEL40" }),
      ],
    });
    expect(r.blocking).toBe(false);
    expect(r.plan.visits[0]).toMatchObject({ doctorId: "DR-003", samples: [{ productId: "PRD-TEL40", baseQuantity: 2 }] });
  });

  it("a learned alias resolves 'Sharma ji' without asking", () => {
    const r = run(sharmaTelmora(), {
      aliases: { doctor: new Map([["sharma", "DR-003"]]), product: new Map([["telmora", "PRD-TEL40"]]) },
    });
    expect(r.blocking).toBe(false);
    expect(r.plan.visits[0].doctorId).toBe("DR-003");
  });

  it("N05 Ferovia has no 'box' pack -> UNIT_UNKNOWN; quantity fix resolves it", () => {
    const ext = extraction({
      visits: [
        visit({
          doctor: { mention: "Dr Iyer", ref: null, evidence: null },
          samples: [{ product: { mention: "ferovia xt", ref: null }, quantity: 1, unit: "box" }],
        }),
      ],
    });
    expect(kinds(run(ext))).toEqual(["UNIT_UNKNOWN"]);
    const fixed = run(ext, { resolutions: [res("visits[0].samples[0]", { action: "quantity", quantity: 10, unit: "strip" })] });
    expect(fixed.blocking).toBe(false);
    expect(fixed.plan.visits[0].samples[0].baseQuantity).toBe(10);
  });

  it("unit not said, product has one unit (Ostiva: sachet only) -> base unit from master data, no card", () => {
    const r = run(
      extraction({
        visits: [visit({ doctor: { mention: "Bedi sir", ref: null, evidence: null }, samples: [{ product: { mention: "Ostiva", ref: null }, quantity: 4, unit: null }] })],
      })
    );
    expect(r.blocking).toBe(false);
    expect(r.reviewItems).toEqual([]);
    expect(r.plan.visits[0].samples[0]).toMatchObject({ productId: "PRD-OSTD3", quantity: 4, unit: "sachet", baseQuantity: 4 });
  });

  it("unit not said, product has several units (Zentapra: strip or box) -> UNIT_UNKNOWN; answer resolves it", () => {
    const ext = extraction({
      visits: [visit({ doctor: { mention: "Verma sir", ref: null, evidence: null }, samples: [{ product: { mention: "Zentapra", ref: null }, quantity: 2, unit: null }] })],
    });
    const r = run(ext);
    expect(kinds(r)).toEqual(["UNIT_UNKNOWN"]);
    expect(r.reviewItems[0].candidates!.map((c) => c.id)).toEqual(["strip", "box"]);
    const fixed = run(ext, { resolutions: [res("visits[0].samples[0]", { action: "quantity", quantity: 2, unit: "box" })] });
    expect(fixed.blocking).toBe(false);
    expect(fixed.plan.visits[0].samples[0].baseQuantity).toBe(20);
  });

  it("missing quantity is never guessed", () => {
    const r = run(
      extraction({
        visits: [visit({ doctor: { mention: "Iyer madam", ref: null, evidence: null }, samples: [{ product: { mention: "Ferovia", ref: null }, quantity: null, unit: null }] })],
      })
    );
    expect(kinds(r)).toEqual(["QUANTITY_MISSING"]);
  });

  it("new doctor -> DOCTOR_NOT_FOUND (not matched to Dr. Deepak Arora)", () => {
    const r = run(
      extraction({ visits: [visit({ doctor: { mention: "Dr Ritu Arora, dermatologist, Kalkaji", ref: null, evidence: null } })] })
    );
    expect(kinds(r)).toEqual(["DOCTOR_NOT_FOUND"]);
  });

  it("'sir saath the' with an ABM and an RBM -> MANAGER_AMBIGUOUS", () => {
    const r = run(
      extraction({
        visits: [visit({ doctor: { mention: "Dr Mehta", ref: null, evidence: null }, jointWork: [{ mention: "Sir", ref: "M1" }] })],
      })
    );
    expect(kinds(r)).toEqual(["MANAGER_AMBIGUOUS"]);
  });

  it("met=false with products detailed -> VISIT_STATUS_CONFLICT; nothing is dropped silently", () => {
    const ext = extraction({
      visits: [
        visit({
          doctor: { mention: "Verma sir", ref: refOf(ctx, "doctors", "DR-001"), evidence: null },
          met: false,
          detailed: [{ mention: "Zentapra", ref: refOf(ctx, "products", "PRD-ZEN40") }],
        }),
      ],
    });
    const r = run(ext);
    expect(r.blocking).toBe(true);
    expect(kinds(r)).toEqual(["VISIT_STATUS_CONFLICT"]);

    const met = run(ext, { resolutions: [res("visits[0]", { action: "visitStatus", met: true })] });
    expect(met.blocking).toBe(false);
    expect(met.plan.visits[0]).toMatchObject({ met: true, detailed: [{ productId: "PRD-ZEN40" }] });

    const notMet = run(ext, { resolutions: [res("visits[0]", { action: "visitStatus", met: false })] });
    expect(notMet.blocking).toBe(false);
    expect(notMet.plan.visits[0]).toMatchObject({ met: false, detailed: [], samples: [] });
  });

  it("met=false with a sample or a POB is also a conflict", () => {
    const zen = { mention: "Zentapra", ref: refOf(ctx, "products", "PRD-ZEN40") };
    const doc = { mention: "Verma sir", ref: refOf(ctx, "doctors", "DR-001"), evidence: null };
    expect(kinds(run(extraction({ visits: [visit({ doctor: doc, met: false, samples: [{ product: zen, quantity: 2, unit: "strip" }] })] })))).toEqual([
      "VISIT_STATUS_CONFLICT",
    ]);
    expect(
      kinds(run(extraction({ visits: [visit({ doctor: doc, met: false, pobs: [{ product: zen, quantity: 10, unit: "strip", chemist: null }] })] })))
    ).toEqual(["VISIT_STATUS_CONFLICT"]);
  });

  it("met=false with only a follow-up is fine (absent doctor)", () => {
    const r = run(
      extraction({
        visits: [
          visit({
            doctor: { mention: "Mehta sir", ref: refOf(ctx, "doctors", "DR-012"), evidence: null },
            met: false,
            followUps: [{ action: "Visit again", due: { ...noDue, kind: "weekday", weekday: "monday" } }],
          }),
        ],
      })
    );
    expect(r.blocking).toBe(false);
    expect(r.plan.visits[0]).toMatchObject({ met: false });
  });

  it("LOW_CONFIDENCE is not added when the note already has specific cards (N04)", () => {
    const ext = extraction({
      visits: [visit({ doctor: { mention: "Sharma ji", ref: null, evidence: null }, confidence: 0.4 })],
    });
    expect(kinds(run(ext))).toEqual(["DOCTOR_AMBIGUOUS"]);
    // ...nor after the MR answered those cards: they've already looked at this note.
    expect(run(ext, { resolutions: [res("visits[0].doctor", { action: "pick", id: "DR-002" })] }).blocking).toBe(false);
  });

  it("Hinglish / Devanagari unit words map to master-data units", () => {
    const cough = { mention: "Coughzen", ref: refOf(ctx, "products", "PRD-COUGH") };
    const zen = { mention: "Zentapra", ref: refOf(ctx, "products", "PRD-ZEN40") };
    const doc = { mention: "Verma sir", ref: refOf(ctx, "doctors", "DR-001"), evidence: null };
    const r = run(
      extraction({
        visits: [
          visit({
            doctor: doc,
            samples: [
              { product: cough, quantity: 2, unit: "botal" },
              { product: zen, quantity: 1, unit: "dabba" },
              { product: { ...zen }, quantity: 2, unit: "patta" },
            ],
          }),
        ],
      })
    );
    expect(r.blocking).toBe(false);
    expect(r.plan.visits[0].samples.map((s) => `${s.unit}:${s.baseQuantity}`)).toEqual(["bottle:2", "box:10", "strip:2"]);
  });

  it("'packet' is never mapped by guess -> UNIT_UNKNOWN", () => {
    const ost = { mention: "Ostiva", ref: refOf(ctx, "products", "PRD-OSTD3") };
    const r = run(
      extraction({
        visits: [visit({ doctor: { mention: "Bedi sir", ref: null, evidence: null }, samples: [{ product: ost, quantity: 2, unit: "pkt" }] })],
      })
    );
    expect(kinds(r)).toEqual(["UNIT_UNKNOWN"]);
  });

  it("low model confidence -> LOW_CONFIDENCE card; 'accept' clears it", () => {
    const ext = n01(ctx);
    ext.visits[0].confidence = 0.4;
    expect(kinds(run(ext))).toEqual(["LOW_CONFIDENCE"]);
    expect(run(ext, { resolutions: [res("visits[0]", { action: "accept" })] }).blocking).toBe(false);
  });
});

describe("interpret — stock, duplicates, corrections, adverse events", () => {
  it("never lets stock go negative: 10 bottles with 6 in stock -> STOCK_INSUFFICIENT", () => {
    const r = run(
      extraction({
        visits: [visit({ doctor: { mention: "Verma sir", ref: null, evidence: null }, samples: [{ product: { mention: "Coughzen", ref: null }, quantity: 10, unit: "bottle" }] })],
      })
    );
    expect(kinds(r)).toEqual(["STOCK_INSUFFICIENT"]);
    expect(r.reviewItems[0].detail).toMatch(/stock is 6/);
  });

  it("same doctor already visited that day -> POSSIBLE_DUPLICATE_VISIT; 'second visit' clears it", () => {
    const prior = [{ doctorId: "DR-001", occurredOn: "2026-11-18", messageId: "m-earlier" }];
    expect(kinds(run(n01(ctx), { priorVisits: prior }))).toEqual(["POSSIBLE_DUPLICATE_VISIT"]);
    expect(run(n01(ctx), { priorVisits: prior, resolutions: [res("visits[0]", { action: "secondVisit" })] }).blocking).toBe(false);
  });

  it("correction: asks which entry to replace; after confirm, reverses it and stock nets correctly", () => {
    const ext = n01(ctx);
    ext.visits[0].samples[0].quantity = 2;
    ext.visits[0].detailed = [];
    ext.visits[0].queries = [];
    ext.visits[0].followUps = [];
    ext.correction = { isCorrection: true, description: "3 strips, not 2" };
    const earlier = {
      eventId: "evt-3-strips",
      doctorId: "DR-001",
      doctorName: "Dr. Anil Verma",
      productId: "PRD-ZEN40",
      productName: "Zentapra-40",
      quantity: 3,
      unit: "strip",
      stockDelta: -3,
      occurredOn: "2026-11-18",
      visitEventId: "visit-1",
    };
    const before = run(ext, { recentSamples: [earlier] });
    expect(kinds(before)).toEqual(["CORRECTION_REQUESTED"]);
    expect(before.reviewItems[0].candidates![0].id).toBe("evt-3-strips");

    // With only 1 strip left, the correction still works because the
    // reversal (+3) is counted before the new sample (-2).
    const after = run(ext, {
      recentSamples: [earlier],
      stock: new Map([["PRD-ZEN40", 1]]),
      priorVisits: [{ doctorId: "DR-001", occurredOn: "2026-11-18", messageId: "m-n01" }], // not a duplicate
      resolutions: [res("message", { action: "reverse", eventIds: ["evt-3-strips"] })],
    });
    expect(after.blocking).toBe(false);
    expect(after.plan.reversals).toEqual(["evt-3-strips"]);
    expect(after.plan.visits[0].samples[0].baseQuantity).toBe(2);
    expect(after.plan.visits[0].existingVisitId).toBe("visit-1"); // no second Verma visit in the DCR
  });

  it("adverse event -> manager card that does NOT block the DCR", () => {
    const ext = n01(ctx);
    ext.adverseEvent = { mentioned: true, summary: "Rash after Coughzen in a child" };
    const r = run(ext);
    expect(r.blocking).toBe(false);
    expect(r.adverseEvent).toBe(true);
    expect(r.reviewItems).toEqual([expect.objectContaining({ kind: "ADVERSE_EVENT", assignee: "MANAGER", blocking: false })]);
  });

  it("three visits in one note keep their own samples", () => {
    const ref = (k: "doctors" | "products", c: string) => refOf(ctx, k, c);
    const r = run(
      extraction({
        visits: [
          visit({ doctor: { mention: "Verma sir", ref: ref("doctors", "DR-001"), evidence: null }, samples: [{ product: { mention: "Zentapra", ref: ref("products", "PRD-ZEN40") }, quantity: 2, unit: "strip" }] }),
          visit({ doctor: { mention: "Bedi sir", ref: ref("doctors", "DR-006"), evidence: null }, samples: [{ product: { mention: "Ostiva", ref: ref("products", "PRD-OSTD3") }, quantity: 4, unit: "sachet" }] }),
          visit({
            doctor: { mention: "Iyer madam", ref: ref("doctors", "DR-004"), evidence: null },
            samples: [
              { product: { mention: "Ferovia", ref: ref("products", "PRD-FERXT") }, quantity: 3, unit: "strip" },
              { product: { mention: "Ostiva", ref: ref("products", "PRD-OSTD3") }, quantity: 2, unit: "sachet" },
            ],
          }),
        ],
      })
    );
    expect(r.blocking).toBe(false);
    expect(r.plan.visits.map((v) => [v.doctorId, v.samples.map((s) => `${s.productId}:${s.baseQuantity}`)])).toEqual([
      ["DR-001", ["PRD-ZEN40:2"]],
      ["DR-006", ["PRD-OSTD3:4"]],
      ["DR-004", ["PRD-FERXT:3", "PRD-OSTD3:2"]],
    ]);
  });
});
