import { z } from "zod";

// Event-type registry. Event.type is a plain string in the DB; this module is
// the single place that says which types exist, what their payload looks like,
// and which indexed columns each type must/must not set.
//
// Changing a payload field after the partner demo = edit the schema here and
// bump its `version`. Adding a type = add an entry. No DB migration either way.
//
// Later (out of MVP): `rcpa_entry` (chemistId column already exists).
// Tour plan is NOT an event — it will be its own TourPlan table.

const nonEmpty = z.string().trim().min(1);

export const EVENT_TYPES = {
  doctor_visit: {
    version: 1,
    payload: z.object({
      met: z.boolean(), // false = doctor not available; shown as "missed" in DCR
      visitTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(), // IST "HH:MM" if stated
      timeKnown: z.boolean(),
      rawDoctorMention: nonEmpty,
    }),
    requires: ["doctorId"],
    stockMoving: false,
    llmExtracted: true,
  },
  product_detailed: {
    version: 1,
    payload: z.object({ rawProductMention: nonEmpty }), // one event per product
    requires: ["productId", "visitEventId"],
    stockMoving: false,
    llmExtracted: true,
  },
  sample_given: {
    version: 1,
    payload: z.object({
      quantity: z.number().int().positive(), // as spoken
      unit: nonEmpty, // as spoken, normalized ("strip", "box")
      rawProductMention: nonEmpty,
    }),
    // stockDelta = -(quantity x ProductUnit.toBase), computed by code
    requires: ["productId", "visitEventId", "stockDelta"],
    stockMoving: true,
    llmExtracted: true,
  },
  doctor_query: {
    version: 1,
    payload: z.object({
      question: nonEmpty, // English, never contains patient identifiers
      rawProductMention: nonEmpty.nullable(),
    }),
    requires: ["visitEventId"],
    stockMoving: false,
    llmExtracted: true,
  },
  follow_up: {
    version: 1,
    payload: z.object({
      action: nonEmpty,
      whenPhrase: z.string().nullable(), // classification from the LLM, for audit
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), // computed by lib/dates.ts
      dueRule: z.string(),
      pendingPartnerConfirmation: z.boolean(),
    }),
    requires: ["doctorId", "visitEventId"],
    stockMoving: false,
    llmExtracted: true,
  },
  pob: {
    version: 1,
    payload: z.object({
      quantity: z.number().int().positive(),
      unit: nonEmpty,
      orderedBy: z.enum(["doctor", "chemist"]),
      chemistName: nonEmpty.nullable(),
      rawProductMention: nonEmpty,
    }),
    // POB never moves sample stock. visitEventId is null for a chemist call.
    requires: ["productId"],
    stockMoving: false,
    llmExtracted: true,
  },
  joint_work: {
    version: 1,
    payload: z.object({ rawMention: nonEmpty }),
    requires: ["managerId", "visitEventId"],
    stockMoving: false,
    llmExtracted: true,
  },
  sample_received: {
    version: 2, // v2: source "mr_report" (MR reported, manager approved) + approvedById
    payload: z.object({
      quantity: z.number().int().positive(),
      unit: nonEmpty,
      note: z.string().nullable(),
      source: z.enum(["opening_stock", "admin_entry", "dispatch_file", "mr_report"]),
      approvedById: z.string().optional(), // set for mr_report
    }),
    // Admin entry, or an MR report written only after a manager approves it.
    requires: ["productId", "stockDelta"],
    stockMoving: true,
    llmExtracted: false,
  },
  stock_adjusted: {
    version: 1,
    payload: z.object({
      quantity: z.number().int().positive(),
      unit: nonEmpty,
      reason: z.enum(["expired", "damaged", "returned", "lost", "unspecified"]),
      rawProductMention: nonEmpty,
      approvedById: nonEmpty,
    }),
    // Sample stock going out NOT to a doctor (MR report, manager approved).
    // stockDelta is negative; stock never goes below zero (checked on approval).
    requires: ["productId", "stockDelta"],
    stockMoving: true,
    llmExtracted: false,
  },
} as const;

export type EventType = keyof typeof EVENT_TYPES;
export const EVENT_TYPE_NAMES = Object.keys(EVENT_TYPES) as EventType[];

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_TYPES)[T]["payload"]>;

export function isEventType(value: string): value is EventType {
  return value in EVENT_TYPES;
}

type ColumnName = "doctorId" | "productId" | "chemistId" | "managerId" | "visitEventId" | "stockDelta";

export interface EventDraft {
  type: string;
  payload: unknown;
  doctorId?: string | null;
  productId?: string | null;
  chemistId?: string | null;
  managerId?: string | null;
  visitEventId?: string | null;
  stockDelta?: number | null;
  reversesEventId?: string | null;
}

/**
 * Validate an event before it is written to the ledger. Throws on any
 * violation — the caller treats that as a bug, not as NEEDS_REVIEW (review
 * decisions happen before a draft is built).
 */
export function validateEventDraft(draft: EventDraft): { schemaVersion: number; payload: unknown } {
  if (!isEventType(draft.type)) {
    throw new Error(`Unknown event type "${draft.type}"`);
  }
  const def = EVENT_TYPES[draft.type];
  const parsed = def.payload.safeParse(draft.payload);
  if (!parsed.success) {
    throw new Error(`Invalid ${draft.type} payload: ${parsed.error.message}`);
  }
  // A reversal mirrors its original, so it inherits the same required columns.
  for (const column of def.requires as readonly ColumnName[]) {
    const value = draft[column];
    if (value === null || value === undefined) {
      throw new Error(`${draft.type} requires ${column}`);
    }
  }
  if (!def.stockMoving && draft.stockDelta != null) {
    throw new Error(`${draft.type} must not set stockDelta`);
  }
  if (draft.type === "sample_given" && !draft.reversesEventId && (draft.stockDelta ?? 0) >= 0) {
    throw new Error("sample_given must have a negative stockDelta");
  }
  if (draft.type === "sample_received" && !draft.reversesEventId && (draft.stockDelta ?? 0) <= 0) {
    throw new Error("sample_received must have a positive stockDelta");
  }
  if (draft.type === "stock_adjusted" && !draft.reversesEventId && (draft.stockDelta ?? 0) >= 0) {
    throw new Error("stock_adjusted must have a negative stockDelta");
  }
  return { schemaVersion: def.version, payload: parsed.data };
}
