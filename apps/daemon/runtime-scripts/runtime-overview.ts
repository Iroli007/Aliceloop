import { cwd } from "node:process";

const payload = {
  script: "runtime-overview",
  cwd: cwd(),
  dataDir: process.env.ALICELOOP_DATA_DIR ?? null,
  args: process.argv.slice(2),
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
