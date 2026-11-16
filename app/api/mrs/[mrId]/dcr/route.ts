import { z } from "zod";
import { istDate } from "@/lib/dates";
import { handle } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getDcr } from "@/lib/views";

export const dynamic = "force-dynamic";

// GET /api/mrs/:mrId/dcr?date=YYYY-MM-DD (IST date; default today in IST)
export function GET(request: Request, { params }: { params: { mrId: string } }) {
  const date = new URL(request.url).searchParams.get("date") ?? istDate(new Date());
  return handle(async () => getDcr(prisma, params.mrId, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(date)));
}
