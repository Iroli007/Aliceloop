import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillDefinition, SkillMode, SkillStatus } from "@aliceloop/runtime-core";
import {
  type SkillRouteHints,
  expandRoutedSkillIds,
  getSkillGroupIdsForSkill,
  getSkillGroupLabel,
  isRelevantSkillForTurn,
} from "./skillRouting";

const currentDir = dirname(fileURLToPath(import.meta.url));

function hasSkillMarkdown(candidate: string) {
  if (!existsSync(candidate)) {
    return false;
  }

  return readdirSync(candidate, { withFileTypes: true }).some((entry) => {
    return entry.isDirectory() && existsSync(join(candidate, entry.name, "SKILL.md"));
  });
}

const skillsRootDir = [
  currentDir,
  resolve(currentDir, "../src/context/skills"),
  resolve(process.cwd(), "src/context/skills"),
  resolve(process.cwd(), "apps/daemon/src/context/skills"),
].find(hasSkillMarkdown) ?? currentDir;

type FrontmatterValue = string | string[];

interface ParsedFrontmatter {
  name?: string;
  label?: string;
  description?: string;
  status?: string;
  mode?: string;
  sourceUrl?: string;
  allowedTools?: string[];
}

interface SkillCatalogCacheState {
  fingerprint: string;
  definitions: SkillDefinition[];
  activeDefinitions: SkillDefinition[];
  byId: Map<string, SkillDefinition>;
}

let skillCatalogCache: SkillCatalogCacheState | null = null;

class SkillFrontmatterError extends Error {
  constructor(sourcePath: string, message: string) {
    super(`Invalid skill frontmatter in ${sourcePath}: ${message}`);
    this.name = "SkillFrontmatterError";
  }
}

function normalizeKey(rawKey: string) {
  return rawKey.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function normalizeScalar(rawValue: string) {
  const value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseSkillFrontmatter(source: string, sourcePath: string): ParsedFrontmatter {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new SkillFrontmatterError(sourcePath, "missing opening YAML frontmatter delimiter");
  }

  const result: Record<string, FrontmatterValue> = {};
  const keyLines = new Map<string, number>();
  let activeListKey: string | null = null;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      return {
        name: typeof result.name === "string" ? result.name : undefined,
        label: typeof result.label === "string" ? result.label : undefined,
        description: typeof result.description === "string" ? result.description : undefined,
        status: typeof result.status === "string" ? result.status : undefined,
        mode: typeof result.mode === "string" ? result.mode : undefined,
        sourceUrl: typeof result.sourceUrl === "string" ? result.sourceUrl : undefined,
        allowedTools: Array.isArray(result.allowedTools) ? result.allowedTools : [],
      };
    }

    const listItemMatch = line.match(/^\s*-\s*(.+)$/);
    if (listItemMatch && activeListKey) {
      const current = result[activeListKey];
      if (Array.isArray(current)) {
        current.push(normalizeScalar(listItemMatch[1]));
      }
      continue;
    }

    const keyValueMatch = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!keyValueMatch) {
      activeListKey = null;
      continue;
    }

    const [, rawKey, rawValue] = keyValueMatch;
    const key = normalizeKey(rawKey);
    const value = rawValue.trim();
    const lineNumber = index + 1;

    if (key === "tools") {
      throw new SkillFrontmatterError(
        sourcePath,
        `line ${lineNumber} uses deprecated frontmatter key "${rawKey}". Use "allowed-tools" instead.`,
      );
    }

    if (keyLines.has(key)) {
      throw new SkillFrontmatterError(
        sourcePath,
        `frontmatter key "${rawKey}" is repeated on lines ${keyLines.get(key)} and ${lineNumber}`,
      );
    }
    keyLines.set(key, lineNumber);

    if (!value) {
      result[key] = [];
      activeListKey = key;
      continue;
    }

    result[key] = normalizeScalar(value);
    activeListKey = null;
  }

  throw new SkillFrontmatterError(sourcePath, "missing closing YAML frontmatter delimiter");
}

function normalizeStatus(value: string | undefined, sourcePath: string): SkillStatus {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "available") {
    return "available";
  }

  if (normalized === "planned") {
    return "planned";
  }

  throw new SkillFrontmatterError(sourcePath, `unsupported status "${value}"`);
}

