import { signedAudioUrls } from "@/lib/audio";
import { handle } from "@/lib/http";
import { NotFoundError } from "@/lib/pipeline";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/messages/:id/audio — short-lived (10 min) playback URLs for a voice
// note's recorded segments, in order. Empty once retention cleanup ran.
export function GET(_request: Request, { params }: { params: { id: string } }) {
  return handle(async () => {
    const message = await prisma.message.findUnique({ where: { id: params.id }, select: { audioKey: true } });
    if (!message) throw new NotFoundError(`Message ${params.id} not found`);
    return { urls: message.audioKey ? await signedAudioUrls(params.id) : [] };
  });
}
