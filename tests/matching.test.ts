import { describe, expect, it } from "vitest";
import { contextFromSeed } from "@/lib/context";
import { matchDoctor, matchProduct, transliterate } from "@/lib/matching";

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
