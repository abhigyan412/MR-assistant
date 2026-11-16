import type { MrContext } from "@/lib/context";
import type { Extraction, ExtractedVisit } from "@/lib/extraction-schema";

// Builders for hand-written extractions (what a well-behaved LLM would return).

type Kind = "doctors" | "products" | "managers" | "chemists";

export function refOf(ctx: MrContext, kind: Kind, code: string): string {
  const hit = ctx[kind].find((e) => e.code === code);
  if (!hit) throw new Error(`No ${kind} with code ${code}`);
  return hit.ref;
}

export const noDue = { kind: "unspecified" as const, amount: null, weekday: null, day: null, month: null };

export function visit(partial: Partial<ExtractedVisit> & { doctor: ExtractedVisit["doctor"] }): ExtractedVisit {
  return {
    met: true,
    dayOffset: 0,
    time: null,
    jointWork: [],
    detailed: [],
    samples: [],
    queries: [],
    followUps: [],
    pobs: [],
    confidence: 0.9,
    ...partial,
  };
}

export function extraction(partial: Partial<Extraction>): Extraction {
  return {
    visits: [],
    chemistCalls: [],
    adverseEvent: { mentioned: false, summary: null },
    correction: { isCorrection: false, description: null },
    ...partial,
  };
}

/** N01 as a correct LLM would extract it. */
export function n01(ctx: MrContext): Extraction {
  const zen = { mention: "Zentapra", ref: refOf(ctx, "products", "PRD-ZEN40") };
  return extraction({
    visits: [
      visit({
        doctor: { mention: "Dr. Verma", ref: refOf(ctx, "doctors", "DR-001"), evidence: null },
        detailed: [zen],
        samples: [{ product: zen, quantity: 3, unit: "strips" }],
        queries: [{ question: "Dose for elderly patients", product: zen }],
        followUps: [{ action: "Follow up", due: { ...noDue, kind: "weeks", amount: 1 } }],
      }),
    ],
  });
}
