import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../env.js";

const bodySchema = z.object({
  secret: z.string(),
  webhookId: z.string().min(1),
  // TradingView sends lowercase ("buy", "sell") via {{strategy.order.action}}
  action: z
    .string()
    .transform((s) => s.toUpperCase())
    .pipe(z.enum(["BUY", "SELL", "CLOSE"])),
  symbol: z.string().min(1),
  price: z.number().optional(),
  meta: z.record(z.unknown()).optional(),
});

function secretsMatch(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // always run timingSafeEqual to avoid length-leaking timing side-channel
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function isPrismaUniqueConflict(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

export const webhookPlugin: FastifyPluginAsync<{ db: PrismaClient }> = async (
  fastify,
  { db }
) => {
  fastify.post<{ Params: { botId: string }; Body: unknown }>(
    "/webhook/:botId",
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid payload", details: parsed.error.flatten() });
      }

      const { secret, webhookId, action, symbol, price, meta } = parsed.data;

      if (!secretsMatch(secret, env.WEBHOOK_SECRET)) {
        request.log.warn("webhook: bad secret");
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const botId = Number(request.params.botId);
      if (!Number.isInteger(botId) || botId <= 0) {
        return reply.status(404).send({ error: "Bot not found" });
      }

      const bot = await db.bot.findUnique({ where: { id: botId } });
      if (!bot || !bot.enabled) {
        return reply.status(404).send({ error: "Bot not found" });
      }

      try {
        await db.signal.create({
          data: {
            botId: bot.id,
            webhookId,
            action,
            payload: JSON.stringify({ symbol, price, meta }),
            status: "PENDING",
          },
        });
        request.log.info({ botId: bot.id, webhookId, action }, "signal accepted");
        return reply.status(202).send({ status: "ACCEPTED" });
      } catch (err: unknown) {
        if (isPrismaUniqueConflict(err)) {
          request.log.info({ webhookId }, "duplicate signal");
          return reply.status(200).send({ status: "DUPLICATE" });
        }
        throw err;
      }
    }
  );
};
