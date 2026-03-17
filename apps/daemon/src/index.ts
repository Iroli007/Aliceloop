import { createServer } from "./server";

const port = Number(process.env.ALICELOOP_DAEMON_PORT ?? 3030);
const host = process.env.ALICELOOP_DAEMON_HOST ?? "127.0.0.1";

async function start() {
  const server = await createServer();
  await server.listen({
    host,
    port,
  });
}

start().catch((error) => {
  console.error("[aliceloop-daemon] failed to start", error);
  process.exitCode = 1;
});

