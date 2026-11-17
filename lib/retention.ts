import type { PrismaClient } from "@prisma/client";
import { deleteExpiredAudio } from "./audio";

// Audio retention: recordings may contain patient names, so they're deleted
// after AUDIO_RETENTION_DAYS (default 30). The raw transcript, final text and
// events stay; Message.audioKey is cleared so the UI shows "deleted".

export function retentionDays(): number {
  const n = Number(process.env.AUDIO_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export async function runAudioRetention(prisma: PrismaClient, now = new Date()) {
  const days = retentionDays();
  const { deletedObjects, messageIds } = await deleteExpiredAudio(days, now);
  const cleared = messageIds.length
    ? (await prisma.message.updateMany({ where: { id: { in: messageIds } }, data: { audioKey: null } })).count
    : 0;
  return { retentionDays: days, deletedObjects, messagesCleared: cleared };
}
