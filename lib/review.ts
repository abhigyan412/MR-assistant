import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { loadMrContext } from "./context";
import { istDate } from "./dates";
import { validateEventDraft } from "./events";
import type { ReviewKind, StockProposal } from "./interpret";
import { aliasKey } from "./matching";
import { evaluateMessage, NotFoundError, type MessageWithDetails } from "./pipeline";

// One-tap review resolution. The MR answers first; the manager sees what's
// left plus manager-only items (adverse events, new-doctor approvals).
// After every answer the message is re-evaluated; once nothing blocking is
// left its events are written and it becomes PROCESSED.

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

export const ResolutionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pick"), id: z.string().min(1) }),
  z.object({ action: z.literal("quantity"), quantity: z.number().int().positive(), unit: z.string().trim().min(1) }),
  z.object({ action: z.literal("drop") }),
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("visitStatus"), met: z.boolean() }),
  z.object({ action: z.literal("secondVisit") }),
  z.object({ action: z.literal("sameVisit") }),
  z.object({ action: z.literal("reverse"), eventIds: z.array(z.string().min(1)).min(1) }),
  z.object({ action: z.literal("notCorrection") }),
  z.object({ action: z.literal("acknowledge") }),
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("reject") }),
  z.object({
    action: z.literal("newDoctor"),
    name: z.string().trim().min(2),
    specialty: z.string().trim().min(1).nullable(),
    area: z.string().trim().min(1).nullable(),
  }),
  z.object({ action: z.literal("discard") }), // "this note is wrong, throw it away"
]);
export type ResolutionInput = z.infer<typeof ResolutionSchema>;

const ALLOWED: Record<ReviewKind, ResolutionInput["action"][]> = {
  DOCTOR_AMBIGUOUS: ["pick", "discard"],
  DOCTOR_NOT_FOUND: ["pick", "newDoctor", "discard"],
  PRODUCT_AMBIGUOUS: ["pick", "drop", "discard"],
  PRODUCT_NOT_FOUND: ["pick", "drop", "discard"],
  MANAGER_AMBIGUOUS: ["pick", "drop", "discard"],
  QUANTITY_MISSING: ["quantity", "drop", "discard"],
  UNIT_UNKNOWN: ["quantity", "drop", "discard"],
  STOCK_INSUFFICIENT: ["quantity", "drop", "discard"],
  LOW_CONFIDENCE: ["accept", "discard"],
  VISIT_STATUS_CONFLICT: ["visitStatus", "discard"],
  POSSIBLE_DUPLICATE_VISIT: ["secondVisit", "sameVisit"],
  CORRECTION_REQUESTED: ["reverse", "notCorrection", "discard"],
  ADVERSE_EVENT: ["acknowledge"],
  STOCK_REPORT: ["approve", "reject"],
};

export async function resolveReviewItem(
  prisma: PrismaClient,
  itemId: string,
  actorId: string,
  input: unknown
): Promise<MessageWithDetails> {
  const resolution = ResolutionSchema.parse(input);
  const item = await prisma.reviewItem.findUnique({ where: { id: itemId }, include: { message: true } });
  if (!item) throw new NotFoundError(`Review item ${itemId} not found`);
  if (item.status !== "OPEN") throw new ReviewError(`Review item is already ${item.status}`);
  const kind = item.kind as ReviewKind;
  if (!ALLOWED[kind]?.includes(resolution.action)) {
    throw new ReviewError(`"${resolution.action}" is not a valid answer for ${kind}`);
  }

  const actor = await prisma.user.findUnique({ where: { id: actorId } });
  if (!actor || actor.companyId !== item.companyId) throw new NotFoundError(`User ${actorId} not found`);
  if (item.assignee === "MANAGER" && actor.role === "MR") throw new ReviewError("This item is for a manager");

  const message = item.message;
  const now = new Date();

  // Manager decision on an MR's stock report: the stock event is written
  // only on approval, and stock can never go below zero.
  if (kind === "STOCK_REPORT") {
    await decideStockReport(prisma, item.id, item.proposal as StockProposal | null, message, actorId, resolution.action === "approve");
    return evaluateMessage(prisma, message.id);
  }

  // Throwing the note away (wrong note, or the same visit sent twice).
  if (resolution.action === "discard" || resolution.action === "sameVisit") {
    await prisma.$transaction([
      prisma.reviewItem.update({
        where: { id: itemId },
        data: { status: "RESOLVED", resolution: resolution as Prisma.InputJsonValue, resolvedById: actorId, resolvedAt: now },
      }),
      prisma.reviewItem.updateMany({
        where: { messageId: message.id, status: "OPEN", id: { not: itemId } },
        data: { status: "DISMISSED", resolvedAt: now },
      }),
      prisma.message.update({ where: { id: message.id }, data: { status: "DISCARDED" } }),
    ]);
    return evaluateMessage(prisma, message.id);
  }

  let stored: Prisma.InputJsonValue = resolution as Prisma.InputJsonValue;
  const ctx = await loadMrContext(prisma, message.companyId, message.mrId);

  if (resolution.action === "newDoctor") {
    const mr = await prisma.user.findUniqueOrThrow({ where: { id: message.mrId } });
    const doctor = await prisma.doctor.create({
      data: {
        companyId: message.companyId,
        territoryId: mr.territoryId!,
        name: resolution.name,
        specialty: resolution.specialty,
        area: resolution.area,
        status: "PENDING_APPROVAL", // manager approves; the MR is not blocked meanwhile
        createdById: actorId,
      },
    });
    stored = { action: "pick", id: doctor.id, createdDoctor: true };
  }

  if (resolution.action === "pick") {
    const known =
      kind.startsWith("DOCTOR")
        ? ctx.doctors.some((d) => d.id === resolution.id)
        : kind.startsWith("PRODUCT")
          ? ctx.products.some((p) => p.id === resolution.id)
          : kind === "MANAGER_AMBIGUOUS"
            ? ctx.managers.some((m) => m.id === resolution.id)
            : false;
    if (!known) throw new ReviewError(`Unknown choice ${resolution.id}`);

    // Learn: next time this MR says the same thing, it resolves by itself.
    const entityType = kind.startsWith("DOCTOR") ? "doctor" : kind.startsWith("PRODUCT") ? "product" : null;
    if (entityType && item.rawMention) {
      const alias = aliasKey(entityType, item.rawMention);
      if (alias) {
        await prisma.alias.upsert({
          where: { companyId_entityType_userId_alias: { companyId: message.companyId, entityType, userId: message.mrId, alias } },
          update: { entityId: resolution.id },
          create: { companyId: message.companyId, entityType, entityId: resolution.id, userId: message.mrId, alias },
        });
      }
    }
  }

  if (resolution.action === "reverse") {
    const candidates = (item.candidates as { id: string }[] | null) ?? [];
    if (!resolution.eventIds.every((id) => candidates.some((c) => c.id === id))) {
      throw new ReviewError("Can only reverse entries offered on the card");
    }
  }

  // One note can raise the same question twice — "Telmora" detailed AND
  // sampled gives two "Which product?" cards for one word. One answer covers
  // every open card of the same kind for the same words in this note.
  const family = kind.startsWith("DOCTOR")
    ? ["DOCTOR_AMBIGUOUS", "DOCTOR_NOT_FOUND"]
    : kind.startsWith("PRODUCT")
      ? ["PRODUCT_AMBIGUOUS", "PRODUCT_NOT_FOUND"]
      : kind === "MANAGER_AMBIGUOUS"
        ? ["MANAGER_AMBIGUOUS"]
        : [];
  const shareAnswer = (resolution.action === "pick" || resolution.action === "drop") && family.length > 0 && item.rawMention;
  const siblings = shareAnswer
    ? await prisma.reviewItem.findMany({
        where: { messageId: message.id, status: "OPEN", id: { not: itemId }, kind: { in: family }, rawMention: item.rawMention },
        select: { id: true },
      })
    : [];

  await prisma.reviewItem.updateMany({
    where: { id: { in: [itemId, ...siblings.map((s) => s.id)] } },
    data: { status: "RESOLVED", resolution: stored, resolvedById: actorId, resolvedAt: now },
  });
  return evaluateMessage(prisma, message.id);
}

