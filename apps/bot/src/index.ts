import Fastify from "fastify";

import { env } from "./env.js";

const app = Fastify({ logger: { level: env.LOG_LEVEL } });

app.get("/health", async () => ({ status: "ok" }));

app.listen({ port: env.PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`ready on :${env.PORT}`);
});
