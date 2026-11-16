import type { PrismaClient } from "@prisma/client";
import { CHEMISTS, DOCTORS, PRODUCTS, TERRITORIES, USERS } from "../prisma/seed-data";

// The per-MR shortlist the LLM sees: only doctors/chemists in the MR's
// territory, the company's active products, and the MR's manager chain.
// Entries get short refs (D1, P1, M1, C1) so the prompt is compact and the
// LLM can't invent a plausible-looking database id. Refs are assigned in a
// stable order (by code), which keeps the prompt prefix cacheable.

export interface CtxDoctor {
  ref: string;
  id: string;
  code: string | null;
  name: string;
  specialty: string | null;
  clinic: string | null;
  area: string | null;
}
export interface CtxProduct {
  ref: string;
  id: string;
  code: string;
  brandName: string;
  composition: string | null;
  baseUnit: string;
  units: { unit: string; toBase: number }[];
}
export interface CtxManager {
  ref: string;
  id: string;
  code: string;
  name: string;
  role: string;
}
export interface CtxChemist {
  ref: string;
  id: string;
  code: string | null;
  name: string;
  area: string | null;
}

export interface MrContext {
  mr: { id: string; code: string; name: string };
  territoryName: string;
  doctors: CtxDoctor[];
  products: CtxProduct[];
  managers: CtxManager[];
  chemists: CtxChemist[];
}

function withRefs<T>(prefix: string, items: T[], key: (t: T) => string): (T & { ref: string })[] {
  return [...items]
    .sort((a, b) => key(a).localeCompare(key(b)))
    .map((item, i) => ({ ...item, ref: `${prefix}${i + 1}` }));
}

/** Context built straight from seed-data (ids = codes). Used by the eval. */
export function contextFromSeed(mrCode: string): MrContext {
  const mr = USERS.find((u) => u.code === mrCode && u.role === "MR");
  if (!mr || !mr.territory) throw new Error(`Unknown MR ${mrCode}`);
  const territory = TERRITORIES.find((t) => t.code === mr.territory)!;

  const managers: Omit<CtxManager, "ref">[] = [];
  let current = mr.manager;
  while (current) {
    const m = USERS.find((u) => u.code === current)!;
    managers.push({ id: m.code, code: m.code, name: m.name, role: m.role });
    current = m.manager;
  }

  return {
    mr: { id: mr.code, code: mr.code, name: mr.name },
    territoryName: territory.name,
    doctors: withRefs(
      "D",
      DOCTORS.filter((d) => d.territory === mr.territory).map((d) => ({
        id: d.code,
        code: d.code,
        name: d.name,
        specialty: d.specialty,
        clinic: d.clinic,
        area: d.area,
      })),
      (d) => d.code
    ),
    products: withRefs(
      "P",
      PRODUCTS.map((p) => ({
        id: p.code,
        code: p.code,
        brandName: p.brandName,
        composition: p.composition,
        baseUnit: p.baseUnit,
        units: p.units,
      })),
      (p) => p.code
    ),
    // Manager chain keeps its natural order (direct manager first).
    managers: managers.map((m, i) => ({ ...m, ref: `M${i + 1}` })),
    chemists: withRefs(
      "C",
      CHEMISTS.filter((c) => c.territory === mr.territory).map((c) => ({
        id: c.code,
        code: c.code,
        name: c.name,
        area: c.area,
      })),
      (c) => c.code
    ),
  };
}

/** Context loaded from the database (Phase 1 pipeline). */
export async function loadMrContext(prisma: PrismaClient, companyId: string, mrId: string): Promise<MrContext> {
  const mr = await prisma.user.findFirstOrThrow({
    where: { id: mrId, companyId, role: "MR" },
    include: { territory: true },
  });
  if (!mr.territoryId || !mr.territory) throw new Error(`MR ${mrId} has no territory`);

  const managers: Omit<CtxManager, "ref">[] = [];
  let managerId = mr.managerId;
  while (managerId) {
    const m = await prisma.user.findFirstOrThrow({ where: { id: managerId, companyId } });
    managers.push({ id: m.id, code: m.code, name: m.name, role: m.role });
    managerId = m.managerId;
  }

  const [doctors, products, chemists] = await Promise.all([
    prisma.doctor.findMany({
      // PENDING_APPROVAL doctors are included so an MR can keep logging
      // visits to a doctor they added before the manager approves.
      where: { companyId, territoryId: mr.territoryId, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } },
    }),
    prisma.product.findMany({ where: { companyId, active: true }, include: { units: true } }),
    prisma.chemist.findMany({ where: { companyId, territoryId: mr.territoryId, status: "ACTIVE" } }),
  ]);

  return {
    mr: { id: mr.id, code: mr.code, name: mr.name },
    territoryName: mr.territory.name,
    doctors: withRefs(
      "D",
      doctors.map((d) => ({
        id: d.id,
        code: d.externalCode,
        name: d.name,
        specialty: d.specialty,
        clinic: d.clinic,
        area: d.area,
      })),
      (d) => d.code ?? d.id
    ),
    products: withRefs(
      "P",
      products.map((p) => ({
        id: p.id,
        code: p.code,
        brandName: p.brandName,
        composition: p.composition,
        baseUnit: p.baseUnit,
        units: p.units.map((u) => ({ unit: u.unit, toBase: u.toBase })),
      })),
      (p) => p.code
    ),
    managers: managers.map((m, i) => ({ ...m, ref: `M${i + 1}` })),
    chemists: withRefs(
      "C",
      chemists.map((c) => ({ id: c.id, code: c.externalCode, name: c.name, area: c.area })),
      (c) => c.code ?? c.id
    ),
  };
}
