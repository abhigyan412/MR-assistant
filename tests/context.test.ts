import { describe, expect, it } from "vitest";
import { contextFromSeed } from "@/lib/context";
import { buildContextBlock } from "@/lib/prompts";
import { CASES } from "@/eval/cases";
import { CHEMISTS, DOCTORS, OPENING_STOCK, PRODUCTS, USERS } from "@/prisma/seed-data";

describe("MR shortlist", () => {
  const ctx = contextFromSeed("MR-ROHIT");

  it("contains only the MR's territory doctors (no Rohini Dr. Vikas Verma)", () => {
    expect(ctx.doctors.map((d) => d.code)).not.toContain("DR-101");
    expect(ctx.doctors).toHaveLength(14);
    expect(buildContextBlock(ctx)).not.toContain("Vikas Verma");
  });

  it("lists the manager chain, direct manager first", () => {
    expect(ctx.managers.map((m) => [m.ref, m.code])).toEqual([
      ["M1", "ABM-DELHI"],
      ["M2", "RBM-NORTH"],
    ]);
  });

  it("assigns stable refs (prompt stays cacheable)", () => {
    expect(buildContextBlock(contextFromSeed("MR-ROHIT"))).toBe(buildContextBlock(ctx));
    expect(ctx.doctors[0]).toMatchObject({ ref: "D1", code: "DR-001" });
  });
});

describe("seed data integrity", () => {
  it("codes are unique", () => {
    for (const list of [DOCTORS, PRODUCTS, USERS, CHEMISTS] as { code: string }[][]) {
      const codes = list.map((x) => x.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it("opening stock references real MRs and products", () => {
    for (const [mr, stock] of Object.entries(OPENING_STOCK)) {
      expect(USERS.find((u) => u.code === mr)?.role).toBe("MR");
      for (const code of Object.keys(stock)) expect(PRODUCTS.map((p) => p.code)).toContain(code);
    }
  });

  it("every code referenced by the eval set exists in the seed data", () => {
    const known = new Set([...DOCTORS, ...PRODUCTS, ...USERS, ...CHEMISTS].map((x) => x.code));
    const referenced = JSON.stringify(CASES.map((c) => c.expect ?? null)).match(/"(DR|PRD|ABM|RBM|CH)-[A-Z0-9]+"/g) ?? [];
    for (const quoted of referenced) expect(known).toContain(quoted.slice(1, -1));
  });

  it("eval set covers all 7 MVP event types, patients, ambiguity and a duplicate", () => {
    const covers = CASES.flatMap((c) => c.covers).join(" | ");
    for (const t of ["doctor_visit", "product_detailed", "sample_given", "doctor_query", "follow_up"]) {
      expect(covers).toContain(t);
    }
    const allVisits = CASES.flatMap((c) => c.expect?.visits ?? []);
    expect(allVisits.some((v) => Array.isArray(v.pobs) && v.pobs.length > 0)).toBe(true);
    expect(allVisits.some((v) => Array.isArray(v.jointWork) && v.jointWork.length > 0)).toBe(true);
    expect(CASES.filter((c) => c.expect?.forbidden?.length).length).toBeGreaterThanOrEqual(3);
    expect(CASES.filter((c) => c.covers.some((x) => x.startsWith("ambiguous doctor"))).length).toBe(2);
    expect(CASES.some((c) => c.pipeline.status === "DUPLICATE")).toBe(true);
  });
});
