import type { CtxDoctor, CtxManager, CtxProduct, MrContext } from "./context";

// Deterministic name matching. The LLM proposes a shortlist ref; this module
// checks that proposal against plain fuzzy/phonetic string similarity and
// decides: accept, ask the MR (ambiguous / confirm), or not found.
//
// Rule of thumb: accept only when two signals agree or one signal is strong
// and unambiguous. Everything else becomes a one-tap review card.

export const AUTO_MATCH = 0.85; // strong match on its own
export const CANDIDATE = 0.7; // worth offering on a review card
export const MARGIN = 0.1; // strong match must beat the runner-up by this much

export interface Candidate {
  id: string;
  label: string;
  score: number;
}

export type MatchDecision =
  | { status: "matched"; id: string; via: "alias" | "fuzzy" | "fuzzy+llm" | "evidence" }
  | { status: "ambiguous"; candidates: Candidate[] }
  | { status: "not_found"; candidates: Candidate[] };

// ── normalization ───────────────────────────────────────────────────────────

const HONORIFICS = new Set([
  "dr", "doctor", "doc", "daktar", "doktar", "sir", "ji", "madam", "mam", "maam", "madame", "sahab", "saab", "sahib",
  "mr", "mrs", "ms", "shri", "smt", "wale", "wala", "wali", "ke", "ki", "ka", "ko", "se", "ne", "the",
  // as transliterated from Devanagari (जी, साहब, मैडम, सर, श्री)
  "jee", "saahab", "saahib", "maidam", "maidum", "mem", "sar", "shree", "kee", "kaa",
]);

// ── Devanagari -> Latin (for matching only; rough, consistent, not pretty) ──
const DEV_CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
};
// Consonant + nukta (़): क़ ख़ ग़ ज़ ड़ ढ़ फ़
const DEV_NUKTA: Record<string, string> = { "क": "q", "ख": "kh", "ग": "g", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f" };
const DEV_VOWELS: Record<string, string> = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o",
};
const DEV_MATRAS: Record<string, string> = {
  "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e",
};
const NUKTA = "़";
const VIRAMA = "्";

/** Transliterate any Devanagari in `text` to rough Latin; other characters pass through. */
export function transliterate(text: string): string {
  const s = text.normalize("NFD"); // splits precomposed nukta letters (ज़ -> ज + ़)
  if (!/[ऀ-ॿ]/.test(s)) return text;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (DEV_CONSONANTS[ch]) {
      let c = DEV_CONSONANTS[ch];
      let j = i + 1;
      if (s[j] === NUKTA) {
        c = DEV_NUKTA[ch] ?? c;
        j++;
      }
      const next = s[j];
      if (next !== undefined && DEV_MATRAS[next]) {
        out += c + DEV_MATRAS[next];
        j++;
      } else if (next === VIRAMA) {
        out += c;
        j++;
      } else {
        // Inherent 'a', dropped at the end of a word (Hindi schwa deletion).
        const endOfWord = next === undefined || !/[ऀ-ॿ]/.test(next);
        out += endOfWord ? c : `${c}a`;
      }
      i = j - 1;
    } else if (DEV_VOWELS[ch]) out += DEV_VOWELS[ch];
    else if (DEV_MATRAS[ch]) out += DEV_MATRAS[ch];
    else if (ch === "ं" || ch === "ँ") out += "n";
    else if (ch === "ः") out += "h";
    else if (ch === NUKTA || ch === VIRAMA) continue;
    else out += ch;
  }
  return out;
}

/** Lowercase, strip accents/punctuation/honorifics; keep word boundaries. */
export function normalizeName(text: string): string {
  const head = transliterate(text).split(/[,(]/)[0]; // "Dr Ritu Arora, skin specialist" -> "Dr Ritu Arora"
  return head
    .replace(/\bdo\./gi, "dr ") // "डॉ." transliterates to "do."
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !HONORIFICS.has(t))
    .join(" ");
}

/**
 * Crude phonetic key for Indian-English spellings: Qureshi ~ Kureshi ~ Kuraishi,
 * Glyconics ~ Glyconix, Coughzen ~ Kafzen.
 */
