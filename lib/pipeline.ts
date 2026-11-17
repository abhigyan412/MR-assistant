import { randomUUID } from "node:crypto";
import { Prisma, type Channel, type PrismaClient } from "@prisma/client";
import { loadMrContext, type MrContext } from "./context";
import { addDays, istDate } from "./dates";
import { validateEventDraft, type EventDraft } from "./events";
import { extractNote } from "./extract";
import { ExtractionSchema } from "./extraction-schema";
import { interpret, type Plan, type RecentSample, type ReviewDraft, type Resolution } from "./interpret";
import {
  InvalidProviderResponseError,
  ProviderError,
  ProviderRefusalError,
  ProviderTimeoutError,
  type ExtractionProvider,
} from "./llm";
import { messageAudioPrefix } from "./audio";
import { aliasKey } from "./matching";

// Message pipeline (ARCHITECTURE.md §Pipeline):
//   claim id -> extract (LLM) -> evaluate (deterministic) -> review cards OR events.
// `evaluateMessage` is re-run after every review resolution.

export const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD) || 0.6;

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface ProcessNoteInput {
  messageId: string; // generated on the device when recording/typing started
  mrId: string;
  text: string;
  recordedAt: Date;
  channel: Channel;
  transcript?: string | null;
  // Voice notes: segments already stored under audio/<messageId>/ by /api/voice/transcribe.
  audio?: { mime: string; segments: number; durationMs: number; sttModel: string } | null;
}

const messageInclude = {
  events: { orderBy: { createdAt: "asc" } },
  reviewItems: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.MessageInclude;

export type MessageWithDetails = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

export async function processNote(
  prisma: PrismaClient,
  provider: ExtractionProvider,
  input: ProcessNoteInput
): Promise<{ message: MessageWithDetails; isDuplicate: boolean }> {
  const mr = await prisma.user.findUnique({ where: { id: input.mrId } });
  if (!mr || mr.role !== "MR") throw new NotFoundError(`MR ${input.mrId} not found`);

  // 1. Claim the id. A primary-key violation = this exact note was already
  //    received (resend on a bad network): return it as-is, no LLM call,
  //    no new events.
  try {
    await prisma.message.create({
      data: {
        id: input.messageId,
        companyId: mr.companyId,
        mrId: mr.id,
        channel: input.channel,
        recordedAt: input.recordedAt,
        text: input.text,
        transcript: input.transcript ?? null,
        ...(input.audio
          ? {
              audioKey: messageAudioPrefix(input.messageId),
              audioMime: input.audio.mime,
              audioSegments: input.audio.segments,
              audioDurationMs: input.audio.durationMs,
              sttModel: input.audio.sttModel,
            }
          : {}),
        status: "RECEIVED",
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.message.findUniqueOrThrow({ where: { id: input.messageId }, include: messageInclude });
      return { message: existing, isDuplicate: true };
    }
    throw err;
  }

  // 2. Extract, 3. decide.
  const ctx = await loadMrContext(prisma, mr.companyId, mr.id);
  return { message: await extractAndEvaluate(prisma, provider, input.messageId, input.text, ctx), isDuplicate: false };
}

/** A RECEIVED message whose last attempt is older than this was interrupted. */
export const STALE_PROCESSING_MS = 2 * 60_000;

export class RetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryError";
  }
}

/**
 * Re-run a note that FAILED (LLM timeout / provider error) or got stuck in
 * RECEIVED (the request died mid-way). The note text is never lost: it was
 * stored when the id was claimed. Claiming the retry is atomic, so a double
 * tap or two devices can't process the same note twice.
 */
export async function retryMessage(prisma: PrismaClient, provider: ExtractionProvider, messageId: string): Promise<MessageWithDetails> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw new NotFoundError(`Message ${messageId} not found`);
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const claimed = await prisma.message.updateMany({
    where: {
      id: messageId,
      OR: [{ status: "FAILED" }, { status: "RECEIVED", lastAttemptAt: { lt: staleBefore } }],
    },
    data: { status: "RECEIVED", errorReason: null, attempts: { increment: 1 }, lastAttemptAt: new Date() },
  });
  if (claimed.count === 0) {
    throw new RetryError(
      message.status === "RECEIVED" ? "This note is still being processed — try again in a minute." : `Nothing to retry (note is ${message.status}).`
    );
  }
  const ctx = await loadMrContext(prisma, message.companyId, message.mrId);
  // Extraction already stored (the failure came after it): only re-decide.
  if (ExtractionSchema.safeParse(message.extraction).success) return evaluateMessage(prisma, messageId, ctx);
  return extractAndEvaluate(prisma, provider, messageId, message.text, ctx);
}

