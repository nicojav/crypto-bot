import "dotenv/config";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "./createServer.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[dashboard] missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

const server = createDashboardServer({
  distDir: join(__dirname, "..", "dist"),
  botUrl: requireEnv("BOT_URL"),
  apiToken: requireEnv("API_TOKEN"),
  password: requireEnv("DASHBOARD_PASSWORD"),
});

server.listen(PORT, () => {
  console.log(`[dashboard] listening on :${PORT}`);
});
