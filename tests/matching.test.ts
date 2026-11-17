import { describe, expect, it } from "vitest";
import { contextFromSeed } from "@/lib/context";
import { matchDoctor, matchProduct, transliterate } from "@/lib/matching";
import { VARANASI } from "@/prisma/demo-data";

const ctx = contextFromSeed("MR-ROHIT");
const none = new Map<string, string>();
const doctor = (mention: string) => matchDoctor(mention, null, null, ctx, none);
const product = (mention: string) => matchProduct(mention, null, ctx, none);

describe("matcher — unique surname + honorific resolves by itself", () => {
  it.each([
    ["Iyer madam", "DR-004"],
    ["Bedi sir", "DR-006"],
    ["Khan sahab", "DR-011"],
    ["Rao ji", "DR-013"],
    ["Bansal mam", "DR-010"],
  ])("%s -> %s", (mention, id) => {
    expect(doctor(mention)).toMatchObject({ status: "matched", id });
  });

  it("a shared surname still asks (two Sharmas, two Guptas)", () => {
    expect(doctor("Sharma ji")).toMatchObject({ status: "ambiguous" });
    expect(doctor("Gupta madam")).toMatchObject({ status: "ambiguous" });
  });

  it("a new doctor sharing a surname is not matched (Ritu Arora != Deepak Arora)", () => {
    expect(doctor("Dr Ritu Arora, skin specialist, Kalkaji").status).not.toBe("matched");
  });
});

describe("matcher — unique brand prefix resolves by itself", () => {
  it.each([
    ["Ostiva", "PRD-OSTD3"],
    ["Zentapra", "PRD-ZEN40"],
    ["Glyconix", "PRD-GLYM2"],
    ["ferovia", "PRD-FERXT"],
  ])("%s -> %s", (mention, id) => {
    expect(product(mention)).toMatchObject({ status: "matched", id });
  });

  it("a prefix shared by a brand family still asks (Telmora-40 / Telmora-H)", () => {
    expect(product("Telmora")).toMatchObject({ status: "ambiguous" });
  });

  it("a competitor brand is not matched to ours (Telma)", () => {
    expect(product("Telma").status).not.toBe("matched");
  });
});

describe("matcher — sound-alike and Devanagari spellings", () => {
  it("transliterates Devanagari roughly", () => {
    expect(transliterate("कफज़ेन सिरप")).toBe("kaphazen sirap");
    expect(transliterate("कुरैशी")).toBe("kuraishee");
  });

  it.each([["Kafzen syrup"], ["कफज़ेन सिरप"], ["Kafjen"], ["coughzen syp"]])("%s -> Coughzen", (mention) => {
    expect(product(mention)).toMatchObject({ status: "matched", id: "PRD-COUGH" });
  });

  it.each([["डॉ. कुरैशी"], ["Kuraishi sir"], ["Kureshi"]])("%s -> Dr. Qureshi", (mention) => {
    expect(doctor(mention)).toMatchObject({ status: "matched", id: "DR-005" });
  });

  it("Devanagari for a shared surname still asks", () => {
    expect(doctor("शर्मा जी")).toMatchObject({ status: "ambiguous" });
  });
});

describe("Varanasi demo data — same traps as the eval fixture", () => {
  const vns = contextFromSeed("MR-AMIT", VARANASI);
  const doc = (m: string) => matchDoctor(m, null, null, vns, none);
  const prod = (m: string) => matchProduct(m, null, vns, none);

  it("Amit's shortlist never includes Cantt (other MR) doctors or chemists", () => {
    expect(vns.doctors.map((d) => d.code)).not.toContain("VD-51");
    expect(vns.chemists.map((c) => c.code)).not.toContain("VC-51");
  });

  it("'Tiwari sir' is Dr. Rajesh Tiwari (the Cantt Tiwari is out of territory)", () => {
    expect(doc("Tiwari sir")).toMatchObject({ status: "matched", id: "VD-01" });
  });

  it("shared surnames and the Glimora family still ask", () => {
    expect(doc("Singh madam").status).toBe("ambiguous");
    expect(doc("Agarwal sir").status).toBe("ambiguous");
    expect(prod("Glimora").status).toBe("ambiguous");
  });

  it("new Dr Rekha Upadhyay is not matched to Dr Manoj Upadhyay; Telma is not ours", () => {
    expect(doc("Dr Rekha Upadhyay, ortho").status).not.toBe("matched");
    expect(prod("Telma").status).not.toBe("matched");
  });
});
