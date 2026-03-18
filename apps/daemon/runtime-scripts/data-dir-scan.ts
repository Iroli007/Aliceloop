import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const dataDir = process.env.ALICELOOP_DATA_DIR?.trim() ? resolve(process.env.ALICELOOP_DATA_DIR) : null;
const entries =
  dataDir && existsSync(dataDir)
    ? readdirSync(dataDir, { withFileTypes: true })
        .map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? "dir" : "file",
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    : [];

process.stdout.write(
  `${JSON.stringify({
    script: "data-dir-scan",
    dataDir,
    entries,
  })}\n`,
);
