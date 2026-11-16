import type { CtxProduct, MrContext } from "./context";
import { resolveDue, resolveOccurredAt } from "./dates";
import type { Extraction } from "./extraction-schema";
import { matchChemist, matchDoctor, matchManager, matchProduct, type Candidate, type MatchDecision } from "./matching";

// The deterministic heart of the pipeline. Pure function: no DB, no LLM.
// Takes a validated extraction plus everything known about the MR's world
// and returns EITHER review cards (anything unsure) OR a fully resolved plan
// of events to write. Re-run after every review resolution with the
// resolutions applied, until nothing blocking is left.

export type ReviewKind =
  | "DOCTOR_AMBIGUOUS"
  | "DOCTOR_NOT_FOUND"
  | "PRODUCT_AMBIGUOUS"
  | "PRODUCT_NOT_FOUND"
  | "MANAGER_AMBIGUOUS"
  | "QUANTITY_MISSING"
  | "UNIT_UNKNOWN"
  | "LOW_CONFIDENCE"
  | "VISIT_STATUS_CONFLICT"
  | "POSSIBLE_DUPLICATE_VISIT"
  | "CORRECTION_REQUESTED"
  | "STOCK_INSUFFICIENT"
  | "ADVERSE_EVENT";

export type Resolution =
  | { action: "pick"; id: string }
  | { action: "quantity"; quantity: number; unit: string }
  | { action: "drop" }
  | { action: "accept" }
  | { action: "visitStatus"; met: boolean }
  | { action: "secondVisit" }
  | { action: "sameVisit" }
  | { action: "reverse"; eventIds: string[] }
  | { action: "notCorrection" }
  | { action: "acknowledge" }
  | { action: "newDoctor"; name: string; specialty: string | null; area: string | null };

export interface ReviewDraft {
  kind: ReviewKind;
  path: string; // where in the extraction, e.g. "visits[0].samples[1]"
  rawMention: string | null;
  candidates: Candidate[] | null;
  assignee: "MR" | "MANAGER";
  blocking: boolean;
  detail: string;
}

export interface RecentSample {
  eventId: string;
  doctorId: string | null;
  doctorName: string;
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  stockDelta: number;
  occurredOn: string;
  visitEventId: string | null;
}

export interface InterpretInput {
  extraction: Extraction;
  ctx: MrContext;
  recordedAt: Date;
  aliases: { doctor: Map<string, string>; product: Map<string, string> };
  stock: Map<string, number>; // productId -> current balance in base units
  priorVisits: { doctorId: string; occurredOn: string; messageId: string }[]; // from OTHER messages
  recentSamples: RecentSample[]; // un-reversed sample_given events, candidates for corrections
  resolutions: { path: string; resolution: Resolution }[];
  confidenceThreshold: number;
}

export interface PlannedItem {
  productId: string;
  mention: string;
  quantity: number;
  unit: string;
  baseQuantity: number;
}

export interface PlannedVisit {
  path: string;
  // Set when this note corrects an earlier one: the corrected facts attach to
  // the original visit instead of logging a second visit to the same doctor.
  existingVisitId: string | null;
  doctorId: string;
  doctorMention: string;
  met: boolean;
  occurredAt: Date;
  occurredOn: string;
  visitTime: string | null;
  timeKnown: boolean;
  confidence: number;
  jointWork: { managerId: string; mention: string }[];
  detailed: { productId: string; mention: string }[];
  samples: PlannedItem[];
  queries: { question: string; productId: string | null; mention: string | null }[];
  followUps: { action: string; whenPhrase: string; dueDate: string | null; dueRule: string; pending: boolean }[];
  pobs: (PlannedItem & { chemistId: string | null; chemistName: string | null })[];
}

export interface PlannedChemistCall {
  chemistId: string | null;
  chemistName: string;
  occurredAt: Date;
  occurredOn: string;
  pobs: PlannedItem[];
}

export interface Plan {
  visits: PlannedVisit[];
  chemistCalls: PlannedChemistCall[];
  reversals: string[]; // event ids to reverse (corrections)
}

export interface InterpretResult {
  reviewItems: ReviewDraft[];
  blocking: boolean;
  adverseEvent: boolean;
  plan: Plan;
}

