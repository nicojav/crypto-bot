import { buildApp } from "./app.js";
import { prisma } from "./db.js";
import { env } from "./env.js";

const app = buildApp(prisma, { level: env.LOG_LEVEL });

app.listen({ port: env.PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`ready on :${env.PORT}`);
});
