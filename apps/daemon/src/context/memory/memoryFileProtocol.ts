import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Memory } from "@aliceloop/runtime-core";
import { getDataDir } from "../../db/client";
import type { CuratedMemory, ExistingMemoryManifest } from "./memoryCuratorAgent";

interface AppliedMemoryAction {
  action: string;
  memoryId: string | null;
  targetMemoryId: string | null;
  title: string | null;
  filePath: string | null;
}

export interface TopicMemoryManifest extends ExistingMemoryManifest {
  filePath: string;
  factKind: Memory["factKind"];
  factKey: string | null;
  factState: Memory["factState"];
}

function getMemoryRoot() {
  return join(getDataDir(), "memory");
}

function getMemoryDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ensureMemoryDirs() {
  const root = getMemoryRoot();
  const topicsDir = join(root, "topics");
  const dailyDir = join(root, "daily");
  const dreamsDir = join(root, "dreams");
  mkdirSync(topicsDir, { recursive: true });
  mkdirSync(dailyDir, { recursive: true });
  mkdirSync(dreamsDir, { recursive: true });
  return {
    root,
    indexPath: join(root, "MEMORY.md"),
    topicsDir,
    dailyDir,
    dreamsDir,
  };
}

function compactInline(value: string, maxLength = 400) {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength).trimEnd()}...` : compacted;
}

function frontmatterValue(value: unknown) {
  return JSON.stringify(value);
}

function parseFrontmatterValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed.replace(/^['"]|['"]$/g, "");
  }
}

function parseFrontmatter(source: string) {
  if (!source.startsWith("---\n")) {
    return null;
  }

  const endIndex = source.indexOf("\n---", 4);
  if (endIndex === -1) {
    return null;
  }

  const values: Record<string, unknown> = {};
  for (const line of source.slice(4, endIndex).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    values[line.slice(0, separator).trim()] = parseFrontmatterValue(line.slice(separator + 1));
  }
  return values;
}

function stripFrontmatter(source: string) {
  if (!source.startsWith("---\n")) {
    return source;
  }

  const endIndex = source.indexOf("\n---", 4);
  if (endIndex === -1) {
    return source;
  }

  return source.slice(endIndex + 4).trim();
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableStringValue(value: unknown) {
  const text = stringValue(value).trim();
  return text ? text : null;
}

function parseMemoryType(value: unknown): Memory["memoryType"] | null {
  return value === "user" || value === "feedback" || value === "project" || value === "reference"
    ? value
    : null;
}

function parseFactKind(value: unknown): Memory["factKind"] {
  return value === "preference"
    || value === "constraint"
    || value === "decision"
    || value === "profile"
    || value === "account"
    || value === "workflow"
    || value === "other"
    ? value
    : null;
}

function parseFactState(value: unknown): Memory["factState"] {
  return value === "superseded" || value === "retracted" ? value : "active";
}

function normalizeComparable(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
}

function scoreTopicManifest(queryText: string, manifest: TopicMemoryManifest) {
  const query = normalizeComparable(queryText);
  if (!query) {
    return 0;
  }

  const haystack = normalizeComparable([
    manifest.memoryType,
    manifest.title,
    manifest.description,
    manifest.factKind ?? "",
    manifest.factKey ?? "",
  ].join(" "));
  if (!haystack) {
    return 0;
  }

  if (haystack.includes(query)) {
    return 20;
  }

  return query
    .split(/\s+/)
    .filter((term) => term.length > 1 && haystack.includes(term))
    .length;
}

function memoryTopicPath(memoryId: string) {
  return join(ensureMemoryDirs().topicsDir, `${memoryId}.md`);
}

function permanentMemories(memories: Memory[]) {
  return memories.filter((memory) => memory.durability === "permanent");
}

function activePermanentMemories(memories: Memory[]) {
  return permanentMemories(memories).filter((memory) => memory.factState === "active");
}

function archivedPermanentMemories(memories: Memory[]) {
  return permanentMemories(memories).filter((memory) => memory.factState !== "active");
}

function topicFileName(memoryId: string) {
  return `${memoryId}.md`;
}

function topicFileMatchesMemory(manifest: TopicMemoryManifest | null, memory: Memory) {
  return Boolean(manifest)
    && manifest?.id === memory.id
    && manifest.memoryType === memory.memoryType
    && manifest.title === memory.title
    && manifest.description === memory.description
    && manifest.updatedAt === memory.updatedAt
    && manifest.factState === memory.factState;
}

export function readMemoryTopicManifest(filePath: string): TopicMemoryManifest | null {
  try {
    const frontmatter = parseFrontmatter(readFileSync(filePath, "utf8"));
    if (!frontmatter) {
      return null;
    }

    const id = stringValue(frontmatter.id).trim();
    const memoryType = parseMemoryType(frontmatter.memoryType);
    const title = stringValue(frontmatter.title).trim();
    const description = stringValue(frontmatter.description).trim();
    const updatedAt = stringValue(frontmatter.updatedAt).trim();
    if (!id || !memoryType || !title || !description || !updatedAt) {
      return null;
    }

    return {
      id,
      memoryType,
      title,
      description,
      updatedAt,
      filePath,
      factKind: parseFactKind(frontmatter.factKind),
      factKey: nullableStringValue(frontmatter.factKey),
      factState: parseFactState(frontmatter.factState),
    };
  } catch {
    return null;
  }
}

export function readMemoryTopicFile(memoryId: string) {
  const filePath = memoryTopicPath(memoryId);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const source = readFileSync(filePath, "utf8");
    const manifest = readMemoryTopicManifest(filePath);
    if (!manifest) {
      return null;
    }

    return {
      ...manifest,
      content: stripFrontmatter(source).replace(/^# .+\n+/, "").trim(),
    };
  } catch {
    return null;
  }
}

export function listMemoryTopicManifests() {
  const paths = ensureMemoryDirs();
  if (!existsSync(paths.topicsDir)) {
    return [] as TopicMemoryManifest[];
  }

  return readdirSync(paths.topicsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => readMemoryTopicManifest(join(paths.topicsDir, entry.name)))
    .filter((manifest): manifest is TopicMemoryManifest => Boolean(manifest));
}

export function isMemoryFileProjectionCurrent(memories: Memory[]) {
  const paths = ensureMemoryDirs();
  if (!existsSync(paths.indexPath)) {
    return false;
  }

  let indexFrontmatter: Record<string, unknown> | null = null;
  try {
    indexFrontmatter = parseFrontmatter(readFileSync(paths.indexPath, "utf8"));
  } catch {
    return false;
  }
  if (!indexFrontmatter) {
    return false;
  }

  const allPermanent = permanentMemories(memories);
  const activeMemories = activePermanentMemories(memories);
  const archivedMemories = archivedPermanentMemories(memories);
  if (Number(indexFrontmatter.memoryCount) !== activeMemories.length) {
    return false;
  }
  if (Number(indexFrontmatter.archivedCount ?? 0) !== archivedMemories.length) {
    return false;
  }
  if (Number(indexFrontmatter.totalMemoryCount) !== allPermanent.length) {
    return false;
  }

  const indexUpdatedAt = Date.parse(stringValue(indexFrontmatter.updatedAt));
  if (!Number.isFinite(indexUpdatedAt)) {
    return false;
  }
  if (allPermanent.some((memory) => Date.parse(memory.updatedAt) > indexUpdatedAt)) {
    return false;
  }

  const expectedTopicFiles = new Set(allPermanent.map((memory) => topicFileName(memory.id)));
  for (const memory of allPermanent) {
    const path = join(paths.topicsDir, topicFileName(memory.id));
    if (!existsSync(path) || !topicFileMatchesMemory(readMemoryTopicManifest(path), memory)) {
      return false;
    }
  }

  for (const entry of readdirSync(paths.topicsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && !expectedTopicFiles.has(entry.name)) {
      return false;
    }
  }

  return true;
}

export function ensureMemoryFileProjection(memories: Memory[]) {
  const paths = ensureMemoryDirs();
  if (isMemoryFileProjectionCurrent(memories)) {
    return {
      rebuilt: false,
      indexPath: paths.indexPath,
      topicPaths: permanentMemories(memories).map((memory) => join(paths.topicsDir, topicFileName(memory.id))),
    };
  }

  return {
    rebuilt: true,
    ...syncMemoryFileProtocol(memories),
  };
}

export function findTopicMemoryManifests(queryText: string, limit = 8) {
  return listMemoryTopicManifests()
    .filter((manifest) => manifest.factState === "active")
    .map((manifest) => ({
      manifest,
      score: scoreTopicManifest(queryText, manifest),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.manifest.updatedAt.localeCompare(a.manifest.updatedAt))
    .slice(0, limit)
    .map((entry) => entry.manifest);
}

export function resolveTopicManifestTarget(input: {
  targetMemoryId?: string | null;
  title?: string | null;
  description?: string | null;
  factKind?: Memory["factKind"];
  factKey?: string | null;
}) {
  const manifests = listMemoryTopicManifests().filter((manifest) => manifest.factState === "active");
  const targetMemoryId = input.targetMemoryId?.trim();
  if (targetMemoryId && manifests.some((manifest) => manifest.id === targetMemoryId)) {
    return targetMemoryId;
  }

  const factKey = normalizeComparable(input.factKey);
  if (factKey) {
    const byFact = manifests.find((manifest) => {
      if (normalizeComparable(manifest.factKey) !== factKey) {
        return false;
      }
      return !input.factKind || manifest.factKind === input.factKind;
    });
    if (byFact) {
      return byFact.id;
    }
  }

  const title = normalizeComparable(input.title);
  if (title) {
    const byTitle = manifests.find((manifest) => normalizeComparable(manifest.title) === title);
    if (byTitle) {
      return byTitle.id;
    }
  }

  const description = normalizeComparable(input.description);
  if (title && description) {
    const byTitleAndDescription = manifests.find((manifest) => {
      return normalizeComparable(manifest.title) === title
        && normalizeComparable(manifest.description) === description;
    });
    if (byTitleAndDescription) {
      return byTitleAndDescription.id;
    }
  }

  return null;
}

export function writeMemoryTopicFile(memory: Memory) {
  const path = memoryTopicPath(memory.id);
  const lines = [
    "---",
    `id: ${frontmatterValue(memory.id)}`,
    `memoryType: ${frontmatterValue(memory.memoryType)}`,
    `title: ${frontmatterValue(memory.title)}`,
    `description: ${frontmatterValue(memory.description)}`,
    `durability: ${frontmatterValue(memory.durability)}`,
    `factKind: ${frontmatterValue(memory.factKind)}`,
    `factKey: ${frontmatterValue(memory.factKey)}`,
    `factState: ${frontmatterValue(memory.factState)}`,
    `createdAt: ${frontmatterValue(memory.createdAt)}`,
    `updatedAt: ${frontmatterValue(memory.updatedAt)}`,
    `accessCount: ${memory.accessCount}`,
    `relatedTopics: ${frontmatterValue(memory.relatedTopics)}`,
    "---",
    "",
    `# ${memory.title}`,
    "",
    memory.content.trim(),
    "",
  ];
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

