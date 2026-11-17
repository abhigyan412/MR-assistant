import type { MrContext } from "../lib/context";
import { interpret, normalizeUnit } from "../lib/interpret";
export { normalizeUnit };
import { resolveDue } from "../lib/dates";
import type { Extraction } from "../lib/extraction-schema";
import { matchChemist, matchDoctor, matchManager, matchProduct, type MatchDecision } from "../lib/matching";
import type { Ambiguous, ChemistCallExpect, Code, DoctorExpect, EvalCase, ProductExpect, VisitExpect } from "./cases";

// Scores one LLM extraction against a case's `expect`. Pure function, no I/O.
//
// A check marked `critical` is the kind of error that would corrupt the
// compliance record if it reached PROCESSED: a wrong/guessed doctor or
// product, a wrong or guessed quantity/unit, an invented visit, or patient
// data leaking into the output. The headline requirement is ZERO criticals.

export interface Check {
  name: string;
  pass: boolean;
  critical: boolean;
  detail?: string;
}

export interface CaseScore {
  id: string;
  checks: Check[];
  pass: boolean;
  criticalFailures: number;
  privacyLeaks: number;
}

type Ref = { mention: string; ref: string | null };
type Kind = "doctor" | "product" | "manager" | "chemist";

function isAmbiguous(x: unknown): x is Ambiguous {
  return typeof x === "object" && x !== null && "ambiguous" in x;
}

/**
 * The extraction as the pipeline will see it: a ref the model left null is
 * filled with what the deterministic matcher resolves on its own (unique
 * surname + honorific, unique brand prefix, sound-alike / Devanagari
 * spellings), since that reaches the record without a tap. Refs the model did
 * set are kept as-is, so its own guesses are still scored. A matcher result
 * inside an ambiguous set is therefore scored as a (critical) guess too.
 */
export function withAutoRefs(extraction: Extraction, ctx: MrContext): { extraction: Extraction; auto: number } {
  const none = new Map<string, string>();
  let auto = 0;
  const refOf = (list: { id: string; ref: string }[], id: string) => list.find((e) => e.id === id)?.ref ?? null;
  const fill = <T extends { mention: string; ref: string | null }>(r: T, resolve: (m: string) => MatchDecision, list: { id: string; ref: string }[]): T => {
    if (r.ref !== null) return r;
    const d = resolve(r.mention);
    if (d.status !== "matched") return r;
    auto++;
    return { ...r, ref: refOf(list, d.id) };
  };
  const product = <T extends { mention: string; ref: string | null }>(r: T) => fill(r, (m) => matchProduct(m, null, ctx, none), ctx.products);
  const manager = <T extends { mention: string; ref: string | null }>(r: T) => fill(r, (m) => matchManager(m, null, ctx), ctx.managers);
  const chemist = <T extends { mention: string; ref: string | null }>(r: T) => fill(r, (m) => matchChemist(m, null, ctx), ctx.chemists);

  const e: Extraction = structuredClone(extraction);
  for (const v of e.visits) {
    v.doctor = fill(v.doctor, (m) => matchDoctor(m, null, v.doctor.evidence, ctx, none), ctx.doctors);
    v.jointWork = v.jointWork.map(manager);
    v.detailed = v.detailed.map(product);
    for (const s of v.samples) s.product = product(s.product);
    for (const q of v.queries) if (q.product) q.product = product(q.product);
    for (const p of v.pobs) {
      p.product = product(p.product);
      if (p.chemist) p.chemist = chemist(p.chemist);
    }
  }
  for (const c of e.chemistCalls) {
    c.chemist = chemist(c.chemist);
    for (const p of c.pobs) p.product = product(p.product);
  }
  for (const sr of e.stockReports) sr.product = product(sr.product);
  return { extraction: e, auto };
}

