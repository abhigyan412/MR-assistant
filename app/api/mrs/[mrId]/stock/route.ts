import { handle } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getStock } from "@/lib/views";

export const dynamic = "force-dynamic";

// GET /api/mrs/:mrId/stock — sample stock, derived from the event ledger.
export function GET(_request: Request, { params }: { params: { mrId: string } }) {
  return handle(() => getStock(prisma, params.mrId));
}