export function syncMemoryFileProtocol(memories: Memory[]) {
  const paths = ensureMemoryDirs();
  const allPermanent = permanentMemories(memories);
  const activeMemories = activePermanentMemories(memories);
  const archivedMemories = archivedPermanentMemories(memories);
  const topicPaths = allPermanent.map(writeMemoryTopicFile);
  const expectedTopicFiles = new Set(allPermanent.map((memory) => topicFileName(memory.id)));
  for (const entry of readdirSync(paths.topicsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && !expectedTopicFiles.has(entry.name)) {
      unlinkSync(join(paths.topicsDir, entry.name));
    }
  }

  const lines = [
    "---",
    `updatedAt: ${frontmatterValue(new Date().toISOString())}`,
    `memoryCount: ${activeMemories.length}`,
    `archivedCount: ${archivedMemories.length}`,
    `totalMemoryCount: ${allPermanent.length}`,
    "---",
    "",
    "# MEMORY",
    "",
    "This is the long-term memory index. Read this manifest first, then open topic files only when full content is needed.",
    "",
    "## Active Memories",
    "",
  ];

  if (activeMemories.length === 0) {
    lines.push("(none)");
    lines.push("");
  } else {
    for (const memory of activeMemories) {
      lines.push(`### ${memory.title}`);
      lines.push(`- id: ${memory.id}`);
      lines.push(`- type: ${memory.memoryType}`);
      lines.push(`- description: ${memory.description}`);
      lines.push(`- file: topics/${memory.id}.md`);
      lines.push(`- updatedAt: ${memory.updatedAt}`);
      lines.push("");
    }
  }

  lines.push("## Archived Memories");
  lines.push("");
  lines.push("These records are retained for audit only. Do not retrieve them as active context.");
  lines.push("");
  if (archivedMemories.length === 0) {
    lines.push("(none)");
    lines.push("");
  } else {
    for (const memory of archivedMemories) {
      lines.push(`### ${memory.title}`);
      lines.push(`- id: ${memory.id}`);
      lines.push(`- state: ${memory.factState}`);
      lines.push(`- type: ${memory.memoryType}`);
      lines.push(`- description: ${memory.description}`);
      lines.push(`- file: topics/${memory.id}.md`);
      lines.push(`- updatedAt: ${memory.updatedAt}`);
      lines.push("");
    }
  }

  writeFileSync(paths.indexPath, lines.join("\n"), "utf8");
  return {
    indexPath: paths.indexPath,
    topicPaths,
  };
}