function normalizeMode(value: string | undefined, sourcePath: string): SkillMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "instructional") {
    return "instructional";
  }

  if (normalized === "task") {
    return "task";
  }

  throw new SkillFrontmatterError(sourcePath, `unsupported mode "${value}"`);
}

function readSkillDefinition(directoryName: string) {
  const sourcePath = join(skillsRootDir, directoryName, "SKILL.md");
  if (!existsSync(sourcePath)) {
    return null;
  }

  const source = readFileSync(sourcePath, "utf8");
  const frontmatter = parseSkillFrontmatter(source, sourcePath);

  const missingFields = ["name", "description"].filter((field) => {
    return typeof frontmatter[field as keyof ParsedFrontmatter] !== "string";
  });
  if (missingFields.length > 0) {
    throw new SkillFrontmatterError(
      sourcePath,
      `missing required frontmatter key${missingFields.length > 1 ? "s" : ""}: ${missingFields.join(", ")}`,
    );
  }

  for (const toolName of frontmatter.allowedTools ?? []) {
    const trimmedToolName = toolName.trim();
    if (!trimmedToolName) {
      throw new SkillFrontmatterError(sourcePath, "allowed-tools entries must not be empty");
    }
    if (trimmedToolName !== toolName) {
      throw new SkillFrontmatterError(
        sourcePath,
        `allowed-tools entry "${toolName}" must not contain surrounding whitespace`,
      );
    }
  }

  const name = frontmatter.name as string;
  const description = frontmatter.description as string;

  return {
    id: name,
    label: frontmatter.label?.trim() || name,
    description,
    status: normalizeStatus(frontmatter.status, sourcePath),
    mode: normalizeMode(frontmatter.mode, sourcePath),
    sourcePath,
    sourceUrl: frontmatter.sourceUrl?.trim() || null,
    allowedTools: frontmatter.allowedTools ?? [],
  } satisfies SkillDefinition;
}

