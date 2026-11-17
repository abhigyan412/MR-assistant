import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { contextFromSeed } from "@/lib/context";
import { extractNote } from "@/lib/extract";
import type { Extraction } from "@/lib/extraction-schema";
import OpenAI from "openai";
import { AnthropicProvider } from "@/lib/llm/anthropic";
import { OpenAIProvider } from "@/lib/llm/openai";
import {
  InvalidProviderResponseError,
  ProviderRefusalError,
  type ExtractionProvider,
  type StructuredResult,
} from "@/lib/llm";
import { CASES } from "@/eval/cases";
import { normalizeUnit, scoreCase, scorePipeline } from "@/eval/score";
import { OPENING_STOCK } from "@/prisma/seed-data";

const ctx = contextFromSeed("MR-ROHIT");
const ref = (kind: "doctors" | "products" | "managers" | "chemists", code: string) =>
  ctx[kind].find((e) => e.code === code)!.ref;
const none = { kind: "unspecified" as const, amount: null, weekday: null, day: null, month: null };

function fakeProvider(output: unknown): ExtractionProvider {
  return {
    id: "fake",
    model: "fake-model",
    generate: async (): Promise<StructuredResult> => ({
      output,
      rawText: JSON.stringify(output),
      model: "fake-model",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      latencyMs: 1,
    }),
  };
}

// A perfect answer for N01.
function n01(overrides: Partial<Extraction["visits"][number]> = {}): Extraction {
  const zen = { mention: "Zentapra", ref: ref("products", "PRD-ZEN40") };
  return {
    visits: [
      {
        doctor: { mention: "Dr. Verma", ref: ref("doctors", "DR-001"), evidence: null },
        met: true,
        dayOffset: 0,
        time: null,
        jointWork: [],
        detailed: [zen],
        samples: [{ product: zen, quantity: 3, unit: "strips" }],
        queries: [{ question: "Dose for elderly patients", product: zen }],
        followUps: [{ action: "Follow up", due: { ...none, kind: "weeks", amount: 1 } }],
        pobs: [],
        confidence: 0.9,
        ...overrides,
      },
    ],
    chemistCalls: [],
    stockReports: [],
    adverseEvent: { mentioned: false, summary: null },
    correction: { isCorrection: false, description: null },
  };
}

const caseById = (id: string) => CASES.find((c) => c.id === id)!;

describe("extractNote", () => {
  it("returns a validated extraction", async () => {
    const out = await extractNote(fakeProvider(n01()), ctx, "note");
    expect(out.extraction.visits[0].doctor.ref).toBe(ref("doctors", "DR-001"));
    expect(out.unknownRefs).toEqual([]);
  });

  it("nulls out refs that are not in the shortlist instead of trusting them", async () => {
    const bad = n01();
    bad.visits[0].doctor.ref = "D99";
    const out = await extractNote(fakeProvider(bad), ctx, "note");
    expect(out.extraction.visits[0].doctor.ref).toBeNull();
    expect(out.unknownRefs).toEqual(["doctor:D99"]);
  });

  it("rejects output that fails schema validation", async () => {
    await expect(extractNote(fakeProvider({ visits: "nope" }), ctx, "note")).rejects.toBeInstanceOf(
      InvalidProviderResponseError
    );
  });
});

