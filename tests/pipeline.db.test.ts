import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { parse as parseEnv } from "dotenv";
import { contextFromSeed } from "@/lib/context";
import type { Extraction } from "@/lib/extraction-schema";
import { ProviderTimeoutError, type ExtractionProvider } from "@/lib/llm";
import { evaluateMessage, processNote, retryMessage, RetryError, STALE_PROCESSING_MS } from "@/lib/pipeline";
import { decideDoctor, resolveReviewItem } from "@/lib/review";
import { addSampleReceipt, getDcr, getStock, managerQueue } from "@/lib/views";
import { seed } from "@/prisma/seed";
import { extraction, n01, noDue, refOf, visit } from "./fixtures";

// Integration tests against a real Postgres: the Neon `test` branch (no Docker).
//   TEST_DATABASE_URL="$(neon connection-string test)" npx vitest run tests/pipeline.db.test.ts
// (see README "Tests"). Skipped when TEST_DATABASE_URL is not set.
// Every test TRUNCATEs all tables, so it refuses to run against the app's database.

const url = process.env.TEST_DATABASE_URL;
assertNotAppDatabase(url);

function assertNotAppDatabase(testUrl: string | undefined) {
  if (!testUrl) return;
  // vitest doesn't load .env; read it (and the process env) for the app's URLs.
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnv(readFileSync(".env"));
  } catch {
    /* no .env file */
  }
  // Same Neon endpoint (pooled "-pooler" or direct) + same database = same data.
  const key = (u: string) => {
    try {
      const p = new URL(u);
      return `${p.hostname.replace("-pooler", "")}/${p.pathname.replace(/^\//, "")}`;
    } catch {
      return u;
    }
  };
  const app = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]
    .flatMap((k) => [process.env[k], fileEnv[k]])
    .filter((u): u is string => !!u);
  if (app.some((u) => key(u) === key(testUrl))) {
    throw new Error("TEST_DATABASE_URL points at the app's database (DATABASE_URL). Refusing: these tests TRUNCATE every table. Use the Neon `test` branch.");
  }
}
// A remote database (Neon test branch) costs a network round trip per query;
// the per-test reset + seed is dozens of them.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const ctx = contextFromSeed("MR-ROHIT"); // refs match the DB context (same ordering by code)
const AT = new Date("2026-11-18T11:00:00+05:30");

