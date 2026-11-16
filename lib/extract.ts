import type { MrContext } from "./context";
import { ExtractionSchema, type Extraction } from "./extraction-schema";
import { InvalidProviderResponseError, type ExtractionProvider, type StructuredResult } from "./llm";
import { buildContextBlock, buildUserMessage, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompts";

export interface ExtractOutcome {
  extraction: Extraction;
  // Refs the model returned that are not in the shortlist; they were nulled
  // out (treated as "unsure") rather than trusted.
  unknownRefs: string[];
  provider: { id: string; requestedModel: string };
  result: Omit<StructuredResult, "output">;
  promptVersion: string;
}

/**
 * Run the LLM on one note and return a Zod-validated extraction with every
 * ref checked against the MR's shortlist. Provider errors propagate as typed
 * errors (-> FAILED). This function makes no business decisions — matching
 * verification, review items, dates and stock live in later stages.
 */
export async function extractNote(
  provider: ExtractionProvider,
  ctx: MrContext,
  noteText: string
): Promise<ExtractOutcome> {
  const result = await provider.generate({
    system: SYSTEM_PROMPT,
    context: buildContextBlock(ctx),
    user: buildUserMessage(noteText),
    schema: ExtractionSchema,
  });

  // Never trust the provider's own schema enforcement alone.
  const parsed = ExtractionSchema.safeParse(result.output);
  if (!parsed.success) {
    throw new InvalidProviderResponseError(
      `Extraction failed schema validation: ${parsed.error.message}`,
      result.rawText
    );
  }

  const { extraction, unknownRefs } = sanitizeRefs(parsed.data, ctx);
  const { output: _output, ...rest } = result;
  return {
    extraction,
    unknownRefs,
    provider: { id: provider.id, requestedModel: provider.model },
    result: rest,
    promptVersion: PROMPT_VERSION,
  };
}

/** Null out any ref not present in the shortlist for its entity kind. */
export function sanitizeRefs(extraction: Extraction, ctx: MrContext): { extraction: Extraction; unknownRefs: string[] } {
  const known = {
    doctor: new Set(ctx.doctors.map((d) => d.ref)),
    product: new Set(ctx.products.map((p) => p.ref)),
    manager: new Set(ctx.managers.map((m) => m.ref)),
    chemist: new Set(ctx.chemists.map((c) => c.ref)),
  };
  const unknownRefs: string[] = [];
  const check = <T extends { ref: string | null }>(kind: keyof typeof known, entity: T): T => {
    if (entity.ref !== null && !known[kind].has(entity.ref)) {
      unknownRefs.push(`${kind}:${entity.ref}`);
      return { ...entity, ref: null };
    }
    return entity;
  };

  const copy: Extraction = structuredClone(extraction);
  for (const visit of copy.visits) {
    visit.doctor = check("doctor", visit.doctor);
    visit.jointWork = visit.jointWork.map((m) => check("manager", m));
    visit.detailed = visit.detailed.map((p) => check("product", p));
    for (const s of visit.samples) s.product = check("product", s.product);
    for (const q of visit.queries) if (q.product) q.product = check("product", q.product);
    for (const p of visit.pobs) {
      p.product = check("product", p.product);
      if (p.chemist) p.chemist = check("chemist", p.chemist);
    }
  }
  for (const call of copy.chemistCalls) {
    call.chemist = check("chemist", call.chemist);
    for (const p of call.pobs) p.product = check("product", p.product);
  }
  return { extraction: copy, unknownRefs };
}
