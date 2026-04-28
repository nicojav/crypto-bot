import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";
import { env } from "./env.js";

const adapter = new PrismaBetterSqlite3({ url: env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