async function extractAndEvaluate(
  prisma: PrismaClient,
  provider: ExtractionProvider,
  messageId: string,
  text: string,
  ctx: MrContext
): Promise<MessageWithDetails> {
  try {
    const outcome = await extractNote(provider, ctx, text);
    await prisma.message.update({
      where: { id: messageId },
      data: {
        extraction: outcome.extraction as unknown as Prisma.InputJsonValue,
        rawModelOutput: (outcome.result.rawText ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
        model: outcome.result.model,
        promptVersion: outcome.promptVersion,
      },
    });
  } catch (err) {
    const known =
      err instanceof ProviderTimeoutError ||
      err instanceof ProviderError ||
      err instanceof ProviderRefusalError ||
      err instanceof InvalidProviderResponseError;
    if (!known) throw err;
    const raw = err instanceof InvalidProviderResponseError ? err.raw : null;
    return prisma.message.update({
      where: { id: messageId },
      data: {
        status: "FAILED",
        errorReason: err.message,
        rawModelOutput: raw === null ? Prisma.DbNull : (raw as Prisma.InputJsonValue),
        model: provider.model,
      },
      include: messageInclude,
    });
  }
  return evaluateMessage(prisma, messageId, ctx);
}

/**
 * Run the deterministic interpretation against current DB state and apply
 * the outcome: sync review cards, or write the events and mark PROCESSED.
 * Safe to call repeatedly; a PROCESSED/DISCARDED/FAILED message is left alone.
 */
export async function evaluateMessage(
  prisma: PrismaClient,
  messageId: string,
  preloadedCtx?: MrContext
): Promise<MessageWithDetails> {
  const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude });
  if (!["RECEIVED", "NEEDS_REVIEW"].includes(message.status)) return message;

  const parsed = ExtractionSchema.safeParse(message.extraction);
  if (!parsed.success) throw new Error(`Message ${messageId} has no valid extraction`);

  const ctx = preloadedCtx ?? (await loadMrContext(prisma, message.companyId, message.mrId));
  const noteDate = istDate(message.recordedAt);

  const [aliasRows, stockRows, priorVisitRows, recentSampleRows] = await Promise.all([
    prisma.alias.findMany({
      where: { companyId: message.companyId, entityType: { in: ["doctor", "product"] }, OR: [{ userId: message.mrId }, { userId: null }] },
      orderBy: { userId: { sort: "asc", nulls: "first" } }, // company-wide first, MR-specific overrides
    }),
    prisma.event.groupBy({
      by: ["productId"],
      where: { mrId: message.mrId, stockDelta: { not: null } },
      _sum: { stockDelta: true },
    }),
    prisma.event.findMany({
      where: {
        mrId: message.mrId,
        type: "doctor_visit",
        messageId: { not: messageId },
        reversesEventId: null,
        reversedBy: null,
        occurredOn: { gte: addDays(noteDate, -7), lte: addDays(noteDate, 1) },
      },
      select: { doctorId: true, occurredOn: true, messageId: true },
    }),
    prisma.event.findMany({
      where: {
        mrId: message.mrId,
        type: "sample_given",
        messageId: { not: messageId },
        reversesEventId: null,
        reversedBy: null,
        occurredOn: { gte: addDays(noteDate, -7) },
      },
      orderBy: { occurredAt: "desc" },
      take: 30,
    }),
  ]);

  const aliases = { doctor: new Map<string, string>(), product: new Map<string, string>() };
  for (const a of aliasRows) (a.entityType === "doctor" ? aliases.doctor : aliases.product).set(a.alias, a.entityId);

  const stock = new Map<string, number>();
  for (const row of stockRows) if (row.productId) stock.set(row.productId, row._sum.stockDelta ?? 0);

  const doctorNames = await namesFor(prisma, recentSampleRows.map((e) => e.doctorId));
  const recentSamples: RecentSample[] = recentSampleRows.map((e) => {
    const p = e.payload as { quantity: number; unit: string };
    return {
      eventId: e.id,
      doctorId: e.doctorId,
      doctorName: (e.doctorId && doctorNames.get(e.doctorId)) || "Unknown doctor",
      productId: e.productId!,
      productName: ctx.products.find((x) => x.id === e.productId)?.brandName ?? "Unknown product",
      quantity: p.quantity,
      unit: p.unit,
      stockDelta: e.stockDelta ?? 0,
      occurredOn: e.occurredOn,
      visitEventId: e.visitEventId,
    };
  });

  const resolutions = message.reviewItems
    .filter((r) => r.status === "RESOLVED" && r.path && r.resolution)
    .map((r) => ({ path: r.path!, resolution: r.resolution as unknown as Resolution }));

  const result = interpret({
    extraction: parsed.data,
    ctx,
    recordedAt: message.recordedAt,
    aliases,
    stock,
    priorVisits: priorVisitRows.flatMap((v) => (v.doctorId ? [{ doctorId: v.doctorId, occurredOn: v.occurredOn, messageId: v.messageId }] : [])),
    recentSamples,
    resolutions,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
  });

  const reversalSources = result.blocking
    ? []
    : await prisma.event.findMany({ where: { id: { in: result.plan.reversals }, mrId: message.mrId, reversedBy: null } });

  await prisma.$transaction(async (tx) => {
    await syncReviewItems(tx, message, result.reviewItems);

    if (result.blocking) {
      await tx.message.update({
        where: { id: messageId },
        data: { status: "NEEDS_REVIEW", adverseEventFlag: result.adverseEvent },
      });
      return;
    }

    // Guard against a concurrent evaluation writing the same events twice.
    const claimed = await tx.message.updateMany({
      where: { id: messageId, status: { in: ["RECEIVED", "NEEDS_REVIEW"] } },
      data: { status: "PROCESSED", processedAt: new Date(), adverseEventFlag: result.adverseEvent },
    });
    if (claimed.count !== 1) return;

    const rows = buildEventRows(result.plan, reversalSources, {
      companyId: message.companyId,
      mrId: message.mrId,
      messageId,
    });
    if (rows.length) await tx.event.createMany({ data: rows });
  });

  return prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude });
}