function listSkillDirectoryNames() {
  return readdirSync(skillsRootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function buildSkillCatalogFingerprint(directoryNames: string[]) {
  return directoryNames
    .map((directoryName) => {
      const sourcePath = join(skillsRootDir, directoryName, "SKILL.md");
      if (!existsSync(sourcePath)) {
        return `${directoryName}:missing`;
      }

      return `${directoryName}:${statSync(sourcePath).mtimeMs}`;
    })
    .join("|");
}

function getSkillCatalogCache() {
  const directoryNames = listSkillDirectoryNames();
  const fingerprint = buildSkillCatalogFingerprint(directoryNames);
  if (skillCatalogCache?.fingerprint === fingerprint) {
    return skillCatalogCache;
  }

  const definitions = directoryNames
    .map((directoryName) => readSkillDefinition(directoryName))
    .filter((skill): skill is SkillDefinition => Boolean(skill))
    .sort((left, right) => left.id.localeCompare(right.id));
  const activeDefinitions = definitions.filter((skill) => skill.status === "available");

  skillCatalogCache = {
    fingerprint,
    definitions,
    activeDefinitions,
    byId: new Map(definitions.map((skill) => [skill.id, skill])),
  };

  return skillCatalogCache;
}

export function listSkillDefinitions() {
  return getSkillCatalogCache().definitions;
}

export function listActiveSkillDefinitions() {
  return getSkillCatalogCache().activeDefinitions;
}

export function selectRelevantSkillDefinitions(query: string | null | undefined, hints?: SkillRouteHints) {
  const normalizedQuery = query?.trim() ?? "";
  if (
    !normalizedQuery
    && (hints?.stickySkillIds.length ?? 0) === 0
    && (hints?.stickyGroupIds.length ?? 0) === 0
  ) {
    return [] as SkillDefinition[];
  }

  const activeSkills = listActiveSkillDefinitions();
  const directlyRelevantSkillIds = activeSkills
    .filter((skill) => isRelevantSkillForTurn(skill, normalizedQuery, hints))
    .map((skill) => skill.id);
  const expanded = expandRoutedSkillIds(directlyRelevantSkillIds, normalizedQuery, hints);
  const routedSkillIds = new Set(expanded.routedSkillIds);

  return activeSkills.filter((skill) => routedSkillIds.has(skill.id));
}

export function getSkillDefinition(skillId: string) {
  return getSkillCatalogCache().byId.get(skillId) ?? null;
}

export function resetSkillCatalogCache() {
  skillCatalogCache = null;
}

interface BuildSkillContextBlockOptions {
  browserRelayAvailable?: boolean;
  routeHints?: SkillRouteHints;
}

export function buildSkillContextBlock(skills: SkillDefinition[], options?: BuildSkillContextBlockOptions) {
  if (skills.length === 0) {
    return [
      "Skill routing rule: the six sandbox primitives (Bash/Read/Write/Edit/Glob/Grep) are the always-on native tools.",
      "Bash can invoke unlimited scripts = unlimited capabilities. Skills封装这些能力。",
      "Skill routing policy: preserve high availability by keeping relevant capability groups sticky across short follow-up turns, but never load the whole skill catalog by default.",
      "No extra skill was routed for this turn, so do not assume any non-primitive tool should be present.",
    ].join("\n");
  }

  const sections = [
    "Project skills live in the local context catalog.",
    `Skill catalog root: ${skillsRootDir}`,
    "Architecture rule: the six sandbox primitives (Bash/Read/Write/Edit/Glob/Grep) are the always-on native tools; skills are routed capabilities.",
    "Bash can invoke unlimited scripts = unlimited capabilities. Skills封装这些能力。",
    "If a turn needs better capability coverage, improve skill routing accuracy instead of expanding the primitive tool base.",
    "Routing policy: keep the current capability groups sticky across short continuation turns so the agent does not drop critical skills mid-workflow, but do not load the entire skill catalog.",
    "The skills below were routed as relevant for this turn. Read their SKILL.md files before acting when needed.",
    "",
    "Routed skills for this turn:",
  ];

  const routedSkillIds = new Set(skills.map((skill) => skill.id));
  const routedGroupIds = [...new Set(skills.flatMap((skill) => getSkillGroupIdsForSkill(skill.id)))];
  if ((options?.routeHints?.stickyGroupIds.length ?? 0) > 0) {
    const labels = options?.routeHints?.stickyGroupIds.map((groupId) => getSkillGroupLabel(groupId)).join(", ");
    sections.push(`- Sticky capability groups for this turn: ${labels}.`);
  }
  if ((options?.routeHints?.stickySkillIds.length ?? 0) > 0) {
    sections.push(`- Sticky skill carry-forward for this turn: ${options?.routeHints?.stickySkillIds.join(", ")}.`);
  }
  if (routedGroupIds.length > 0) {
    sections.push(`- Active capability groups for this turn: ${routedGroupIds.map((groupId) => getSkillGroupLabel(groupId)).join(", ")}.`);
  }
  if (routedSkillIds.has("web-search") || routedSkillIds.has("web-fetch")) {
    sections.push("- Routing priority: when the user needs exact factual verification, current metrics, dates, or source-backed corrections, treat `web_search` as the default first step and only route `web_fetch` when a specific page still needs to be read.");
    sections.push("- Source priority: primary platform pages and clearly dated sources come before encyclopedia overviews; 百度百科 is extremely low priority for live facts.");
    sections.push("- Research memory rule: keep a running evidence ledger. Search results are discovery only, and the next `web_fetch` should target the strongest unfetched candidate URL from the ledger instead of restarting the topic from scratch.");
  }
  if (routedSkillIds.has("system-info")) {
    sections.push("- Routing priority: when the user needs the current local time, date, weekday, or host diagnostics, treat `system-info` as the first step. It can call `bash` commands such as `date`, `sw_vers`, `df -h`, or `uptime`.");
  }

  if (routedSkillIds.has("browser")) {
    if (options?.browserRelayAvailable) {
      sections.push("- Browser runtime status for this turn: a healthy visible Aliceloop Desktop Chrome relay is available right now.");
      sections.push("- Do not claim that browser automation is headless, stateless, or unable to retain login data when using this relay. Use the visible Chrome path and reuse its persistent login session.");
    } else {
      sections.push("- Browser runtime status for this turn: no healthy desktop relay is currently registered, so browser automation will fall back to local Playwright.");
    }
  }

  for (const skill of skills) {
    const relativeSourcePath = relative(skillsRootDir, skill.sourcePath).replace(/\\/g, "/");
    sections.push(`- ${skill.label}: ${skill.description} [${relativeSourcePath}]`);
  }

  return sections.join("\n");
}