export function appendMemoryDailyLog(input: {
  sessionId: string;
  userMessage: string;
  assistantText: string;
  tokenEstimate: number;
  completedToolCallCount: number;
}) {
  const paths = ensureMemoryDirs();
  const logPath = join(paths.dailyDir, `${getMemoryDateKey()}.md`);
  const lines = [
    `## ${new Date().toISOString()}`,
    `- sessionId: ${input.sessionId}`,
    `- tokenEstimate: ${input.tokenEstimate}`,
    `- completedToolCallCount: ${input.completedToolCallCount}`,
    `- user: ${compactInline(input.userMessage, 600)}`,
    `- assistant: ${compactInline(input.assistantText, 900)}`,
    "",
  ];
  appendFileSync(logPath, lines.join("\n"), "utf8");
  return logPath;
}

export function writeMemoryDailyDreamRollup(input: {
  sessionId: string;
  dailyLogPath: string;
  topicManifests: TopicMemoryManifest[];
  indexPath: string | null;
}) {
  const paths = ensureMemoryDirs();
  const dayDir = join(paths.dreamsDir, getMemoryDateKey());
  mkdirSync(dayDir, { recursive: true });
  const rollupPath = join(dayDir, "daily-rollup.md");
  const dailyLog = existsSync(input.dailyLogPath) ? readFileSync(input.dailyLogPath, "utf8") : "";
  const recentLog = dailyLog.split("\n").slice(-80).join("\n").trim();
  const activeManifests = input.topicManifests
    .filter((manifest) => manifest.factState === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20);
  const lines = [
    "---",
    `date: ${frontmatterValue(getMemoryDateKey())}`,
    `sessionId: ${frontmatterValue(input.sessionId)}`,
    `updatedAt: ${frontmatterValue(new Date().toISOString())}`,
    `memoryCount: ${activeManifests.length}`,
    "---",
    "",
    "# Daily Memory Dream",
    "",
    `- dailyLog: ${input.dailyLogPath}`,
    `- indexPath: ${input.indexPath ?? join(paths.root, "MEMORY.md")}`,
    "",
    "## Active Topic Manifests",
    activeManifests.length > 0
      ? activeManifests.map((manifest) => [
          `- id: ${manifest.id}`,
          `  type: ${manifest.memoryType}`,
          `  title: ${manifest.title}`,
          `  description: ${manifest.description}`,
          `  file: ${manifest.filePath}`,
          `  updatedAt: ${manifest.updatedAt}`,
        ].join("\n")).join("\n")
      : "(none)",
    "",
    "## Recent Daily Log",
    recentLog || "(none)",
    "",
  ];
  writeFileSync(rollupPath, lines.join("\n"), "utf8");
  return rollupPath;
}

