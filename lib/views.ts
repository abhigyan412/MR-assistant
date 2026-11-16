import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { istDate } from "./dates";
import { validateEventDraft } from "./events";
import { NotFoundError } from "./pipeline";

// Read models, all DERIVED from the Event ledger (no stored totals).

// ── sample stock ──────────────────────────────────────────────────────────

export async function getStock(prisma: PrismaClient, mrId: string) {
  const mr = await prisma.user.findUnique({ where: { id: mrId } });
  if (!mr) throw new NotFoundError(`MR ${mrId} not found`);
  const [products, sums] = await Promise.all([
    prisma.product.findMany({ where: { companyId: mr.companyId, active: true }, orderBy: { brandName: "asc" } }),
    prisma.event.groupBy({ by: ["productId"], where: { mrId, stockDelta: { not: null } }, _sum: { stockDelta: true } }),
  ]);
  const byProduct = new Map(sums.map((s) => [s.productId, s._sum.stockDelta ?? 0]));
  return products.map((p) => ({
    productId: p.id,
    brandName: p.brandName,
    baseUnit: p.baseUnit,
    balance: byProduct.get(p.id) ?? 0,
  }));
}

// ── Daily Call Report ─────────────────────────────────────────────────────

type Payload = Record<string, unknown>;

export async function getDcr(prisma: PrismaClient, mrId: string, date: string) {
  const events = await prisma.event.findMany({ where: { mrId, occurredOn: date }, orderBy: { occurredAt: "asc" } });

  // A corrected entry and its reversal cancel out; neither shows in the DCR.
  const hidden = new Set<string>();
  for (const e of events) {
    if (e.reversesEventId) {
      hidden.add(e.id);
      hidden.add(e.reversesEventId);
    }
  }
  const live = events.filter((e) => !hidden.has(e.id));

  const ids = (key: "doctorId" | "productId" | "chemistId" | "managerId") => [
    ...new Set(live.map((e) => e[key]).filter((x): x is string => !!x)),
  ];
  const [doctors, products, chemists, managers] = await Promise.all([
    prisma.doctor.findMany({ where: { id: { in: ids("doctorId") } } }),
    prisma.product.findMany({ where: { id: { in: ids("productId") } } }),
    prisma.chemist.findMany({ where: { id: { in: ids("chemistId") } } }),
    prisma.user.findMany({ where: { id: { in: ids("managerId") } } }),
  ]);
  const doctor = new Map(doctors.map((d) => [d.id, d]));
  const product = new Map(products.map((p) => [p.id, p.brandName]));
  const chemist = new Map(chemists.map((c) => [c.id, c.name]));
  const manager = new Map(managers.map((m) => [m.id, `${m.name} (${m.role})`]));
  const productName = (id: string | null, p: Payload) => (id ? product.get(id) : null) ?? String(p.rawProductMention ?? "—");

  const visits = live
    .filter((e) => e.type === "doctor_visit")
    .map((v) => {
      const p = v.payload as Payload;
      const d = v.doctorId ? doctor.get(v.doctorId) : undefined;
      const kids = live.filter((e) => e.visitEventId === v.id);
      const of = (type: string) => kids.filter((k) => k.type === type);
      return {
        visitId: v.id,
        messageId: v.messageId,
        doctor: {
          id: v.doctorId,
          name: d?.name ?? String(p.rawDoctorMention),
          specialty: d?.specialty ?? null,
          area: d?.area ?? null,
          pendingApproval: d?.status === "PENDING_APPROVAL",
        },
        met: p.met as boolean,
        time: (p.visitTime as string | null) ?? (p.timeKnown ? istTimeOf(v.occurredAt) : null),
        detailed: of("product_detailed").map((k) => productName(k.productId, k.payload as Payload)),
        samples: of("sample_given").map((k) => {
          const kp = k.payload as Payload;
          return { product: productName(k.productId, kp), quantity: kp.quantity as number, unit: kp.unit as string, baseUnits: -(k.stockDelta ?? 0) };
        }),
        pobs: of("pob").map((k) => {
          const kp = k.payload as Payload;
          return {
            product: productName(k.productId, kp),
            quantity: kp.quantity as number,
            unit: kp.unit as string,
            chemist: (k.chemistId && chemist.get(k.chemistId)) || (kp.chemistName as string | null),
          };
        }),
        jointWork: of("joint_work").map((k) => (k.managerId && manager.get(k.managerId)) || String((k.payload as Payload).rawMention)),
        queries: of("doctor_query").map((k) => {
          const kp = k.payload as Payload;
          return { question: kp.question as string, product: k.productId ? product.get(k.productId) ?? null : null };
        }),
        followUps: of("follow_up").map((k) => {
          const kp = k.payload as Payload;
          return {
            action: kp.action as string,
            dueDate: kp.dueDate as string | null,
            provisionalRule: kp.pendingPartnerConfirmation as boolean,
          };
        }),
      };
    });

  const chemistCalls = new Map<string, { chemist: string; pobs: { product: string; quantity: number; unit: string }[] }>();
  for (const e of live.filter((x) => x.type === "pob" && !x.visitEventId)) {
    const p = e.payload as Payload;
    const name = (e.chemistId && chemist.get(e.chemistId)) || String(p.chemistName ?? "Unknown chemist");
    const key = e.chemistId ?? name.toLowerCase();
    const entry = chemistCalls.get(key) ?? { chemist: name, pobs: [] };
    entry.pobs.push({ product: productName(e.productId, p), quantity: p.quantity as number, unit: p.unit as string });
    chemistCalls.set(key, entry);
  }

  return {
    date,
    summary: {
      visits: visits.length,
      met: visits.filter((v) => v.met).length,
      missed: visits.filter((v) => !v.met).length,
      samplesGivenBaseUnits: visits.reduce((n, v) => n + v.samples.reduce((m, s) => m + s.baseUnits, 0), 0),
      jointWorkVisits: visits.filter((v) => v.jointWork.length > 0).length,
    },
    visits,
    chemistCalls: [...chemistCalls.values()],
  };
}