describe("scoreCase", () => {
  it("a perfect N01 extraction passes every check", () => {
    const s = scoreCase(caseById("N01"), n01(), ctx, []);
    expect(s.checks.filter((c) => !c.pass)).toEqual([]);
    expect(s.pass).toBe(true);
  });

  it("a wrong sample quantity is a critical failure", () => {
    const e = n01();
    e.visits[0].samples[0].quantity = 30;
    const s = scoreCase(caseById("N01"), e, ctx, []);
    expect(s.pass).toBe(false);
    expect(s.criticalFailures).toBeGreaterThan(0);
  });

  it("guessing between two Dr. Sharmas is critical; leaving it unresolved is correct", () => {
    const telmora = { mention: "Telmora", ref: null };
    const base = n01({
      doctor: { mention: "Sharma ji", ref: null, evidence: null },
      detailed: [telmora],
      samples: [{ product: telmora, quantity: 2, unit: "strip" }],
      queries: [],
      followUps: [],
    });
    expect(scoreCase(caseById("N04"), base, ctx, []).pass).toBe(true);

    const guessed = structuredClone(base);
    guessed.visits[0].doctor.ref = ref("doctors", "DR-002");
    const s = scoreCase(caseById("N04"), guessed, ctx, []);
    expect(s.criticalFailures).toBeGreaterThan(0);
  });

  it("a name the model left unresolved but the matcher resolves alone counts as resolved (N07 'Iyer madam')", () => {
    const fer = { mention: "Ferovia", ref: null };
    const e = n01({
      doctor: { mention: "Iyer madam", ref: null, evidence: null },
      detailed: [],
      samples: [{ product: fer, quantity: null, unit: null }],
      queries: [],
      followUps: [{ action: "Visit again", due: { ...none, kind: "days", amount: 15 } }],
    });
    expect(scoreCase(caseById("N07"), e, ctx, []).checks.filter((c) => !c.pass)).toEqual([]);
  });

  it("a matcher auto-resolution inside an ambiguous set is still a critical guess", () => {
    // If the matcher ever resolved "Sharma ji" alone, that would reach the record: score it like a model guess.
    const e = n01({ doctor: { mention: "Rakesh Sharma", ref: null, evidence: null }, detailed: [], samples: [], queries: [], followUps: [] });
    expect(scoreCase(caseById("N04"), e, ctx, []).criticalFailures).toBeGreaterThan(0);
  });

  it("unit not said: the product's only unit is accepted, a choice between units is not", () => {
    const fer = { mention: "Ferovia", ref: ref("products", "PRD-FERXT") };
    const onlyUnit = n01({
      doctor: { mention: "Iyer madam", ref: ref("doctors", "DR-004"), evidence: null },
      detailed: [],
      samples: [{ product: fer, quantity: null, unit: "strip" }], // Ferovia has strips only
      queries: [],
      followUps: [{ action: "Visit again", due: { ...none, kind: "days", amount: 15 } }],
    });
    expect(scoreCase(caseById("N07"), onlyUnit, ctx, []).criticalFailures).toBe(0);

    const zen = n01();
    const tweaked = { ...caseById("N01"), expect: { visits: [{ ...caseById("N01").expect!.visits[0], samples: [{ product: "PRD-ZEN40", quantity: 3, unit: null }] }] } };
    expect(scoreCase(tweaked, zen, ctx, []).criticalFailures).toBeGreaterThan(0); // Zentapra: strip OR box
  });

  it("detects patient data leaking into the output", () => {
    const ost = { mention: "Ostiva D3", ref: ref("products", "PRD-OSTD3") };
    const e = n01({
      doctor: { mention: "Dr Iyer", ref: ref("doctors", "DR-004"), evidence: null },
      detailed: [],
      samples: [{ product: ost, quantity: 4, unit: "sachet" }],
      queries: [{ question: "Is it safe for Sunita (32) in pregnancy?", product: ost }],
      followUps: [],
    });
    const s = scoreCase(caseById("N08"), e, ctx, []);
    expect(s.privacyLeaks).toBe(2);
    expect(s.criticalFailures).toBeGreaterThan(0);
  });

  it("normalizes plural units", () => {
    expect(normalizeUnit("Strips")).toBe("strip");
    expect(normalizeUnit("boxes")).toBe("box");
    expect(normalizeUnit(null)).toBeNull();
  });
});

