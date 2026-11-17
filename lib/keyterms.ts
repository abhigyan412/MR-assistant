import type { MrContext } from "./context";
import { MAX_KEYTERMS } from "./sarvam";

// Speech-to-text vocabulary for one MR: the words most likely to be misheard
// and most costly when they are — our (invented) brand names first, then the
// doctors, chemists, areas and managers on this MR's shortlist. Sarvam takes
// at most 50; order = priority.

const TITLE = /^(dr|doctor|mr|mrs|ms)\.?$/i;

function surname(name: string): string | null {
  const tokens = name
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !TITLE.test(t) && t.length > 1);
  return tokens.length ? tokens[tokens.length - 1] : null;
}

export function keytermsFor(ctx: MrContext): string[] {
  const products: string[] = [];
  for (const p of ctx.products) {
    const base = p.brandName.split(/[\s-]+/)[0]; // "Glimora-M2" -> "Glimora"
    products.push(base);
    const spoken = p.brandName.replace(/-/g, " "); // "Glimora M2", "Telvika 40"
    if (spoken.toLowerCase() !== base.toLowerCase()) products.push(spoken);
  }
  const doctors = ctx.doctors.map((d) => surname(d.name)).filter((s): s is string => !!s);
  const chemists = ctx.chemists.map((c) => c.name);
  const areas = [...ctx.doctors.map((d) => d.area), ...ctx.chemists.map((c) => c.area)].filter((a): a is string => !!a);
  const managers = ctx.managers.map((m) => surname(m.name)).filter((s): s is string => !!s);

  // Base brand names and surnames first: they carry the most risk per slot.
  const ordered = [
    ...products.filter((t) => !t.includes(" ")),
    ...doctors,
    ...products.filter((t) => t.includes(" ")),
    ...chemists,
    ...managers,
    ...areas,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of ordered) {
    const k = t.toLowerCase();
    if (seen.has(k) || t.length > 64) continue;
    seen.add(k);
    out.push(t);
    if (out.length === MAX_KEYTERMS) break;
  }
  return out;
}