export function interpret(input: InterpretInput): InterpretResult {
  const { extraction, ctx, recordedAt } = input;
  const reviews: ReviewDraft[] = [];
  const review = (d: Omit<ReviewDraft, "assignee" | "blocking"> & Partial<Pick<ReviewDraft, "assignee" | "blocking">>) =>
    reviews.push({ assignee: "MR", blocking: true, ...d });

  const resolutionsAt = (path: string) => input.resolutions.filter((r) => r.path === path).map((r) => r.resolution);
  const resolved = <A extends Resolution["action"]>(path: string, action: A) =>
    resolutionsAt(path).find((r): r is Extract<Resolution, { action: A }> => r.action === action);

  const plan: Plan = { visits: [], chemistCalls: [], reversals: [] };

  // ── entity resolution helpers ─────────────────────────────────────────
  function product(path: string, mention: string, llmRef: string | null): CtxProduct | null | "dropped" {
    if (resolved(path, "drop")) return "dropped";
    const pick = resolved(path, "pick");
    if (pick) return ctx.products.find((p) => p.id === pick.id) ?? null;
    const d = matchProduct(mention, llmRef, ctx, input.aliases.product);
    if (d.status === "matched") return ctx.products.find((p) => p.id === d.id)!;
    review({
      kind: d.status === "ambiguous" ? "PRODUCT_AMBIGUOUS" : "PRODUCT_NOT_FOUND",
      path,
      rawMention: mention,
      candidates: d.candidates,
      detail: d.status === "ambiguous" ? `Which product is "${mention}"?` : `"${mention}" is not in the product list`,
    });
    return null;
  }

  // Quantity + unit -> base units, via the product master. Never guessed.
  function quantity(
    path: string,
    p: CtxProduct,
    raw: { quantity: number | null; unit: string | null }
  ): { quantity: number; unit: string; baseQuantity: number } | null {
    const fix = resolved(path, "quantity");
    const q = fix ? fix.quantity : raw.quantity;
    const u = normalizeUnit(fix ? fix.unit : raw.unit);
    const unitOptions = unitChoices(p);
    if (q === null || !Number.isInteger(q) || q <= 0) {
      review({
        kind: "QUANTITY_MISSING",
        path,
        rawMention: p.brandName,
        candidates: unitOptions,
        detail: q === null ? `How many ${p.brandName}?` : `"${q}" is not a whole number — how many ${p.brandName}?`,
      });
      return null;
    }
    // Unit not said: if the product master has only one unit (baseUnit, no
    // ProductUnit rows), that is the unit — a fact from master data, not a
    // guess. Ask only when there is a real choice (e.g. strip vs box).
    if (u === null && p.units.length === 0) return { quantity: q, unit: p.baseUnit, baseQuantity: q };
    if (u === null) {
      review({ kind: "UNIT_UNKNOWN", path, rawMention: `${q} × ${p.brandName}`, candidates: unitOptions, detail: `${q} what? (strip, box…)` });
      return null;
    }
    if (u === p.baseUnit) return { quantity: q, unit: u, baseQuantity: q };
    const conv = p.units.find((x) => x.unit === u);
    if (!conv) {
      review({
        kind: "UNIT_UNKNOWN",
        path,
        rawMention: `${q} ${u} ${p.brandName}`,
        candidates: unitOptions,
        detail: `${p.brandName} has no "${u}" pack in the product master`,
      });
      return null;
    }
    return { quantity: q, unit: u, baseQuantity: q * conv.toBase };
  }

  // ── visits ───────────────────────────────────────────────────────────
  extraction.visits.forEach((v, i) => {
    const path = `visits[${i}]`;
    let doctorId: string | null = null;
    const pick = resolved(`${path}.doctor`, "pick");
    if (pick && ctx.doctors.some((d) => d.id === pick.id)) {
      doctorId = pick.id;
    } else {
      const d: MatchDecision = matchDoctor(v.doctor.mention, v.doctor.ref, v.doctor.evidence, ctx, input.aliases.doctor);
      if (d.status === "matched") doctorId = d.id;
      else
        review({
          kind: d.status === "ambiguous" ? "DOCTOR_AMBIGUOUS" : "DOCTOR_NOT_FOUND",
          path: `${path}.doctor`,
          rawMention: v.doctor.mention,
          candidates: d.candidates,
          detail:
            d.status === "ambiguous"
              ? `Which doctor is "${v.doctor.mention}"?`
              : `"${v.doctor.mention}" is not in your doctor list — add as a new doctor?`,
        });
    }

    const when = resolveOccurredAt(recordedAt, v.dayOffset, v.time);

    // Detailing, samples and orders all require seeing the doctor, so
    // met=false with any of them is a contradiction: ask, never pick a side.
    // (Before this check the items were silently dropped.)
    let met = v.met;
    const statusFix = resolved(path, "visitStatus");
    if (statusFix) met = statusFix.met;
    else if (!v.met && (v.detailed.length > 0 || v.samples.length > 0 || v.pobs.length > 0)) {
      review({
        kind: "VISIT_STATUS_CONFLICT",
        path,
        rawMention: v.doctor.mention,
        candidates: null,
        detail: `The note says ${v.doctor.mention} wasn't met, but also lists products detailed, samples or an order. Did you meet the doctor?`,
      });
    }

    if (v.confidence < input.confidenceThreshold && !resolved(path, "accept")) {
      review({
        kind: "LOW_CONFIDENCE",
        path,
        rawMention: v.doctor.mention,
        candidates: null,
        detail: `Not sure this visit was read correctly (confidence ${v.confidence.toFixed(2)}) — please check`,
      });
    }

    const jointWork: PlannedVisit["jointWork"] = [];
    v.jointWork.forEach((m, j) => {
      const mpath = `${path}.jointWork[${j}]`;
      if (resolved(mpath, "drop")) return;
      const mp = resolved(mpath, "pick");
      if (mp && ctx.managers.some((x) => x.id === mp.id)) return void jointWork.push({ managerId: mp.id, mention: m.mention });
      const d = matchManager(m.mention, m.ref, ctx);
      if (d.status === "matched") jointWork.push({ managerId: d.id, mention: m.mention });
      else
        review({ kind: "MANAGER_AMBIGUOUS", path: mpath, rawMention: m.mention, candidates: d.candidates, detail: `Which manager was with you ("${m.mention}")?` });
    });

    const detailed: PlannedVisit["detailed"] = [];
    const samples: PlannedItem[] = [];
    const queries: PlannedVisit["queries"] = [];
    const followUps: PlannedVisit["followUps"] = [];
    const pobs: PlannedVisit["pobs"] = [];

    if (met) {
      v.detailed.forEach((p, j) => {
        const r = product(`${path}.detailed[${j}]`, p.mention, p.ref);
        if (r && r !== "dropped" && !detailed.some((x) => x.productId === r.id)) detailed.push({ productId: r.id, mention: p.mention });
      });
      v.samples.forEach((s, j) => {
        const spath = `${path}.samples[${j}]`;
        if (resolved(spath, "drop")) return;
        const r = product(`${spath}.product`, s.product.mention, s.product.ref);
        if (!r || r === "dropped") return;
        const q = quantity(spath, r, s);
        if (q) samples.push({ productId: r.id, mention: s.product.mention, ...q });
      });
      v.queries.forEach((q) => {
        // A query's product is optional context: link it when sure, never ask.
        let productId: string | null = null;
        if (q.product) {
          const d = matchProduct(q.product.mention, q.product.ref, ctx, input.aliases.product);
          if (d.status === "matched") productId = d.id;
        }
        queries.push({ question: q.question, productId, mention: q.product?.mention ?? null });
      });
      v.pobs.forEach((p, j) => {
        const ppath = `${path}.pobs[${j}]`;
        if (resolved(ppath, "drop")) return;
        const r = product(`${ppath}.product`, p.product.mention, p.product.ref);
        if (!r || r === "dropped") return;
        const q = quantity(ppath, r, p);
        if (!q) return;
        let chemistId: string | null = null;
        if (p.chemist) {
          const c = matchChemist(p.chemist.mention, p.chemist.ref, ctx);
          if (c.status === "matched") chemistId = c.id;
        }
        pobs.push({ productId: r.id, mention: p.product.mention, ...q, chemistId, chemistName: p.chemist?.mention ?? null });
      });
    }
    // Follow-ups apply even when the doctor was not met ("kal aana").
    v.followUps.forEach((f) => {
      const due = resolveDue(recordedAt, f.due);
      followUps.push({
        action: f.action,
        whenPhrase: describeDue(f.due),
        dueDate: due.date,
        dueRule: due.rule,
        pending: due.pendingPartnerConfirmation,
      });
    });

    if (doctorId) {
      // A correction note re-mentions the same visit by design; it is not a duplicate.
      const dup = input.priorVisits.find((p) => p.doctorId === doctorId && p.occurredOn === when.occurredOn);
      if (dup && !extraction.correction.isCorrection && !resolved(path, "secondVisit")) {
        review({
          kind: "POSSIBLE_DUPLICATE_VISIT",
          path,
          rawMention: v.doctor.mention,
          candidates: null,
          detail: `A visit to this doctor on ${when.occurredOn} is already logged — same visit, or a second one?`,
        });
      }
      plan.visits.push({
        path,
        existingVisitId: null,
        doctorId,
        doctorMention: v.doctor.mention,
        met,
        occurredAt: when.occurredAt,
        occurredOn: when.occurredOn,
        visitTime: v.time,
        timeKnown: when.timeKnown,
        confidence: v.confidence,
        jointWork,
        detailed,
        samples,
        queries,
        followUps,
        pobs,
      });
    }
  });

  // ── chemist calls ────────────────────────────────────────────────────
  extraction.chemistCalls.forEach((c, i) => {
    const path = `chemistCalls[${i}]`;
    const m = matchChemist(c.chemist.mention, c.chemist.ref, ctx);
    const when = resolveOccurredAt(recordedAt, c.dayOffset, null);
    const pobs: PlannedItem[] = [];
    c.pobs.forEach((p, j) => {
      const ppath = `${path}.pobs[${j}]`;
      if (resolved(ppath, "drop")) return;
      const r = product(`${ppath}.product`, p.product.mention, p.product.ref);
      if (!r || r === "dropped") return;
      const q = quantity(ppath, r, p);
      if (q) pobs.push({ productId: r.id, mention: p.product.mention, ...q });
    });
    plan.chemistCalls.push({
      chemistId: m.status === "matched" ? m.id : null,
      chemistName: c.chemist.mention,
      occurredAt: when.occurredAt,
      occurredOn: when.occurredOn,
      pobs,
    });
  });

  // ── corrections ──────────────────────────────────────────────────────
  if (extraction.correction.isCorrection) {
    const reverse = resolved("message", "reverse");
    if (reverse) {
      plan.reversals = reverse.eventIds;
      for (const v of plan.visits) {
        const original = input.recentSamples.find(
          (s) => reverse.eventIds.includes(s.eventId) && s.doctorId === v.doctorId && s.visitEventId
        );
        if (original) v.existingVisitId = original.visitEventId;
      }
    } else if (!resolved("message", "notCorrection")) {
      const doctorIds = new Set(plan.visits.map((v) => v.doctorId));
      const productIds = new Set(plan.visits.flatMap((v) => v.samples.map((s) => s.productId)));
      const relevant = input.recentSamples.filter(
        (s) => (doctorIds.size === 0 || (s.doctorId && doctorIds.has(s.doctorId))) && (productIds.size === 0 || productIds.has(s.productId))
      );
      review({
        kind: "CORRECTION_REQUESTED",
        path: "message",
        rawMention: extraction.correction.description,
        candidates: (relevant.length ? relevant : input.recentSamples).slice(0, 6).map((s) => ({
          id: s.eventId,
          label: `${s.doctorName} · ${s.productName} · ${s.quantity} ${s.unit} · ${s.occurredOn}`,
          score: 1,
        })),
        detail: "This note corrects an earlier one. Which earlier entry should be replaced?",
      });
    }
  }

  // ── stock: never let a sample take stock below zero ─────────────────
  const reversedBack = new Map<string, number>();
  for (const id of plan.reversals) {
    const s = input.recentSamples.find((x) => x.eventId === id);
    if (s) reversedBack.set(s.productId, (reversedBack.get(s.productId) ?? 0) - s.stockDelta);
  }
  const needed = new Map<string, { qty: number; path: string; name: string; units: Candidate[] }>();
  plan.visits.forEach((v) =>
    v.samples.forEach((s, j) => {
      const cur = needed.get(s.productId);
      const p = ctx.products.find((x) => x.id === s.productId);
      needed.set(s.productId, {
        qty: (cur?.qty ?? 0) + s.baseQuantity,
        path: cur?.path ?? `${v.path}.samples[${j}]`,
        name: p?.brandName ?? s.mention,
        units: p ? unitChoices(p) : [],
      });
    })
  );
  for (const [productId, need] of needed) {
    const available = (input.stock.get(productId) ?? 0) + (reversedBack.get(productId) ?? 0);
    if (need.qty > available) {
      review({
        kind: "STOCK_INSUFFICIENT",
        path: need.path,
        rawMention: need.name,
        candidates: need.units,
        detail: `Note gives ${need.qty} of ${need.name} but your stock is ${available}. Fix the quantity, or ask admin to log the missing receipt.`,
      });
    }
  }

  // ── adverse event: flag for manager, never blocks the DCR ────────────
  const adverseEvent = extraction.adverseEvent.mentioned;
  if (adverseEvent && !resolved("message.adverseEvent", "acknowledge")) {
    reviews.push({
      kind: "ADVERSE_EVENT",
      path: "message.adverseEvent",
      rawMention: extraction.adverseEvent.summary,
      candidates: null,
      assignee: "MANAGER",
      blocking: false,
      detail: "Possible adverse event reported by a doctor — follow up per pharmacovigilance process.",
    });
  }

  // A generic "please check" adds nothing once the MR is already asked
  // specific questions about this note (or has answered some): they are
  // looking at it anyway. It only stands alone on an otherwise clean note.
  const specific = reviews.some((r) => r.kind !== "LOW_CONFIDENCE" && r.blocking);
  const final = specific || input.resolutions.length > 0 ? reviews.filter((r) => r.kind !== "LOW_CONFIDENCE") : reviews;

  return { reviewItems: final, blocking: final.some((r) => r.blocking), adverseEvent, plan };
}