export function scoreCase(evalCase: EvalCase, modelExtraction: Extraction, ctx: MrContext, unknownRefs: string[]): CaseScore {
  const extraction = withAutoRefs(modelExtraction, ctx).extraction;
  const expect = evalCase.expect;
  if (!expect) throw new Error(`${evalCase.id} has no LLM-level expectations`);
  const recordedAt = new Date(evalCase.recordedAt ?? "2026-11-18T11:00:00+05:30");
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, critical = false, detail?: string) =>
    checks.push({ name, pass, critical: !pass && critical, detail });

  const codeOf = (kind: Kind, ref: string | null): Code | null => {
    if (ref === null) return null;
    const list =
      kind === "doctor" ? ctx.doctors : kind === "product" ? ctx.products : kind === "manager" ? ctx.managers : ctx.chemists;
    return list.find((e) => e.ref === ref)?.code ?? `?${ref}`;
  };
  const label = (kind: Kind, r: Ref) => `${r.mention}${r.ref ? `→${codeOf(kind, r.ref)}` : "→(unresolved)"}`;

  // ── Visits ────────────────────────────────────────────────────────────
  const actualVisits = extraction.visits;
  add("visit count", actualVisits.length === expect.visits.length, false, `expected ${expect.visits.length}, got ${actualVisits.length}`);

  const used = new Set<number>();
  const pairs: { exp: VisitExpect; idx: number | null }[] = expect.visits.map((exp) => ({ exp, idx: null }));

  // Pass 1: exact doctor code. Pass 2: new doctor by mention. Pass 3: ambiguous -> unresolved.
  for (const pair of pairs) {
    const d = pair.exp.doctor;
    if (typeof d !== "string") continue;
    const idx = actualVisits.findIndex((v, i) => !used.has(i) && codeOf("doctor", v.doctor.ref) === d);
    if (idx >= 0) {
      used.add(idx);
      pair.idx = idx;
    }
  }
  for (const pair of pairs) {
    const d = pair.exp.doctor;
    if (typeof d === "string" || isAmbiguous(d) || pair.idx !== null) continue;
    const needle = d.newDoctor.toLowerCase();
    const idx = actualVisits.findIndex((v, i) => !used.has(i) && v.doctor.mention.toLowerCase().includes(needle));
    if (idx >= 0) {
      used.add(idx);
      pair.idx = idx;
    }
  }
  for (const pair of pairs) {
    if (pair.idx !== null) continue;
    // Prefer an unresolved visit; otherwise take the next unused one (it will
    // be flagged as a wrong/guessed doctor below).
    let idx = actualVisits.findIndex((v, i) => !used.has(i) && v.doctor.ref === null);
    if (idx < 0) idx = actualVisits.findIndex((_, i) => !used.has(i));
    if (idx >= 0) {
      used.add(idx);
      pair.idx = idx;
    }
  }

  pairs.forEach(({ exp, idx }, n) => {
    const tag = `visit ${n + 1} (${describeDoctor(exp.doctor)})`;
    if (idx === null) {
      add(`${tag}: found`, false, false, "no matching visit in output");
      return;
    }
    const v = actualVisits[idx];
    checkDoctor(tag, exp.doctor, v.doctor);

    const expectMet = exp.met ?? true;
    add(`${tag}: met`, v.met === expectMet, false, `expected ${expectMet}, got ${v.met}`);

    if (exp.dayOffset !== "any") {
      const want = exp.dayOffset ?? 0;
      add(`${tag}: day`, v.dayOffset === want, true, `expected dayOffset ${want}, got ${v.dayOffset}`);
    }
    if (exp.jointWork !== "any") {
      matchRefs(`${tag}: joint work`, "manager", exp.jointWork ?? [], v.jointWork);
    }
    if (exp.detailed !== "any") {
      matchRefs(`${tag}: detailed`, "product", exp.detailed ?? [], v.detailed);
    }
    if (exp.samples !== "any") {
      matchQuantities(`${tag}: samples`, exp.samples ?? [], v.samples);
    }
    if (exp.queries !== "any") {
      const want = exp.queries ?? [];
      add(`${tag}: query count`, v.queries.length === want.length, false, `expected ${want.length}, got ${v.queries.length}`);
      const wantProducts = want.map((q) => q.product ?? "-").sort();
      const gotProducts = v.queries.map((q) => codeOf("product", q.product?.ref ?? null) ?? "-").sort();
      add(`${tag}: query products`, wantProducts.join() === gotProducts.join(), false, `expected [${wantProducts}], got [${gotProducts}]`);
    }
    if (exp.followUps !== "any") {
      const want = (exp.followUps ?? []).map((f) => f.due ?? "-").sort();
      const got = v.followUps.map((f) => resolveDue(recordedAt, f.due).date ?? "-").sort();
      add(`${tag}: follow-ups`, want.join() === got.join(), false, `expected [${want}], got [${got}]`);
    }
    if (exp.pobs !== "any") {
      const want = exp.pobs ?? [];
      matchQuantities(`${tag}: pob`, want, v.pobs);
      for (const w of want) {
        if (w.chemist === undefined) continue;
        const got = v.pobs.find((p) => productMatches(w.product, p.product));
        if (got) {
          const gotChemist = got.chemist ? codeOf("chemist", got.chemist.ref) : null;
          add(`${tag}: pob chemist`, gotChemist === w.chemist, false, `expected ${w.chemist}, got ${gotChemist}`);
        }
      }
    }
  });

  actualVisits.forEach((v, i) => {
    if (used.has(i)) return;
    const code = codeOf("doctor", v.doctor.ref);
    add("no unexpected visits", false, code !== null, `unexpected visit: ${label("doctor", v.doctor)}`);
  });

  // ── Chemist calls ─────────────────────────────────────────────────────
  const wantCalls: ChemistCallExpect[] = expect.chemistCalls ?? [];
  add("chemist call count", extraction.chemistCalls.length === wantCalls.length, false, `expected ${wantCalls.length}, got ${extraction.chemistCalls.length}`);
  for (const w of wantCalls) {
    const got = extraction.chemistCalls.find((c) => codeOf("chemist", c.chemist.ref) === w.chemist);
    if (!got) {
      add(`chemist call ${w.chemist}: found`, false);
      continue;
    }
    matchQuantities(`chemist call ${w.chemist}: pob`, w.pobs, got.pobs);
  }

  // ── Stock reports (stock received / out, outside a visit) ─────────────
  const wantStock = expect.stockReports ?? [];
  add("stock report count", extraction.stockReports.length === wantStock.length, false, `expected ${wantStock.length}, got ${extraction.stockReports.length}`);
  for (const kind of ["received", "out"] as const) {
    const want = wantStock.filter((w) => w.kind === kind);
    const got = extraction.stockReports.filter((g) => g.kind === kind);
    // An invented stock change is critical even though a manager approves it.
    matchQuantities(`stock ${kind}`, want, got);
    for (const w of want) {
      if (w.reason === undefined) continue;
      const g = got.find((x) => productMatches(w.product, x.product));
      if (g) add(`stock ${kind} ${describe(w.product)}: reason`, (g.reason ?? null) === w.reason, false, `expected ${w.reason}, got ${g.reason}`);
    }
  }

  // ── Flags, privacy, refs ──────────────────────────────────────────────
  const wantAe = expect.adverseEvent ?? false;
  add("adverse-event flag", extraction.adverseEvent.mentioned === wantAe, wantAe, `expected ${wantAe}, got ${extraction.adverseEvent.mentioned}`);
  const wantCorrection = expect.correction ?? false;
  add("correction flag", extraction.correction.isCorrection === wantCorrection, wantCorrection, `expected ${wantCorrection}, got ${extraction.correction.isCorrection}`);

  let privacyLeaks = 0;
  const serialized = JSON.stringify(modelExtraction);
  for (const pattern of expect.forbidden ?? []) {
    const hit = new RegExp(pattern, "i").exec(serialized);
    if (hit) privacyLeaks++;
    add(`no patient data /${pattern}/`, !hit, true, hit ? `found "${hit[0]}"` : undefined);
  }
  add("refs all in shortlist", unknownRefs.length === 0, false, unknownRefs.join(", "));

  const criticalFailures = checks.filter((c) => c.critical).length;
  return { id: evalCase.id, checks, pass: checks.every((c) => c.pass), criticalFailures, privacyLeaks };

  // ── helpers (closures over ctx/add) ─────────────────────────────────────

  function checkDoctor(tag: string, want: DoctorExpect, got: { mention: string; ref: string | null }) {
    const gotCode = codeOf("doctor", got.ref);
    if (typeof want === "string") {
      if (gotCode === want) add(`${tag}: doctor`, true);
      else if (gotCode === null) add(`${tag}: doctor`, false, false, `left unresolved ("${got.mention}") — safe but needs a tap`);
      else add(`${tag}: doctor`, false, true, `WRONG doctor ${gotCode}`);
    } else if (isAmbiguous(want)) {
      add(`${tag}: doctor not guessed`, gotCode === null, true, gotCode ? `guessed ${gotCode} among ${want.ambiguous}` : undefined);
    } else {
      const mentionOk = got.mention.toLowerCase().includes(want.newDoctor.toLowerCase());
      add(`${tag}: new doctor not matched`, gotCode === null, true, gotCode ? `matched to existing ${gotCode}` : undefined);
      add(`${tag}: new doctor name kept`, mentionOk, false, `mention "${got.mention}"`);
    }
  }

  function productMatches(want: ProductExpect, got: Ref): boolean {
    const code = codeOf("product", got.ref);
    return isAmbiguous(want) ? code === null : code === want;
  }

  function matchRefs(tag: string, kind: Kind, want: (Code | Ambiguous)[], got: Ref[]) {
    const remaining = [...got];
    for (const w of want) {
      const i = remaining.findIndex((g) =>
        isAmbiguous(w) ? g.ref === null : codeOf(kind, g.ref) === w
      );
      if (i >= 0) {
        remaining.splice(i, 1);
        add(`${tag}: ${describe(w)}`, true);
      } else {
        // A guess within an ambiguous set is critical; a missing item is not.
        const guessed = isAmbiguous(w) && got.some((g) => w.ambiguous.includes(codeOf(kind, g.ref) ?? ""));
        add(`${tag}: ${describe(w)}`, false, guessed, guessed ? `guessed among ${w.ambiguous}` : `missing; got [${got.map((g) => label(kind, g))}]`);
      }
    }
    for (const extra of remaining) {
      const code = codeOf(kind, extra.ref);
      const guessedAmbiguous = want.some((w) => isAmbiguous(w) && code !== null && w.ambiguous.includes(code));
      if (guessedAmbiguous) continue; // already reported above
      add(`${tag}: nothing extra`, false, code !== null && kind === "product", `unexpected ${label(kind, extra)}`);
    }
  }

  function matchQuantities(
    tag: string,
    want: { product: ProductExpect; quantity: number | null; unit: string | null }[],
    got: { product: Ref; quantity: number | null; unit: string | null }[]
  ) {
    const remaining = [...got];
    for (const w of want) {
      const i = remaining.findIndex((g) => productMatches(w.product, g.product));
      const name = `${tag} ${describe(w.product)}`;
      if (i < 0) {
        const guessed =
          isAmbiguous(w.product) &&
          got.some((g) => (w.product as Ambiguous).ambiguous.includes(codeOf("product", g.product.ref) ?? ""));
        add(`${name}: found`, false, guessed, guessed ? "guessed a product in an ambiguous family" : "missing");
        continue;
      }
      const g = remaining.splice(i, 1)[0];
      const qtyOk = g.quantity === w.quantity;
      add(`${name}: quantity`, qtyOk, true, `expected ${w.quantity}, got ${g.quantity}`);
      // Unit not said (expected null): naming the product's ONLY unit is the
      // same fact the pipeline fills in from master data, so it is not a guess.
      const product = ctx.products.find((p) => p.ref === g.product.ref);
      const onlyUnit = product && product.units.length === 0 ? product.baseUnit : null;
      const unitOk =
        normalizeUnit(g.unit) === normalizeUnit(w.unit) || (w.unit === null && onlyUnit !== null && normalizeUnit(g.unit) === onlyUnit);
      add(`${name}: unit`, unitOk, true, `expected ${w.unit}, got ${g.unit}`);
    }
    for (const extra of remaining) {
      add(`${tag}: nothing extra`, false, extra.product.ref !== null, `unexpected ${label("product", extra.product)} x${extra.quantity} ${extra.unit}`);
    }
  }
}