export function writeMemoryDreamTrace(input: {
  traceId: string;
  sessionId: string;
  subagentType: string;
  persona: string;
  dailyLogPath: string;
  existingMemoryManifests: ExistingMemoryManifest[];
  curatedMemories: CuratedMemory[];
  appliedActions: AppliedMemoryAction[];
  indexPath: string | null;
  topicPaths: string[];
  dailyDreamRollupPath: string | null;
  sessionMemoryUpdateReason: string;
}) {
  const paths = ensureMemoryDirs();
  const dayDir = join(paths.dreamsDir, getMemoryDateKey());
  mkdirSync(dayDir, { recursive: true });
  const tracePath = join(dayDir, `${input.traceId}.md`);
  const lines = [
    "---",
    `traceId: ${frontmatterValue(input.traceId)}`,
    `sessionId: ${frontmatterValue(input.sessionId)}`,
    `subagentType: ${frontmatterValue(input.subagentType)}`,
    `persona: ${frontmatterValue(input.persona)}`,
    `createdAt: ${frontmatterValue(new Date().toISOString())}`,
    "---",
    "",
    "# Memory Dream Trace",
    "",
    `- dailyLog: ${input.dailyLogPath}`,
    `- indexPath: ${input.indexPath ?? "(none)"}`,
    `- dailyDreamRollup: ${input.dailyDreamRollupPath ?? "(none)"}`,
    `- sessionMemoryUpdateReason: ${input.sessionMemoryUpdateReason}`,
    "",
    "## Existing Manifests",
    input.existingMemoryManifests.length > 0
      ? input.existingMemoryManifests.map((memory) => [
          `- id: ${memory.id}`,
          `  type: ${memory.memoryType}`,
          `  title: ${memory.title}`,
          `  description: ${memory.description}`,
          `  updatedAt: ${memory.updatedAt}`,
        ].join("\n")).join("\n")
      : "(none)",
    "",
    "## Proposed Actions",
    input.curatedMemories.length > 0
      ? input.curatedMemories.map((memory) => [
          `- action: ${memory.action}`,
          `  targetMemoryId: ${memory.targetMemoryId ?? "(none)"}`,
          `  durability: ${memory.durability}`,
          `  type: ${memory.memoryType ?? "(none)"}`,
          `  title: ${memory.title ?? "(none)"}`,
          `  description: ${memory.description ?? "(none)"}`,
          `  content: ${compactInline(memory.content, 900)}`,
        ].join("\n")).join("\n")
      : "(none)",
    "",
    "## Applied Actions",
    input.appliedActions.length > 0
      ? input.appliedActions.map((action) => [
          `- action: ${action.action}`,
          `  memoryId: ${action.memoryId ?? "(none)"}`,
          `  targetMemoryId: ${action.targetMemoryId ?? "(none)"}`,
          `  title: ${action.title ?? "(none)"}`,
          `  filePath: ${action.filePath ?? "(none)"}`,
        ].join("\n")).join("\n")
      : "(none)",
    "",
    "## Topic Files",
    input.topicPaths.length > 0 ? input.topicPaths.map((path) => `- ${path}`).join("\n") : "(none)",
    "",
  ];
  writeFileSync(tracePath, lines.join("\n"), "utf8");
  return tracePath;
}