function istTimeOf(at: Date): string {
  const shifted = new Date(at.getTime() + 330 * 60_000);
  return shifted.toISOString().slice(11, 16);
}

// ── lists ─────────────────────────────────────────────────────────────────

export async function listMessages(prisma: PrismaClient, mrId: string, limit = 50) {
  return prisma.message.findMany({
    where: { mrId, channel: { not: "ADMIN" } },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { reviewItems: { orderBy: { createdAt: "asc" } }, _count: { select: { events: true } } },
  });
}

/** Everything a manager should look at: manager-only items, MR items left open, doctors to approve. */
export async function managerQueue(prisma: PrismaClient, managerId: string) {
  const manager = await prisma.user.findUnique({ where: { id: managerId } });
  if (!manager || manager.role === "MR") throw new NotFoundError(`Manager ${managerId} not found`);

  // All MRs below this manager (any depth); admins see the whole company.
  const users = await prisma.user.findMany({ where: { companyId: manager.companyId } });
  const below = new Set<string>();
  const walk = (id: string) =>
    users.filter((u) => u.managerId === id).forEach((u) => {
      below.add(u.id);
      walk(u.id);
    });
  if (manager.role === "ADMIN") users.forEach((u) => below.add(u.id));
  else walk(manager.id);
  const mrIds = users.filter((u) => u.role === "MR" && below.has(u.id)).map((u) => u.id);
  const mrName = new Map(users.map((u) => [u.id, u.name]));

  const [items, pendingDoctors] = await Promise.all([
    prisma.reviewItem.findMany({
      where: { status: "OPEN", message: { mrId: { in: mrIds } } },
      include: { message: { select: { id: true, mrId: true, text: true, recordedAt: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.doctor.findMany({
      where: { companyId: manager.companyId, status: "PENDING_APPROVAL", createdById: { in: mrIds } },
      include: { territory: true },
    }),
  ]);

  return {
    managerItems: items.filter((i) => i.assignee === "MANAGER").map((i) => ({ ...i, mrName: mrName.get(i.message.mrId) })),
    mrItemsOpen: items.filter((i) => i.assignee === "MR").map((i) => ({ ...i, mrName: mrName.get(i.message.mrId) })),
    pendingDoctors: pendingDoctors.map((d) => ({ ...d, addedBy: d.createdById ? mrName.get(d.createdById) : null })),
  };
}

// ── admin: sample receipts ────────────────────────────────────────────────

export interface SampleReceiptInput {
  entryId: string; // client-generated: a double-submit can't double the stock
  adminId: string;
  mrId: string;
  productId: string;
  quantity: number;
  unit: string;
  note: string | null;
}

export async function addSampleReceipt(prisma: PrismaClient, input: SampleReceiptInput) {
  const [admin, mr, product] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.adminId } }),
    prisma.user.findUnique({ where: { id: input.mrId } }),
    prisma.product.findUnique({ where: { id: input.productId }, include: { units: true } }),
  ]);
  if (!admin || admin.role !== "ADMIN") throw new NotFoundError("Admin not found");
  if (!mr || mr.role !== "MR" || mr.companyId !== admin.companyId) throw new NotFoundError("MR not found");
  if (!product || product.companyId !== admin.companyId) throw new NotFoundError("Product not found");

  const unit = input.unit.trim().toLowerCase();
  const toBase = unit === product.baseUnit ? 1 : product.units.find((u) => u.unit === unit)?.toBase;
  if (!toBase) throw new Error(`${product.brandName} has no "${unit}" unit (base unit: ${product.baseUnit})`);

  const now = new Date();
  const draft = {
    type: "sample_received",
    payload: { quantity: input.quantity, unit, note: input.note, source: "admin_entry" },
    productId: product.id,
    stockDelta: input.quantity * toBase,
  };
  const { schemaVersion, payload } = validateEventDraft(draft);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: input.entryId,
          companyId: admin.companyId,
          mrId: mr.id,
          channel: "ADMIN",
          recordedAt: now,
          text: `Sample receipt: ${input.quantity} ${unit} ${product.brandName} for ${mr.name}${input.note ? ` (${input.note})` : ""} — entered by ${admin.name}`,
          status: "PROCESSED",
          processedAt: now,
        },
      });
      await tx.event.create({
        data: {
          id: randomUUID(),
          companyId: admin.companyId,
          mrId: mr.id,
          messageId: input.entryId,
          type: draft.type,
          schemaVersion,
          occurredAt: now,
          occurredOn: istDate(now),
          productId: product.id,
          stockDelta: draft.stockDelta,
          payload: payload as Prisma.InputJsonValue,
        },
      });
    });
    return { duplicate: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { duplicate: true };
    throw err;
  }
}
