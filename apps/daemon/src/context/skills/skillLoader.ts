import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

const skillsRootDir = [currentDir, resolve(currentDir, "../../src/context/skills")].find(hasSkillMarkdown) ?? currentDir;

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

function parseSkillFrontmatter(source: string): ParsedFrontmatter {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {};
  }

  const result: Record<string, FrontmatterValue> = {};
  let activeListKey: string | null = null;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      break;
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

    if (!value) {
      result[key] = [];
      activeListKey = key;
      continue;
    }

    result[key] = normalizeScalar(value);
    activeListKey = null;
  }

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

function normalizeStatus(value: string | undefined): SkillStatus {
  return value?.trim().toLowerCase() === "planned" ? "planned" : "available";
}

function normalizeMode(value: string | undefined): SkillMode {
  return value?.trim().toLowerCase() === "task" ? "task" : "instructional";
}

function readSkillDefinition(directoryName: string) {
  const sourcePath = join(skillsRootDir, directoryName, "SKILL.md");
  if (!existsSync(sourcePath)) {
    return null;
  }

  const source = readFileSync(sourcePath, "utf8");
  const frontmatter = parseSkillFrontmatter(source);
  if (!frontmatter.name || !frontmatter.description) {
    return null;
  }

  return {
    id: frontmatter.name,
    label: frontmatter.label?.trim() || frontmatter.name,
    description: frontmatter.description,
    status: normalizeStatus(frontmatter.status),
    mode: normalizeMode(frontmatter.mode),
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

export function buildSkillContextBlock() {
  const skills = listSkillDefinitions();
  if (skills.length === 0) {
    return "";
  }

  const sections = [
    "Project skills live in the local context catalog.",
    "When a skill clearly matches the user's request, read that SKILL.md with read before acting.",
    "Do not pretend a planned skill is installed. Planned skills are architecture targets, not active runtime capabilities.",
    "",
    "Loaded skills:",
  ];

  for (const skill of skills) {
    sections.push(
      `- ${skill.label} [${skill.status} / ${skill.mode}]`,
      `  Description: ${skill.description}`,
      `  File: ${skill.sourcePath}`,
      `  Allowed tools: ${skill.allowedTools.length > 0 ? skill.allowedTools.join(", ") : "none listed"}`,
    );

    if (skill.sourceUrl) {
      sections.push(`  Source: ${skill.sourceUrl}`);
    }
  }

  return sections.join("\n");
}
