import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedIdentity: string | null = null;

export function buildIdentityPrompt(): string {
  if (cachedIdentity) {
    return cachedIdentity;
  }

  cachedIdentity = readFileSync(join(__dirname, "identity.md"), "utf-8");
  return cachedIdentity;
}
