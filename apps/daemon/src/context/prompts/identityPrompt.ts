import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getUserProfile } from "../../repositories/userProfileRepository";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Process-level caches for static .md files ---
let cachedIdentity: string | null = null;
let cachedSoul: string | null = null;
let cachedTools: string | null = null;
let cachedHeartbeat: string | null = null;
let cachedHumor: string | null = null;

function readCached(cache: { value: string | null }, filename: string): string {
  if (cache.value) return cache.value;
  cache.value = readFileSync(join(__dirname, filename), "utf-8");
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

function readMemoryMd(): string | null {
  const p = join(__dirname, "MEMORY.md");
  if (!existsSync(p)) return null;
  const content = readFileSync(p, "utf-8").trim();
  if (!content || content.startsWith("<!--")) return null;
  return content;
}

function readDailyMemoryLogs(): string | null {
  const memoryDir = join(__dirname, "memory");
  if (!existsSync(memoryDir)) return null;

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const dates = [fmt(yesterday), fmt(today)];
  const blocks: string[] = [];

  for (const date of dates) {
    const p = join(memoryDir, `${date}.md`);
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8").trim();
      if (content) {
        blocks.push(`### ${date}\n${content}`);
      }
    }
  }

  return blocks.length > 0 ? `## Daily Logs\n\n${blocks.join("\n\n")}` : null;
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
 * Build the full persona prompt by concatenating all layers:
 * IDENTITY → SOUL → TOOLS → HEARTBEAT → USER → MEMORY → Daily Logs
 */
export function buildPersonaPrompt(): string {
  const blocks: string[] = [
    readIdentity(),
    readSoul(),
    readTools(),
    readHeartbeat(),
    // HUMOR 不默认加载，需要时通过 buildPersonaPromptWithHumor() 加载
  ];

  const userBlock = buildUserBlock();
  if (userBlock) blocks.push(userBlock);

  const memoryBlock = readMemoryMd();
  if (memoryBlock) blocks.push(memoryBlock);

  const dailyLogs = readDailyMemoryLogs();
  if (dailyLogs) blocks.push(dailyLogs);

  return blocks.filter(Boolean).join("\n\n");
}

/** @deprecated Use buildPersonaPrompt() instead */
export function buildIdentityPrompt(): string {
  return buildPersonaPrompt();
}