function describe(x: Code | Ambiguous): string {
  return isAmbiguous(x) ? `ambiguous(${x.ambiguous.join("|")})` : x;
}

function describeDoctor(d: DoctorExpect): string {
  if (typeof d === "string") return d;
  if (isAmbiguous(d)) return `ambiguous ${d.ambiguous.join("|")}`;
  return `new: ${d.newDoctor}`;
}

// ── Pipeline layer (Phase 1+) ───────────────────────────────────────────────
// Runs the deterministic interpretation on the extraction, offline, with the
// seed opening stock and no earlier notes, and compares the final status and
// review-card kinds to `case.pipeline`. DUPLICATE cases need the DB (tested in
// tests/pipeline.db.test.ts) and are not scored here.

export interface PipelineScore {
  id: string;
  pass: boolean;
  expected: string;
  got: string;
}

export function scorePipeline(
  evalCase: EvalCase,
  extraction: Extraction,
  ctx: MrContext,
  stock: Map<string, number>
): PipelineScore | null {
  if (evalCase.pipeline.status === "DUPLICATE") return null;
  const result = interpret({
    extraction,
    ctx,
    recordedAt: new Date(evalCase.recordedAt ?? "2026-11-18T11:00:00+05:30"),
    aliases: { doctor: new Map(), product: new Map() },
    stock,
    priorVisits: [],
    recentSamples: [],
    resolutions: [],
    confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD) || 0.6,
  });
  const status = result.blocking ? "NEEDS_REVIEW" : "PROCESSED";
  const kinds = [...new Set(result.reviewItems.map((r) => r.kind))].sort();
  const wantKinds = [...new Set(evalCase.pipeline.reviewKinds ?? [])].sort();
  const expected = `${evalCase.pipeline.status} [${wantKinds.join(", ")}]`;
  const got = `${status} [${kinds.join(", ")}]`;
  return { id: evalCase.id, pass: expected === got, expected, got };
}
