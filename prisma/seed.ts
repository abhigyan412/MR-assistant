import { PrismaClient } from "@prisma/client";
import { istDate } from "../lib/dates";
import { validateEventDraft } from "../lib/events";
import {
  CHEMISTS,
  COMPANY,
  DOCTORS,
  OPENING_STOCK,
  OPENING_STOCK_AT,
  PRODUCTS,
  TERRITORIES,
  USERS,
} from "./seed-data";

// Idempotent: master data is upserted by code; opening stock is written once
// per MR through a deterministic ADMIN message id (the same claim-by-primary-key
// idempotency the note pipeline uses), so re-running never doubles stock.

export async function seed(prisma: PrismaClient) {
  const company = await prisma.company.upsert({
    where: { code: COMPANY.code },
    update: { name: COMPANY.name },
    create: COMPANY,
  });
  const companyId = company.id;

  const territoryIds: Record<string, string> = {};
  for (const t of TERRITORIES) {
    const row = await prisma.territory.upsert({
      where: { companyId_code: { companyId, code: t.code } },
      update: { name: t.name },
      create: { companyId, code: t.code, name: t.name },
    });
    territoryIds[t.code] = row.id;
  }

  // Users in order so managers exist before their reports.
  const userIds: Record<string, string> = {};
  for (const u of USERS) {
    const data = {
      name: u.name,
      role: u.role,
      territoryId: u.territory ? territoryIds[u.territory] : null,
      managerId: u.manager ? userIds[u.manager] : null,
    };
    const row = await prisma.user.upsert({
      where: { companyId_code: { companyId, code: u.code } },
      update: data,
      create: { companyId, code: u.code, ...data },
    });
    userIds[u.code] = row.id;
  }

  for (const d of DOCTORS) {
    const data = {
      name: d.name,
      specialty: d.specialty,
      clinic: d.clinic,
      area: d.area,
      territoryId: territoryIds[d.territory],
      status: "ACTIVE" as const,
    };
    await prisma.doctor.upsert({
      where: { companyId_externalCode: { companyId, externalCode: d.code } },
      update: data,
      create: { companyId, externalCode: d.code, ...data },
    });
  }

  for (const c of CHEMISTS) {
    const data = { name: c.name, area: c.area, territoryId: territoryIds[c.territory], status: "ACTIVE" as const };
    await prisma.chemist.upsert({
      where: { companyId_externalCode: { companyId, externalCode: c.code } },
      update: data,
      create: { companyId, externalCode: c.code, ...data },
    });
  }

  const productIds: Record<string, string> = {};
  for (const p of PRODUCTS) {
    const data = { brandName: p.brandName, composition: p.composition, baseUnit: p.baseUnit, active: true };
    const row = await prisma.product.upsert({
      where: { companyId_code: { companyId, code: p.code } },
      update: data,
      create: { companyId, code: p.code, ...data },
    });
    productIds[p.code] = row.id;
    for (const u of p.units) {
      await prisma.productUnit.upsert({
        where: { productId_unit: { productId: row.id, unit: u.unit } },
        update: { toBase: u.toBase },
        create: { productId: row.id, unit: u.unit, toBase: u.toBase },
      });
    }
  }

  // Opening stock: one ADMIN message per MR, one sample_received per product.
  const openingAt = new Date(OPENING_STOCK_AT);
  for (const [mrCode, stock] of Object.entries(OPENING_STOCK)) {
    const messageId = `seed-opening-stock-${mrCode}`;
    const exists = await prisma.message.findUnique({ where: { id: messageId } });
    if (exists) continue;

    const mrId = userIds[mrCode];
    await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: messageId,
          companyId,
          mrId,
          channel: "ADMIN",
          recordedAt: openingAt,
          text: `Opening sample stock for ${mrCode} (seed)`,
          status: "PROCESSED",
          processedAt: openingAt,
        },
      });
      for (const [productCode, quantity] of Object.entries(stock)) {
        const product = PRODUCTS.find((p) => p.code === productCode)!;
        const draft = {
          type: "sample_received",
          payload: { quantity, unit: product.baseUnit, note: "Opening stock", source: "opening_stock" },
          productId: productIds[productCode],
          stockDelta: quantity,
        };
        const { schemaVersion, payload } = validateEventDraft(draft);
        await tx.event.create({
          data: {
            companyId,
            mrId,
            messageId,
            type: draft.type,
            schemaVersion,
            occurredAt: openingAt,
            occurredOn: istDate(openingAt),
            productId: draft.productId,
            stockDelta: draft.stockDelta,
            payload: payload as object,
          },
        });
      }
    });
  }

  const counts = {
    doctors: await prisma.doctor.count({ where: { companyId } }),
    chemists: await prisma.chemist.count({ where: { companyId } }),
    products: await prisma.product.count({ where: { companyId } }),
    users: await prisma.user.count({ where: { companyId } }),
    openingStockEvents: await prisma.event.count({ where: { companyId, type: "sample_received" } }),
  };
  return counts;
}

// CLI entry (`npx prisma db seed` / `tsx prisma/seed.ts`); tests import seed().
if (process.argv[1]?.replace(/\\/g, "/").endsWith("prisma/seed.ts")) {
  const prisma = new PrismaClient();
  seed(prisma)
    .then((counts) => console.log("Seeded:", counts))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
