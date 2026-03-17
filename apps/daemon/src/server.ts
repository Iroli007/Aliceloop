import Fastify from "fastify";
import cors from "@fastify/cors";
import { getShellOverview, shellOverviewRoute } from "./repositories/overviewRepository";

export async function createServer() {
  const server = Fastify({
    logger: true,
  });

  await server.register(cors, {
    origin: true,
  });

  server.get("/health", async () => ({
    ok: true,
    service: "aliceloop-daemon",
    timestamp: new Date().toISOString(),
  }));

  server.get(shellOverviewRoute, async () => getShellOverview());

  return server;
}

