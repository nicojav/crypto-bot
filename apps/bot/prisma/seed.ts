import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";
import "dotenv/config";

const dbUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const adapter = new PrismaBetterSqlite3({ url: dbUrl });
const prisma = new PrismaClient({ adapter });

async function main() {
  const existing = await prisma.bot.findFirst({ where: { name: "Test Bot" } });
  if (existing) {
    console.log("Seed already applied — skipping.");
    return;
  }

  const bot = await prisma.bot.create({
    data: {
      name: "Test Bot",
      symbol: "BTCUSDT",
      enabled: true,
      dryRun: true,
      maxLeverage: 10,
      maxPositionUsd: 100,
    },
  });

  console.log(`Created bot: ${bot.name} (id=${bot.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