describe("AnthropicProvider", () => {
  function mockClient(response: unknown) {
    const parse = vi.fn().mockResolvedValue(response);
    return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
  }
  const request = { system: "s", context: "c", user: "u", schema: (undefined as never) };

  it("enables server-side fallbacks on Opus 5.5 but not on Haiku 5.5", async () => {
    const ok = {
      stop_reason: "end_turn",
      model: "x",
      content: [{ type: "text", text: "{}" }],
      parsed_output: {},
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    const { client: opus, parse: opusParse } = mockClient(ok);
    const { client: haiku, parse: haikuParse } = mockClient(ok);
    const schema = (await import("@/lib/extraction-schema")).ExtractionSchema;
    await new AnthropicProvider({ model: "claude-opus-5-5", effort: "medium", timeoutMs: 1000, client: opus }).generate({ ...request, schema });
    await new AnthropicProvider({ model: "claude-haiku-5-5", effort: "medium", timeoutMs: 1000, client: haiku }).generate({ ...request, schema });
    expect(opusParse.mock.calls[0][0]).toMatchObject({ fallbacks: "default", output_config: { effort: "medium" } });
    expect(haikuParse.mock.calls[0][0].fallbacks).toBeUndefined();
  });

  it("maps a refusal stop reason to ProviderRefusalError", async () => {
    const { client } = mockClient({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: null, explanation: null },
      model: "x",
      content: [],
      parsed_output: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const schema = (await import("@/lib/extraction-schema")).ExtractionSchema;
    await expect(
      new AnthropicProvider({ model: "claude-opus-5-5", effort: "medium", timeoutMs: 1000, client }).generate({ ...request, schema })
    ).rejects.toBeInstanceOf(ProviderRefusalError);
  });
});

describe("OpenAIProvider", () => {
  const request = { system: "s", context: "c", user: "u", schema: (undefined as never) };
  const ok = (over: Record<string, unknown> = {}) => ({
    status: "completed",
    model: "m-served",
    output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
    output_text: "{}",
    output_parsed: {},
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } },
    ...over,
  });
  const badParam = (param: string) =>
    new OpenAI.BadRequestError(400, { message: `Unsupported parameter: '${param}' is not supported with this model.` }, undefined, new Headers());
  function mockClient(...results: unknown[]) {
    const parse = vi.fn();
    for (const r of results) {
      if (r instanceof Error) parse.mockRejectedValueOnce(r);
      else parse.mockResolvedValueOnce(r);
    }
    return { client: { responses: { parse } } as unknown as OpenAI, parse };
  }
  const schema = async () => (await import("@/lib/extraction-schema")).ExtractionSchema;

  it("sends a strict JSON schema from Zod, temperature 0, and splits cached tokens", async () => {
    const { client, parse } = mockClient(ok());
    const r = await new OpenAIProvider({ model: "t-model", effort: "medium", timeoutMs: 1000, client }).generate({ ...request, schema: await schema() });
    const body = parse.mock.calls[0][0];
    expect(body).toMatchObject({ temperature: 0, text: { format: { type: "json_schema", strict: true, name: "extraction" } } });
    expect(body.reasoning).toBeUndefined();
    expect(r.usage).toEqual({ inputTokens: 40, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 0 });
    expect(r.model).toBe("m-served");
  });

  it("a model that rejects temperature is retried with reasoning effort, and remembered", async () => {
    const { client, parse } = mockClient(badParam("temperature"), ok(), ok());
    const p = new OpenAIProvider({ model: "r-model", effort: "low", timeoutMs: 1000, client });
    await p.generate({ ...request, schema: await schema() });
    await p.generate({ ...request, schema: await schema() });
    expect(parse).toHaveBeenCalledTimes(3);
    expect(parse.mock.calls[1][0]).toMatchObject({ reasoning: { effort: "low" } });
    expect(parse.mock.calls[1][0].temperature).toBeUndefined();
    expect(parse.mock.calls[2][0]).toMatchObject({ reasoning: { effort: "low" } }); // no second failed attempt
  });

  it("maps a refusal to ProviderRefusalError", async () => {
    const { client } = mockClient(
      ok({ output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], output_text: "", output_parsed: null })
    );
    await expect(
      new OpenAIProvider({ model: "x-model", effort: "medium", timeoutMs: 1000, client }).generate({ ...request, schema: await schema() })
    ).rejects.toBeInstanceOf(ProviderRefusalError);
  });
});

describe("scorePipeline (offline)", () => {
  const stock = new Map(Object.entries(OPENING_STOCK["MR-ROHIT"]));

  it("N01 perfect extraction -> PROCESSED", () => {
    expect(scorePipeline(caseById("N01"), n01(), ctx, stock)).toMatchObject({ pass: true, got: "PROCESSED []" });
  });

  it("N04 unresolved Sharma + Telmora -> NEEDS_REVIEW with doctor and product cards", () => {
    const telmora = { mention: "Telmora", ref: null };
    const e = n01({
      doctor: { mention: "Sharma ji", ref: null, evidence: null },
      detailed: [telmora],
      samples: [{ product: telmora, quantity: 2, unit: "strip" }],
      queries: [],
      followUps: [],
    });
    expect(scorePipeline(caseById("N04"), e, ctx, stock)).toMatchObject({ pass: true });
  });

  it("N19 10 bottles with 6 in stock -> STOCK_INSUFFICIENT", () => {
    const cough = { mention: "Coughzen", ref: ref("products", "PRD-COUGH") };
    const e = n01({ detailed: [], samples: [{ product: cough, quantity: 10, unit: "bottle" }], queries: [], followUps: [] });
    expect(scorePipeline(caseById("N19"), e, ctx, stock)).toMatchObject({ pass: true, got: "NEEDS_REVIEW [STOCK_INSUFFICIENT]" });
  });

  it("the resent duplicate is not scored offline", () => {
    expect(scorePipeline(caseById("N14"), n01(), ctx, stock)).toBeNull();
  });
});
