import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getUserProfile } from "../../repositories/userProfileRepository";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolvePromptRoot() {
  const candidates = [
    __dirname,
    resolve(__dirname, "../src/context/prompts"),
    resolve(process.cwd(), "src/context/prompts"),
    resolve(process.cwd(), "apps/daemon/src/context/prompts"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "IDENTITY.md"))) {
      return candidate;
    }
  }

  return __dirname;
}

const promptRootDir = resolvePromptRoot();

// --- Process-level caches for static .md files ---
let cachedIdentity: string | null = null;
let cachedSoul: string | null = null;
let cachedTools: string | null = null;
let cachedHeartbeat: string | null = null;
let cachedHumor: string | null = null;

function readCached(cache: { value: string | null }, filename: string): string {
  if (cache.value) return cache.value;
  cache.value = readFileSync(join(promptRootDir, filename), "utf-8");
  return cache.value;
}

const identityCache = { value: null as string | null };
const soulCache = { value: null as string | null };
const toolsCache = { value: null as string | null };
const heartbeatCache = { value: null as string | null };
const humorCache = { value: null as string | null };

function readIdentity(): string {
  return readCached(identityCache, "IDENTITY.md");
}

function readSoul(): string {
  return readCached(soulCache, "SOUL.md");
}

function readTools(): string {
  return readCached(toolsCache, "TOOLS.md");
}

function readHeartbeat(): string {
  return readCached(heartbeatCache, "HEARTBEAT.md");
}

function readHumor(): string {
  return readCached(humorCache, "HUMOR.md");
}

function buildUserBlock(): string | null {
  const profile = getUserProfile();
  const lines: string[] = [];

  if (profile.displayName) lines.push(`- **Name**: ${profile.displayName}`);
  if (profile.preferredLanguage) lines.push(`- **Language**: ${profile.preferredLanguage}`);
  if (profile.timezone) lines.push(`- **Timezone**: ${profile.timezone}`);
  if (profile.codeStyle) lines.push(`- **Code Style**: ${profile.codeStyle}`);
  if (profile.notes) lines.push(`- **Notes**: ${profile.notes}`);

  if (lines.length === 0) return null;

  return `## User Profile\n\n${lines.join("\n")}`;
}

/**
 * Build the full persona prompt as system messages with cache control.
 * Static parts (IDENTITY, SOUL, TOOLS, HEARTBEAT) are marked for caching.
 * Dynamic parts (USER) are not cached.
 */
export function buildPersonaPrompt(): Array<{ role: "system"; content: string; providerOptions?: { anthropic?: { cacheControl?: { type: "ephemeral" } } } }> {
  const staticContent = [
    readIdentity(),
    readSoul(),
    readHumor(),
    readTools(),
    readHeartbeat(),
  ].filter(Boolean).join("\n\n");

  const messages: Array<{ role: "system"; content: string; providerOptions?: { anthropic?: { cacheControl?: { type: "ephemeral" } } } }> = [
    {
      role: "system",
      content: staticContent,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } }
      }
    }
  ];

  const dynamicBlocks: string[] = [];
  const userBlock = buildUserBlock();
  if (userBlock) dynamicBlocks.push(userBlock);

  if (dynamicBlocks.length > 0) {
    messages.push({
      role: "system",
      content: dynamicBlocks.join("\n\n")
    });
  }

  return messages;
}

/** @deprecated Use buildPersonaPrompt() instead */
export function buildIdentityPrompt(): string {
  const messages = buildPersonaPrompt();
  return messages.map(m => m.content).join("\n\n");
}