export function phonetic(text: string): string {
  return text
    .toLowerCase()
    .replace(/ough/g, "af") // cough -> kaf
    .replace(/ai/g, "e") // kuraishi -> kureshi
    .replace(/au/g, "o")
    .replace(/ph/g, "f")
    .replace(/x/g, "ks")
    .replace(/q/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/w/g, "v")
    .replace(/z/g, "j")
    .replace(/([bdgkst])h/g, "$1") // bh dh gh kh sh th -> b d g k s t
    .replace(/ee/g, "i")
    .replace(/oo/g, "u")
    .replace(/y\b/g, "i")
    .replace(/(.)\1+/g, "$1"); // collapse doubled letters
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Sound-alike fallback: spoken/transliterated names mostly differ in vowels
// ("Kafazen" vs "Coughzen"), so also compare consonant skeletons. Discounted
// so a skeleton match alone never beats a real spelling match, and only used
// for skeletons of 3+ consonants (short ones collide too easily).
export const SKELETON_WEIGHT = 0.9;

function skeleton(phoneticKey: string): string {
  return phoneticKey.replace(/(?!^)[aeiou]/g, "").replace(/(.)\1+/g, "$1");
}

function ratio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

export function similarity(a: string, b: string): number {
  const pa = phonetic(a);
  const pb = phonetic(b);
  const full = ratio(pa, pb);
  const sa = skeleton(pa);
  const sb = skeleton(pb);
  if (Math.min(sa.length, sb.length) < 3) return full;
  return Math.max(full, SKELETON_WEIGHT * ratio(sa, sb));
}

// ── doctors ─────────────────────────────────────────────────────────────────

function doctorForms(d: CtxDoctor): string[] {
  const tokens = normalizeName(d.name)
    .split(" ")
    .filter((t) => t.length > 1); // drop initials ("s k mehta" -> "mehta")
  if (tokens.length === 0) return [];
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  return [...new Set([tokens.join(" "), last, first, `${first} ${last}`])];
}

export function scoreDoctor(mention: string, d: CtxDoctor): number {
  const m = normalizeName(mention);
  if (!m) return 0;
  return Math.max(...doctorForms(d).map((f) => similarity(m, f)), 0);
}

const SPECIALTY_SYNONYMS: Record<string, string[]> = {
  cardio: ["cardio", "cardiologist", "heart", "dil"],
  diabet: ["sugar", "diabetes", "diabetic", "diabeto", "diabetologist"],
  derma: ["skin", "derma", "dermatologist", "chamdi"],
  paed: ["bachon", "bacchon", "bachche", "bacche", "child", "kids", "paeds", "peds", "pediatric", "paediatrician", "pediatrician"],
  gynae: ["gynae", "gyne", "gyno", "ladies", "women", "mahila", "gynaecologist", "gynecologist"],
  ortho: ["ortho", "haddi", "bone", "orthopaedic", "orthopedic"],
  ent: ["ent", "kaan", "naak", "gala"],
  physician: ["physician", "gp", "general", "md"],
};

function specialtyKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const tokens = normalizeName(text).split(" ");
  for (const [key, words] of Object.entries(SPECIALTY_SYNONYMS)) {
    if (tokens.some((t) => words.some((w) => t.startsWith(w)))) keys.add(key);
  }
  return keys;
}

/** Do the evidence words point at this doctor (specialty, area, clinic, first name)? */
export function evidenceSupports(evidence: string, d: CtxDoctor): boolean {
  const evKeys = specialtyKeys(evidence);
  const docKeys = specialtyKeys(`${d.specialty ?? ""} ${d.clinic ?? ""}`);
  if ([...evKeys].some((k) => docKeys.has(k))) return true;

  const evTokens = normalizeName(evidence).split(" ").filter((t) => t.length > 2);
  const firstName = normalizeName(d.name).split(" ").filter((t) => t.length > 1)[0] ?? "";
  const attrTokens = normalizeName(`${d.area ?? ""} ${d.clinic ?? ""} ${firstName}`)
    .split(" ")
    .filter((t) => t.length > 2);
  return evTokens.some((e) => attrTokens.some((a) => similarity(e, a) >= 0.8));
}