async function syncReviewItems(tx: Prisma.TransactionClient, message: MessageWithDetails, drafts: ReviewDraft[]) {
  const key = (kind: string, path: string | null) => `${kind}|${path ?? ""}`;
  const open = message.reviewItems.filter((r) => r.status === "OPEN");
  const wanted = new Map(drafts.map((d) => [key(d.kind, d.path), d]));

  const stale = open.filter((r) => !wanted.has(key(r.kind, r.path))).map((r) => r.id);
  if (stale.length) {
    await tx.reviewItem.updateMany({ where: { id: { in: stale } }, data: { status: "DISMISSED", resolvedAt: new Date() } });
  }
  const openKeys = new Set(open.map((r) => key(r.kind, r.path)));
  const toCreate = drafts.filter((d) => !openKeys.has(key(d.kind, d.path)));
  if (toCreate.length) {
    await tx.reviewItem.createMany({
      data: toCreate.map((d) => ({
        companyId: message.companyId,
        messageId: message.id,
        kind: d.kind,
        path: d.path,
        rawMention: d.rawMention,
        candidates: (d.candidates ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
        assignee: d.assignee,
        detail: d.detail,
        blocking: d.blocking,
        status: "OPEN",
      })),
    });
  }
}

type EventRow = Prisma.EventCreateManyInput;

/** Plan -> validated ledger rows. Every row passes lib/events.ts validation. */
export function buildEventRows(
  plan: Plan,
  reversalSources: { id: string; type: string; payload: unknown; doctorId: string | null; productId: string | null; chemistId: string | null; managerId: string | null; visitEventId: string | null; stockDelta: number | null; occurredAt: Date; occurredOn: string; schemaVersion: number }[],
  base: { companyId: string; mrId: string; messageId: string }
): EventRow[] {
  const rows: EventRow[] = [];
  const push = (draft: EventDraft & { id?: string; occurredAt: Date; occurredOn: string; confidence?: number | null }) => {
    const { schemaVersion, payload } = validateEventDraft(draft);
    rows.push({
      id: draft.id ?? randomUUID(),
      ...base,
      type: draft.type,
      schemaVersion,
      occurredAt: draft.occurredAt,
      occurredOn: draft.occurredOn,
      visitEventId: draft.visitEventId ?? null,
      doctorId: draft.doctorId ?? null,
      productId: draft.productId ?? null,
      chemistId: draft.chemistId ?? null,
      managerId: draft.managerId ?? null,
      stockDelta: draft.stockDelta ?? null,
      reversesEventId: draft.reversesEventId ?? null,
      confidence: draft.confidence ?? null,
      payload: payload as Prisma.InputJsonValue,
    });
  };

  // Reversals first, so a correction's stock arithmetic reads naturally.
  for (const src of reversalSources) {
    push({
      type: src.type,
      payload: src.payload,
      doctorId: src.doctorId,
      productId: src.productId,
      chemistId: src.chemistId,
      managerId: src.managerId,
      visitEventId: src.visitEventId,
      stockDelta: src.stockDelta === null ? null : -src.stockDelta,
      reversesEventId: src.id,
      occurredAt: src.occurredAt,
      occurredOn: src.occurredOn,
    });
  }

  for (const v of plan.visits) {
    const visitId = v.existingVisitId ?? randomUUID();
    const at = { occurredAt: v.occurredAt, occurredOn: v.occurredOn };
    const child = { visitEventId: visitId, doctorId: v.doctorId, ...at };
    if (!v.existingVisitId) {
      push({
        id: visitId,
        type: "doctor_visit",
        payload: { met: v.met, visitTime: v.visitTime, timeKnown: v.timeKnown, rawDoctorMention: v.doctorMention },
        doctorId: v.doctorId,
        confidence: v.confidence,
        ...at,
      });
    }
    for (const m of v.jointWork) push({ type: "joint_work", payload: { rawMention: m.mention }, managerId: m.managerId, ...child });
    for (const d of v.detailed) push({ type: "product_detailed", payload: { rawProductMention: d.mention }, productId: d.productId, ...child });
    for (const s of v.samples)
      push({
        type: "sample_given",
        payload: { quantity: s.quantity, unit: s.unit, rawProductMention: s.mention },
        productId: s.productId,
        stockDelta: -s.baseQuantity,
        ...child,
      });
    for (const q of v.queries)
      push({ type: "doctor_query", payload: { question: q.question, rawProductMention: q.mention }, productId: q.productId, ...child });
    for (const f of v.followUps)
      push({
        type: "follow_up",
        payload: { action: f.action, whenPhrase: f.whenPhrase, dueDate: f.dueDate, dueRule: f.dueRule, pendingPartnerConfirmation: f.pending },
        ...child,
      });
    for (const p of v.pobs)
      push({
        type: "pob",
        payload: { quantity: p.quantity, unit: p.unit, orderedBy: "doctor", chemistName: p.chemistName, rawProductMention: p.mention },
        productId: p.productId,
        chemistId: p.chemistId,
        ...child,
      });
  }

  for (const c of plan.chemistCalls) {
    for (const p of c.pobs)
      push({
        type: "pob",
        payload: { quantity: p.quantity, unit: p.unit, orderedBy: "chemist", chemistName: c.chemistName, rawProductMention: p.mention },
        productId: p.productId,
        chemistId: c.chemistId,
        occurredAt: c.occurredAt,
        occurredOn: c.occurredOn,
      });
  }
  return rows;
}

async function namesFor(prisma: PrismaClient, doctorIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(doctorIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await prisma.doctor.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

export { aliasKey };
