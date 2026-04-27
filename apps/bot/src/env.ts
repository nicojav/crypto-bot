import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  BYBIT_API_KEY: z.string().min(1),
  BYBIT_API_SECRET: z.string().min(1),
  BYBIT_TESTNET: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  WEBHOOK_SECRET: z.string().min(16),
  DATABASE_URL: z.string().min(1).default("file:./dev.db"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

const result = schema.safeParse(process.env);

if (!result.success) {
  console.error("Invalid environment variables:");
  console.error(result.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = result.data;
