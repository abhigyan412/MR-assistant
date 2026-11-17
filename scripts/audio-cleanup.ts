// npm run audio:cleanup — run the audio retention job once against the
// database / bucket in .env (the deployed app runs it daily via Vercel Cron).
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { runAudioRetention } from "../lib/retention";

const prisma = new PrismaClient();
runAudioRetention(prisma)
  .then((r) => console.log("Audio retention:", r))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
