import { loadMrContext } from "@/lib/context";
import { handle } from "@/lib/http";
import { NotFoundError } from "@/lib/pipeline";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/mrs/:mrId/catalog — the MR's doctors/products/managers, for
// "pick another" on review cards and the admin receipt form.
export function GET(_request: Request, { params }: { params: { mrId: string } }) {
  return handle(async () => {
    const mr = await prisma.user.findUnique({ where: { id: params.mrId } });
    if (!mr) throw new NotFoundError(`MR ${params.mrId} not found`);
    const ctx = await loadMrContext(prisma, mr.companyId, mr.id);
    return {
      doctors: ctx.doctors.map(({ id, name, specialty, area }) => ({ id, name, specialty, area })),
      products: ctx.products.map(({ id, brandName, baseUnit, units }) => ({ id, brandName, baseUnit, units })),
      managers: ctx.managers.map(({ id, name, role }) => ({ id, name, role })),
    };
  });
}