export function matchDoctor(
  mention: string,
  llmRef: string | null,
  evidence: string | null,
  ctx: MrContext,
  aliases: Map<string, string>
): MatchDecision {
  const alias = aliases.get(normalizeName(mention));
  if (alias && ctx.doctors.some((d) => d.id === alias)) return { status: "matched", id: alias, via: "alias" };

  const llmPick = llmRef ? ctx.doctors.find((d) => d.ref === llmRef) ?? null : null;
  const scored = ctx.doctors
    .map((d) => ({ id: d.id, label: doctorLabel(d), score: round(scoreDoctor(mention, d)), doctor: d }))
    .sort((a, b) => b.score - a.score);

  const decision = decide(scored, llmPick?.id ?? null);
  if (decision.status !== "ambiguous" || !llmPick || !evidence) return decision;

  // Several doctors share the name: accept the LLM's pick only if the
  // evidence words in the note point at it and at none of the others.
  const pool = scored.filter((c) => c.score >= CANDIDATE);
  if (pool.some((c) => c.id === llmPick.id)) {
    const supports = pool.filter((c) => evidenceSupports(evidence, c.doctor));
    if (supports.length === 1 && supports[0].id === llmPick.id) {
      return { status: "matched", id: llmPick.id, via: "evidence" };
    }
  }
  return decision;
}

// ── products ────────────────────────────────────────────────────────────────

const FORM_WORDS = new Set([
  "syrup", "syp", "tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule", "capsules",
  "sachet", "sachets", "strip", "strips", "bottle", "bottles", "inj", "injection", "ka", "ke", "ki", "ko",
  "sample", "samples",
  // transliterated Hindi forms ("कफज़ेन सिरप" -> "kaphazen sirap")
  "sirap", "sirp", "sirup", "shirap", "goli", "golee", "tablet", "kepsul", "botal", "patta", "patti",
]);

function compactProduct(text: string): string {
  return transliterate(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t && !FORM_WORDS.has(t))
    .join("");
}

function productBase(p: CtxProduct): string {
  const first = p.brandName.toLowerCase().split(/[\s-]+/)[0];
  return compactProduct(first);
}

export function scoreProduct(mention: string, p: CtxProduct, ctx: MrContext): number {
  const m = compactProduct(mention);
  if (!m) return 0;
  const full = compactProduct(p.brandName);
  const base = productBase(p);
  const siblings = ctx.products.filter((x) => productBase(x) === base).length;
  // A bare family name ("Telmora") scores slightly lower against each variant
  // so a variant named in full ("Telmora H") always wins.
  return Math.max(similarity(m, full), similarity(m, base) - (siblings > 1 ? 0.05 : 0));
}

export function matchProduct(
  mention: string,
  llmRef: string | null,
  ctx: MrContext,
  aliases: Map<string, string>
): MatchDecision {
  const alias = aliases.get(compactProduct(mention));
  if (alias && ctx.products.some((p) => p.id === alias)) return { status: "matched", id: alias, via: "alias" };

  const llmPick = llmRef ? ctx.products.find((p) => p.ref === llmRef) ?? null : null;
  const scored = ctx.products
    .map((p) => ({ id: p.id, label: p.brandName, score: round(scoreProduct(mention, p, ctx)) }))
    .sort((a, b) => b.score - a.score);
  return decide(scored, llmPick?.id ?? null);
}

// ── managers ────────────────────────────────────────────────────────────────

const GENERIC_MANAGER_WORDS = ["sir", "boss", "manager", "senior", "madam", "saab"];

