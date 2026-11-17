// npm run demo:reset — wipe the Neon DEMO branch and load the Varanasi demo
// world, so the 2-minute demo starts from the same state every time.
//
// Target: DEMO_DATABASE_URL_UNPOOLED (direct) from .env. Refuses to run if it
// is the app's DATABASE_URL (production branch): this TRUNCATEs every table.

import "dotenv/config";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { VARANASI } from "../prisma/demo-data";
import { seed } from "../prisma/seed";

const target = process.env.DEMO_DATABASE_URL_UNPOOLED;
if (!target) {
  console.error("DEMO_DATABASE_URL_UNPOOLED is not set (the Neon demo branch's direct URL). See README.");
  process.exit(1);
}

// Same Neon endpoint (pooled or direct) + same database = same data.
const key = (u: string) => {
  const p = new URL(u);
  return `${p.hostname.replace("-pooler", "")}/${p.pathname.replace(/^\//, "")}`;
};
const app = [process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED].filter((u): u is string => !!u);
if (app.some((u) => key(u) === key(target))) {
  console.error("Refusing: DEMO_DATABASE_URL_UNPOOLED is the app's DATABASE_URL. demo:reset only wipes the demo branch.");
  process.exit(1);
}

async function main() {
  const host = new URL(target!).hostname;
  console.log(`Demo branch: ${host}`);

  console.log("1/3 migrations…");
  execSync("npx prisma migrate deploy", {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, DATABASE_URL: target, DATABASE_URL_UNPOOLED: target },
  });

  const prisma = new PrismaClient({ datasources: { db: { url: target } } });
  try {
    console.log("2/3 wiping demo data…");
    await prisma.$executeRawUnsafe(
      `TRUNCATE "Event", "ReviewItem", "Message", "Alias", "ProductUnit", "Product", "Doctor", "Chemist", "User", "Territory", "Company" CASCADE`
    );
    console.log("3/3 loading Varanasi…");
    const counts = await seed(prisma, VARANASI);
    console.log("Done:", counts);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
