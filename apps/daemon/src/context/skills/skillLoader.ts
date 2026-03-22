import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillDefinition, SkillMode, SkillStatus } from "@aliceloop/runtime-core";

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

export function listSkillDefinitions() {
  return readdirSync(skillsRootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSkillDefinition(entry.name))
    .filter((skill): skill is SkillDefinition => Boolean(skill))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function listActiveSkillDefinitions() {
  return listSkillDefinitions().filter((skill) => skill.status === "available");
}

export function getSkillDefinition(skillId: string) {
  return listSkillDefinitions().find((skill) => skill.id === skillId) ?? null;
}

let cachedSkillContextBlock: string | null = null;

export function buildSkillContextBlock() {
  if (cachedSkillContextBlock !== null) {
    return cachedSkillContextBlock;
  }

  const skills = listActiveSkillDefinitions();
  if (skills.length === 0) {
    cachedSkillContextBlock = "";
    return "";
  }

  const sections = [
    "Project skills live in the local context catalog.",
    `Skill catalog root: ${skillsRootDir}`,
    "When a skill clearly matches the user's request, read that SKILL.md before acting.",
    "Only the skills below are currently available.",
    "",
    "Available skills:",
  ];

  for (const skill of skills) {
    const relativeSourcePath = relative(skillsRootDir, skill.sourcePath).replace(/\\/g, "/");
    sections.push(`- ${skill.label}: ${skill.description} [${relativeSourcePath}]`);
  }

  cachedSkillContextBlock = sections.join("\n");
  return cachedSkillContextBlock;
}