function unitChoices(p: CtxProduct): Candidate[] {
  return [
    { id: p.baseUnit, label: p.baseUnit, score: 1 },
    ...p.units.map((x) => ({ id: x.unit, label: `${x.unit} (${x.toBase} ${p.baseUnit})`, score: 1 })),
  ];
}

// Spoken / Hinglish / Devanagari unit words -> the unit names used in the
// product master. "packet" stays its own unit: it can mean a sachet or a box
// depending on the brand, so it is never mapped by guess (-> UNIT_UNKNOWN
// unless a product defines a "packet" pack).
const UNIT_ALIASES: Record<string, string> = {
  // bottle
  bottles: "bottle", botal: "bottle", botals: "bottle", bottal: "bottle", botel: "bottle", botle: "bottle",
  "बोतल": "bottle", "बोतलें": "bottle", "बॉटल": "bottle",
  // strip
  strips: "strip", stripe: "strip", stripes: "strip", istrip: "strip", patta: "strip", patte: "strip",
  patti: "strip", pattiyan: "strip", pattiya: "strip", "स्ट्रिप": "strip", "पत्ता": "strip", "पत्ते": "strip", "पत्ती": "strip",
  // box
  boxes: "box", dabba: "box", dabbe: "box", dibba: "box", dibbe: "box", "डब्बा": "box", "डब्बे": "box", "डिब्बा": "box", "डिब्बे": "box", "बॉक्स": "box",
  // sachet
  sachets: "sachet", sache: "sachet", sachey: "sachet", satchet: "sachet", satchets: "sachet", shachet: "sachet",
  sashe: "sachet", "सैशे": "sachet", "सैशै": "sachet", "साशे": "sachet",
  // packet (kept distinct, see above)
  packets: "packet", pkt: "packet", pkts: "packet", paket: "packet", "पैकेट": "packet",
  // others
  tablets: "tablet", tabs: "tablet", tab: "tablet", packs: "pack",
};

export function normalizeUnit(unit: string | null): string | null {
  if (unit === null) return null;
  const u = unit.trim().toLowerCase().replace(/\.$/, "");
  if (!u) return null;
  return UNIT_ALIASES[u] ?? u;
}

function describeDue(due: Extraction["visits"][number]["followUps"][number]["due"]): string {
  switch (due.kind) {
    case "days":
    case "weeks":
    case "months":
      return `${due.amount ?? "?"} ${due.kind}`;
    case "weekday":
      return due.weekday ?? "weekday";
    case "date":
      return `day ${due.day ?? "?"}${due.month ? `/${due.month}` : ""}`;
    default:
      return "unspecified";
  }
}