describe.skipIf(!url)("pipeline (database)", () => {
  // skipIf still runs this body to collect tests, so don't construct a client without a URL.
  const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : (undefined as unknown as PrismaClient);
  const ids: Record<string, string> = {};
  let calls = 0;
  const scripted = new Map<string, Extraction | Error>();

  const provider: ExtractionProvider = {
    id: "scripted",
    model: "scripted",
    async generate(req) {
      calls++;
      const note = req.user.replace(/^MR note:\n/, "");
      const out = scripted.get(note);
      if (!out) throw new Error(`No scripted extraction for "${note}"`);
      if (out instanceof Error) throw out;
      return { output: out, rawText: JSON.stringify(out), model: "scripted", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, latencyMs: 0 };
    },
  };

  const note = (id: string, text: string, ext: Extraction | Error, at = AT) => {
    scripted.set(text, ext);
    return processNote(prisma, provider, { messageId: id, mrId: ids["MR-ROHIT"], text, recordedAt: at, channel: "WEB_TEXT" });
  };
  const stockOf = async (code: string) => (await getStock(prisma, ids["MR-ROHIT"])).find((s) => s.productId === ids[code])!.balance;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE "Event", "ReviewItem", "Message", "Alias", "ProductUnit", "Product", "Doctor", "Chemist", "User", "Territory", "Company" CASCADE`
    );
    await seed(prisma);
    calls = 0;
    scripted.clear();
    for (const u of await prisma.user.findMany()) ids[u.code] = u.id;
    for (const d of await prisma.doctor.findMany()) ids[d.externalCode!] = d.id;
    for (const p of await prisma.product.findMany()) ids[p.code] = p.id;
  });

  afterAll(() => prisma.$disconnect());

  it("N01: processes a clean note into events, moves stock, builds the DCR", async () => {
    const { message } = await note("m-n01", "N01 text", n01(ctx));
    expect(message.status).toBe("PROCESSED");
    expect(message.events.map((e) => e.type).sort()).toEqual(
      ["doctor_query", "doctor_visit", "follow_up", "product_detailed", "sample_given"].sort()
    );
    expect(await stockOf("PRD-ZEN40")).toBe(37); // 40 opening - 3

    const dcr = await getDcr(prisma, ids["MR-ROHIT"], "2026-11-18");
    expect(dcr.visits).toHaveLength(1);
    expect(dcr.visits[0]).toMatchObject({
      doctor: { name: "Dr. Anil Verma" },
      met: true,
      detailed: ["Zentapra-40"],
      samples: [{ product: "Zentapra-40", quantity: 3, unit: "strip" }],
      followUps: [{ dueDate: "2026-11-25", provisionalRule: true }],
    });
  });

  it("N14: a resent note (same message id) is a no-op — no LLM call, no double stock", async () => {
    await note("m-dup", "N01 text", n01(ctx));
    const again = await note("m-dup", "N01 text", n01(ctx));
    expect(again.isDuplicate).toBe(true);
    expect(calls).toBe(1);
    expect(await stockOf("PRD-ZEN40")).toBe(37);
    expect(await prisma.event.count({ where: { type: "doctor_visit" } })).toBe(1);
  });

  it("provider timeout -> FAILED, nothing written", async () => {
    const { message } = await note("m-timeout", "slow", new ProviderTimeoutError("timed out"));
    expect(message.status).toBe("FAILED");
    expect(message.errorReason).toMatch(/timed out/);
    expect(message.events).toHaveLength(0);
  });

  it("retry: a FAILED note keeps its text and is re-processed once; a second retry is refused", async () => {
    await note("m-retry", "retry me", new ProviderTimeoutError("timed out"));
    scripted.set("retry me", n01(ctx)); // the provider works now
    const done = await retryMessage(prisma, provider, "m-retry");
    expect(done.status).toBe("PROCESSED");
    expect(done.text).toBe("retry me");
    expect(done.attempts).toBe(2);
    expect(await stockOf("PRD-ZEN40")).toBe(37);
    await expect(retryMessage(prisma, provider, "m-retry")).rejects.toBeInstanceOf(RetryError);
    expect(await stockOf("PRD-ZEN40")).toBe(37);
  });

  it("retry: a note still processing is refused; one stuck past the stale window is re-processed", async () => {
    await prisma.message.create({
      data: {
        id: "m-stuck",
        companyId: (await prisma.company.findFirstOrThrow()).id,
        mrId: ids["MR-ROHIT"],
        channel: "WEB_TEXT",
        recordedAt: AT,
        text: "stuck note",
        status: "RECEIVED",
      },
    });
    scripted.set("stuck note", n01(ctx));
    await expect(retryMessage(prisma, provider, "m-stuck")).rejects.toThrow(/still being processed/);
    await prisma.message.update({ where: { id: "m-stuck" }, data: { lastAttemptAt: new Date(Date.now() - STALE_PROCESSING_MS - 1000) } });
    expect((await retryMessage(prisma, provider, "m-stuck")).status).toBe("PROCESSED");
  });

  it("one answer covers the same question asked twice in a note ('Telmora' detailed AND sampled)", async () => {
    const telmora = { mention: "Telmora", ref: null };
    const { message } = await note(
      "m-twice",
      "Verma sir ko Telmora detail kiya, 2 strip diye",
      extraction({
        visits: [
          visit({
            doctor: { mention: "Verma sir", ref: refOf(ctx, "doctors", "DR-001"), evidence: null },
            detailed: [telmora],
            samples: [{ product: telmora, quantity: 2, unit: "strip" }],
          }),
        ],
      })
    );
    const cards = message.reviewItems.filter((r) => r.status === "OPEN");
    expect(cards.map((c) => c.kind)).toEqual(["PRODUCT_AMBIGUOUS", "PRODUCT_AMBIGUOUS"]);
    const done = await resolveReviewItem(prisma, cards[0].id, ids["MR-ROHIT"], { action: "pick", id: ids["PRD-TEL40"] });
    expect(done.status).toBe("PROCESSED");
    expect(done.reviewItems.every((r) => r.status === "RESOLVED")).toBe(true);
    expect(done.events.filter((e) => e.productId === ids["PRD-TEL40"]).map((e) => e.type).sort()).toEqual(["product_detailed", "sample_given"]);
  });

  it("N04: ambiguous doctor + brand -> review cards; MR taps -> PROCESSED; alias learned for next time", async () => {
    const sharma = () =>
      extraction({
        visits: [
          visit({
            doctor: { mention: "Sharma ji", ref: null, evidence: null },
            samples: [{ product: { mention: "Telmora", ref: null }, quantity: 2, unit: "strip" }],
          }),
        ],
      });
    const first = await note("m-n04", "Sharma ji ko Telmora 2 strip", sharma());
    expect(first.message.status).toBe("NEEDS_REVIEW");
    expect(first.message.events).toHaveLength(0);
    const cards = first.message.reviewItems.filter((r) => r.status === "OPEN");
    expect(cards.map((c) => c.kind).sort()).toEqual(["DOCTOR_AMBIGUOUS", "PRODUCT_AMBIGUOUS"]);

    const doctorCard = cards.find((c) => c.kind === "DOCTOR_AMBIGUOUS")!;
    await resolveReviewItem(prisma, doctorCard.id, ids["MR-ROHIT"], { action: "pick", id: ids["DR-003"] });
    const productCard = cards.find((c) => c.kind === "PRODUCT_AMBIGUOUS")!;
    const done = await resolveReviewItem(prisma, productCard.id, ids["MR-ROHIT"], { action: "pick", id: ids["PRD-TEL40"] });
    expect(done.status).toBe("PROCESSED");
    expect(done.events.find((e) => e.type === "doctor_visit")!.doctorId).toBe(ids["DR-003"]);
    expect(await stockOf("PRD-TEL40")).toBe(28);

    // Next day, same words: resolves by itself from the learned aliases.
    const next = await note("m-n04b", "Sharma ji ko Telmora 2 strip (next day)", sharma(), new Date("2026-11-19T11:00:00+05:30"));
    expect(next.message.status).toBe("PROCESSED");
  });

  it("N19: insufficient stock -> STOCK_INSUFFICIENT; admin logs the receipt; recheck -> PROCESSED", async () => {
    const coughzen10 = extraction({
      visits: [visit({ doctor: { mention: "Verma sir", ref: null, evidence: null }, samples: [{ product: { mention: "Coughzen", ref: null }, quantity: 10, unit: "bottle" }] })],
    });
    const { message } = await note("m-n19", "Verma sir ko Coughzen ke 10 bottle", coughzen10);
    expect(message.status).toBe("NEEDS_REVIEW");
    expect(message.reviewItems.map((r) => r.kind)).toEqual(["STOCK_INSUFFICIENT"]);
    expect(await stockOf("PRD-COUGH")).toBe(6); // never negative

    const receipt = { entryId: "rcpt-1", adminId: ids["ADMIN-OPS"], mrId: ids["MR-ROHIT"], productId: ids["PRD-COUGH"], quantity: 10, unit: "bottle", note: "Dispatch #42" };
    expect(await addSampleReceipt(prisma, receipt)).toEqual({ duplicate: false });
    expect(await addSampleReceipt(prisma, receipt)).toEqual({ duplicate: true }); // double-submit safe

    const rechecked = await evaluateMessage(prisma, "m-n19");
    expect(rechecked.status).toBe("PROCESSED");
    expect(await stockOf("PRD-COUGH")).toBe(6); // 6 + 10 - 10
  });

  it("N13: a correction reverses the original sample and attaches to the same visit", async () => {
    await note("m-n01c", "N01 text", n01(ctx));
    const zen = { mention: "Zentapra", ref: refOf(ctx, "products", "PRD-ZEN40") };
    const correction = extraction({
      visits: [visit({ doctor: { mention: "Dr Verma", ref: refOf(ctx, "doctors", "DR-001"), evidence: null }, samples: [{ product: zen, quantity: 2, unit: "strip" }] })],
      correction: { isCorrection: true, description: "2 strips, not 3" },
    });
    const { message } = await note("m-n13", "pichle note mein galti, 3 nahi 2 strip", correction, new Date("2026-11-18T12:00:00+05:30"));
    expect(message.reviewItems.map((r) => r.kind)).toEqual(["CORRECTION_REQUESTED"]);
    const card = message.reviewItems[0];
    const original = (card.candidates as { id: string }[])[0].id;

    const done = await resolveReviewItem(prisma, card.id, ids["MR-ROHIT"], { action: "reverse", eventIds: [original] });
    expect(done.status).toBe("PROCESSED");
    expect(await stockOf("PRD-ZEN40")).toBe(38); // 40 - 3 + 3 - 2

    const dcr = await getDcr(prisma, ids["MR-ROHIT"], "2026-11-18");
    expect(dcr.visits).toHaveLength(1); // still one Verma visit
    expect(dcr.visits[0].samples).toEqual([expect.objectContaining({ quantity: 2 })]);
  });

  it("adverse event: DCR not blocked, manager gets a card and can acknowledge", async () => {
    const ae = n01(ctx);
    ae.adverseEvent = { mentioned: true, summary: "Rash in a child after Coughzen" };
    const { message } = await note("m-ae", "AE note", ae);
    expect(message.status).toBe("PROCESSED");
    expect(message.adverseEventFlag).toBe(true);

    const queue = await managerQueue(prisma, ids["ABM-DELHI"]);
    expect(queue.managerItems.map((i) => i.kind)).toEqual(["ADVERSE_EVENT"]);
    await expect(resolveReviewItem(prisma, queue.managerItems[0].id, ids["MR-ROHIT"], { action: "acknowledge" })).rejects.toThrow(/manager/);
    await resolveReviewItem(prisma, queue.managerItems[0].id, ids["ABM-DELHI"], { action: "acknowledge" });
    expect((await managerQueue(prisma, ids["ABM-DELHI"])).managerItems).toHaveLength(0);
  });

  it("N12: MR adds a new doctor -> logged now, manager approves later", async () => {
    const ext = extraction({
      visits: [visit({ doctor: { mention: "Dr Ritu Arora, skin specialist, Kalkaji", ref: null, evidence: null }, detailed: [{ mention: "Ostiva", ref: null }] })],
    });
    const { message } = await note("m-n12", "naye doctor Dr Ritu Arora", ext);
    const card = message.reviewItems.find((r) => r.kind === "DOCTOR_NOT_FOUND")!;
    const done = await resolveReviewItem(prisma, card.id, ids["MR-ROHIT"], {
      action: "newDoctor",
      name: "Dr. Ritu Arora",
      specialty: "Dermatologist",
      area: "Kalkaji",
    });
    expect(done.status).toBe("PROCESSED");

    const queue = await managerQueue(prisma, ids["ABM-DELHI"]);
    expect(queue.pendingDoctors.map((d) => d.name)).toEqual(["Dr. Ritu Arora"]);
    const dcr = await getDcr(prisma, ids["MR-ROHIT"], "2026-11-18");
    expect(dcr.visits[0].doctor).toMatchObject({ name: "Dr. Ritu Arora", pendingApproval: true });

    await decideDoctor(prisma, queue.pendingDoctors[0].id, ids["ABM-DELHI"], true);
    expect((await managerQueue(prisma, ids["ABM-DELHI"])).pendingDoctors).toHaveLength(0);
  });

  it("same doctor twice in a day -> asks; 'same visit' discards the second note", async () => {
    await note("m-first", "N01 text", n01(ctx));
    const { message } = await note("m-second", "N01 text again (re-recorded)", n01(ctx));
    expect(message.reviewItems.map((r) => r.kind)).toEqual(["POSSIBLE_DUPLICATE_VISIT"]);
    const done = await resolveReviewItem(prisma, message.reviewItems[0].id, ids["MR-ROHIT"], { action: "sameVisit" });
    expect(done.status).toBe("DISCARDED");
    expect(await stockOf("PRD-ZEN40")).toBe(37); // counted once
  });

  it("DCR shows missed visits and chemist calls", async () => {
    await note(
      "m-n17",
      "Dr Bedi available nahi the",
      extraction({ visits: [visit({ doctor: { mention: "Dr Bedi", ref: refOf(ctx, "doctors", "DR-006"), evidence: null }, met: false, followUps: [{ action: "Visit again", due: noDue }] })] })
    );
    await note(
      "m-v3",
      "Verma Medical Store order",
      extraction({ chemistCalls: [{ chemist: { mention: "Verma Medical Store", ref: null }, dayOffset: 0, pobs: [{ product: { mention: "Zentapra", ref: null }, quantity: 20, unit: "strip" }] }] })
    );
    const dcr = await getDcr(prisma, ids["MR-ROHIT"], "2026-11-18");
    expect(dcr.summary).toMatchObject({ visits: 1, met: 0, missed: 1 });
    expect(dcr.chemistCalls).toEqual([{ chemist: "Verma Medical Store", pobs: [{ product: "Zentapra-40", quantity: 20, unit: "strip" }] }]);
    expect(await stockOf("PRD-ZEN40")).toBe(40); // POB never moves sample stock
  });
});
