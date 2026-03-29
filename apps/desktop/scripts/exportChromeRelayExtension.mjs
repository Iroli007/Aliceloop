import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, "..");
const workspaceRoot = join(desktopRoot, "..", "..");
const sourceDir = join(workspaceRoot, "chrome-extension");
const outputDir = join(desktopRoot, "release", "chrome-relay-extension");

const requiredFiles = [
  "manifest.json",
  "background.js",
  "popup.html",
  "popup.js",
  "options.html",
  "options.js",
];

for (const relativePath of requiredFiles) {
  try {
    await stat(join(sourceDir, relativePath));
  } catch {
    throw new Error(`Chrome relay extension export failed: missing ${relativePath} in ${sourceDir}`);
  }
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(sourceDir, outputDir, { recursive: true });
await rm(join(outputDir, ".DS_Store"), { force: true });
await rm(join(outputDir, ".gitignore"), { force: true });

console.log(`Exported Chrome Relay extension to ${outputDir}`);