/** Manager approves or rejects a doctor an MR added. */
export async function decideDoctor(prisma: PrismaClient, doctorId: string, actorId: string, approve: boolean) {
  const actor = await prisma.user.findUnique({ where: { id: actorId } });
  if (!actor || actor.role === "MR") throw new ReviewError("Only a manager or admin can approve doctors");
  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
  if (!doctor || doctor.companyId !== actor.companyId) throw new NotFoundError(`Doctor ${doctorId} not found`);
  if (doctor.status !== "PENDING_APPROVAL") throw new ReviewError(`Doctor is already ${doctor.status}`);
  // TODO(Phase 3): on reject, reverse the events already logged against this doctor.
  return prisma.doctor.update({ where: { id: doctorId }, data: { status: approve ? "ACTIVE" : "REJECTED" } });
}

async function decideStockReport(
  prisma: PrismaClient,
  itemId: string,
  proposal: StockProposal | null,
  message: { id: string; companyId: string; mrId: string; recordedAt: Date },
  actorId: string,
  approve: boolean
) {
  if (!proposal) throw new ReviewError("This stock report has no proposal");
  const now = new Date();
  await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.reviewItem.updateMany({
        where: { id: itemId, status: "OPEN" },
        data: { status: "RESOLVED", resolution: { action: approve ? "approve" : "reject" }, resolvedById: actorId, resolvedAt: now },
      });
      if (claimed.count !== 1) throw new ReviewError("Review item is already RESOLVED");
      if (!approve) return;

      if (proposal.direction === "out") {
        const bal = await tx.event.aggregate({
          where: { mrId: message.mrId, productId: proposal.productId },
          _sum: { stockDelta: true },
        });
        const available = bal._sum.stockDelta ?? 0;
        if (proposal.baseQuantity > available) {
          throw new ReviewError(`Can't approve: the MR's ${proposal.productName} stock is now ${available}, the report removes ${proposal.baseQuantity}.`);
        }
      }
      const draft =
        proposal.direction === "received"
          ? {
              type: "sample_received",
              payload: {
                quantity: proposal.quantity,
                unit: proposal.unit,
                note: `Reported by MR ("${proposal.mention}"), approved`,
                source: "mr_report",
                approvedById: actorId,
              },
              productId: proposal.productId,
              stockDelta: proposal.baseQuantity,
            }
          : {
              type: "stock_adjusted",
              payload: {
                quantity: proposal.quantity,
                unit: proposal.unit,
                reason: proposal.reason ?? "unspecified",
                rawProductMention: proposal.mention,
                approvedById: actorId,
              },
              productId: proposal.productId,
              stockDelta: -proposal.baseQuantity,
            };
      const { schemaVersion, payload } = validateEventDraft(draft);
      await tx.event.create({
        data: {
          companyId: message.companyId,
          mrId: message.mrId,
          messageId: message.id,
          type: draft.type,
          schemaVersion,
          // When it physically happened = when the MR reported it.
          occurredAt: message.recordedAt,
          occurredOn: istDate(message.recordedAt),
          productId: draft.productId,
          stockDelta: draft.stockDelta,
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
    { isolationLevel: "Serializable" } // two approvals can't both spend the same stock
  );
}
