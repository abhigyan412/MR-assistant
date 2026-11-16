import { z } from "zod";
import { body, handle } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { addSampleReceipt } from "@/lib/views";

export const dynamic = "force-dynamic";

const Schema = z.object({
  entryId: z.string().min(8).max(128), // client-generated: a double-submit can't double stock
  adminId: z.string().min(1),
  mrId: z.string().min(1),
  productId: z.string().min(1),
  quantity: z.number().int().positive().max(100000),
  unit: z.string().trim().min(1),
  note: z.string().trim().max(500).nullable().default(null),
});

// POST /api/admin/sample-receipts — admin manual entry of samples sent to an MR.
export async function POST(request: Request) {
  const raw = await body(request);
  return handle(async () => addSampleReceipt(prisma, Schema.parse(raw)));
}
