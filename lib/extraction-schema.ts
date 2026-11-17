import { z } from "zod";
import { WEEKDAYS } from "./dates";

// What the LLM returns for one MR note. Sent to the API as a structured-output
// schema AND re-validated with Zod afterwards (never trust the provider alone).
//
// Shape is visit-centric on purpose: each sample/query/follow-up is nested
// under the visit it belongs to, so a note covering three doctors can't
// attach a sample to the wrong one. Code (not the LLM) turns this into the
// flat Event rows defined in lib/events.ts.
//
// The LLM only CLASSIFIES and COPIES. It never computes dates, stock,
// unit conversions or database ids — `ref` is a shortlist ref ("D3") or null.

const EntityRef = z.object({
  mention: z.string(), // as the MR said it, in Latin script
  ref: z.string().nullable(), // shortlist ref, or null when unsure / not in list
});

const DoctorRef = z.object({
  mention: z.string(),
  ref: z.string().nullable(),
  // Exact words from the note that pick this doctor over others with the
  // same name ("cardio wale"), or null. Phase 1 code checks these words
  // against the chosen doctor's specialty/area/clinic.
  evidence: z.string().nullable(),
});

const Due = z.object({
  kind: z.enum(["days", "weeks", "months", "weekday", "date", "unspecified"]),
  amount: z.number().int().nullable(),
  weekday: z.enum(WEEKDAYS).nullable(),
  day: z.number().int().nullable(),
  month: z.number().int().nullable(),
});

const Sample = z.object({
  product: EntityRef,
  quantity: z.number().nullable(),
  unit: z.string().nullable(), // as spoken, singular English: strip, box, sachet, bottle
});

const Pob = z.object({
  product: EntityRef,
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  chemist: EntityRef.nullable(), // chemist that will supply / book it, if said
});

const Visit = z.object({
  doctor: DoctorRef,
  met: z.boolean(),
  dayOffset: z.number().int(), // 0 = note date, -1 = yesterday ("kal mila tha")
  time: z.string().nullable(), // "HH:MM" 24h if a time was said
  jointWork: z.array(EntityRef), // managers present on this visit
  detailed: z.array(EntityRef),
  samples: z.array(Sample),
  queries: z.array(z.object({ question: z.string(), product: EntityRef.nullable() })),
  followUps: z.array(z.object({ action: z.string(), due: Due })),
  pobs: z.array(Pob),
  confidence: z.number(),
});

const ChemistCall = z.object({
  chemist: EntityRef,
  dayOffset: z.number().int(),
  pobs: z.array(
    z.object({ product: EntityRef, quantity: z.number().nullable(), unit: z.string().nullable() })
  ),
});

// The MR's own sample stock changing OUTSIDE a doctor visit: received from
// the company, or going out for a reason (expired, damaged, …). Never moves
// stock by itself — code turns it into a report the manager approves.
export const STOCK_OUT_REASONS = ["expired", "damaged", "returned", "lost", "unspecified"] as const;
const StockReport = z.object({
  kind: z.enum(["received", "out"]),
  reason: z.enum(STOCK_OUT_REASONS).nullable(), // only for "out"
  product: EntityRef,
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
});

export const ExtractionSchema = z.object({
  visits: z.array(Visit),
  chemistCalls: z.array(ChemistCall),
  stockReports: z.array(StockReport),
  adverseEvent: z.object({
    mentioned: z.boolean(),
    summary: z.string().nullable(), // no patient identifiers
  }),
  correction: z.object({
    isCorrection: z.boolean(),
    description: z.string().nullable(),
  }),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedVisit = z.infer<typeof Visit>;
export type ExtractedDue = z.infer<typeof Due>;
export type ExtractedStockReport = z.infer<typeof StockReport>;

/**
 * Parse an extraction stored on a Message. Notes saved before a field was
 * added (e.g. stockReports, 2026-11-17) get its empty default, so old
 * NEEDS_REVIEW notes can still be re-evaluated. The LLM schema stays strict.
 */
export function parseStoredExtraction(stored: unknown) {
  const base = stored && typeof stored === "object" ? stored : {};
  return ExtractionSchema.safeParse({ stockReports: [], ...base });
}