export function matchManager(mention: string, llmRef: string | null, ctx: MrContext): MatchDecision {
  const all = ctx.managers.map((m) => ({ id: m.id, label: managerLabel(m), score: 0 }));
  const lower = mention.toLowerCase();

  // Role words are exact: "ABM sir" -> the ABM in the chain.
  const byRole = ctx.managers.filter((m) => new RegExp(`\\b${m.role.toLowerCase()}\\b`).test(lower));
  if (byRole.length === 1) return { status: "matched", id: byRole[0].id, via: "fuzzy" };

  const name = normalizeName(mention);
  const byName = name
    ? ctx.managers
        .map((m) => ({
          m,
          score: Math.max(...normalizeName(m.name).split(" ").map((t) => similarity(name.split(" ")[0], t))),
        }))
        .filter((x) => x.score >= AUTO_MATCH)
    : [];
  if (byName.length === 1) return { status: "matched", id: byName[0].m.id, via: "fuzzy" };

  // Only generic words ("sir saath the"): unambiguous only with one manager.
  const generic = !name || name.split(" ").every((t) => GENERIC_MANAGER_WORDS.includes(t));
  if (generic && ctx.managers.length === 1) return { status: "matched", id: ctx.managers[0].id, via: "fuzzy" };

  // The LLM's pick alone is not enough to name a manager on a compliance record.
  void llmRef;
  return { status: "ambiguous", candidates: all };
}

// ── chemists ────────────────────────────────────────────────────────────────

const CHEMIST_WORDS = new Set(["medical", "medicals", "store", "stores", "medicos", "pharmacy", "chemist", "chemists", "hall"]);

export function matchChemist(mention: string, llmRef: string | null, ctx: MrContext): MatchDecision {
  const strip = (s: string) =>
    normalizeName(s)
      .split(" ")
      .filter((t) => !CHEMIST_WORDS.has(t))
      .join(" ");
  const m = strip(mention);
  const llmPick = llmRef ? ctx.chemists.find((c) => c.ref === llmRef) ?? null : null;
  const scored = ctx.chemists
    .map((c) => ({ id: c.id, label: c.name, score: m ? round(similarity(m, strip(c.name))) : 0 }))
    .sort((a, b) => b.score - a.score);
  return decide(scored, llmPick?.id ?? null);
}

// ── shared decision rule ────────────────────────────────────────────────────

function decide(scored: Candidate[], llmId: string | null): MatchDecision {
  const pool = scored.filter((c) => c.score >= CANDIDATE);
  const top = pool[0];
  const second = pool[1];
  const strip = (cs: Candidate[]) => cs.slice(0, 4).map(({ id, label, score }) => ({ id, label, score }));

  if (top && top.score >= AUTO_MATCH && (!second || top.score - second.score >= MARGIN)) {
    if (llmId === null || llmId === top.id) return { status: "matched", id: top.id, via: llmId ? "fuzzy+llm" : "fuzzy" };
    // Strong string match but the LLM chose someone else: ask.
    const other = scored.find((c) => c.id === llmId);
    return { status: "ambiguous", candidates: strip(other ? [top, other] : [top]) };
  }
  if (pool.length === 1) {
    // One plausible candidate, not strong on its own: accept only if the LLM agrees.
    if (llmId === top.id) return { status: "matched", id: top.id, via: "fuzzy+llm" };
    return { status: "ambiguous", candidates: strip(pool) };
  }
  if (pool.length > 1) return { status: "ambiguous", candidates: strip(pool) };

  // Nothing close by spelling. If the LLM picked something (e.g. a Devanagari
  // or badly transcribed name), offer it as a one-tap confirmation.
  if (llmId) {
    const pick = scored.find((c) => c.id === llmId);
    if (pick) return { status: "ambiguous", candidates: strip([pick]) };
  }
  return { status: "not_found", candidates: strip(scored.filter((c) => c.score >= 0.5)) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function doctorLabel(d: CtxDoctor): string {
  return [d.name, d.specialty, d.area].filter(Boolean).join(" · ");
}

export function managerLabel(m: CtxManager): string {
  return `${m.name} (${m.role})`;
}

export function aliasKey(entityType: "doctor" | "product" | "chemist" | "manager", mention: string): string {
  return entityType === "product" ? compactProduct(mention) : normalizeName(mention);
}
