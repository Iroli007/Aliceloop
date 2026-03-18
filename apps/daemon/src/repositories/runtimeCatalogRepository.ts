import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  McpServerDefinition,
  RuntimeCatalogSnapshot,
  RuntimeScriptDefinition,
  SkillDefinition,
} from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";
import { listProviderConfigs } from "./providerRepository";
import { listSandboxRuns } from "./sandboxRunRepository";
import { getRuntimePresence } from "./sessionRepository";
import { getQueuedSessionCount } from "../services/sessionRunQueue";

const currentDir = dirname(fileURLToPath(import.meta.url));

function resolveExistingPath(candidates: string[]) {
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const runtimeScriptsDir = resolveExistingPath([
  resolve(currentDir, "../../runtime-scripts"),
  resolve(currentDir, "../runtime-scripts"),
]);
const daemonRoot = dirname(runtimeScriptsDir);
const workspaceRoot = resolve(daemonRoot, "../..");
const tsxCliPath = resolve(workspaceRoot, "node_modules/tsx/dist/cli.mjs");
const projectSkillsDir = resolve(workspaceRoot, "skills");

const mcpServers: McpServerDefinition[] = [
  {
    id: "filesystem-bridge",
    label: "Filesystem Bridge",
    transport: "builtin",
    status: "planned",
    capabilities: ["read", "write", "edit"],
  },
  {
    id: "task-center-bridge",
    label: "Task Center Bridge",
    transport: "builtin",
    status: "planned",
    capabilities: ["tasks", "jobs", "artifacts"],
  },
];

interface StoredRuntimeScriptDefinition extends RuntimeScriptDefinition {
  entryPath: string;
  defaultCwd: string;
  launchCommand: string;
  launchArgsPrefix: string[];
}

interface SkillFrontmatter {
  name?: string;
  label?: string;
  description?: string;
  status?: SkillDefinition["status"];
  taskType?: SkillDefinition["taskType"];
  usesSandbox?: string;
  runtimeScriptId?: string;
}

const runtimeScripts: StoredRuntimeScriptDefinition[] = [
  {
    id: "runtime-overview",
    label: "runtime-overview",
    description: "输出当前 runtime 的工作目录、数据目录和传入参数摘要。",
    runtime: "node-ts",
    status: "available",
    usesSandbox: true,
    defaultArgs: [],
    entryPath: join(runtimeScriptsDir, "runtime-overview.ts"),
    defaultCwd: workspaceRoot,
    launchCommand: "node",
    launchArgsPrefix: [tsxCliPath],
  },
  {
    id: "data-dir-scan",
    label: "data-dir-scan",
    description: "列出当前 data 目录下的一级文件与目录，方便快速诊断本地状态。",
    runtime: "node-ts",
    status: "available",
    usesSandbox: true,
    defaultArgs: [],
    entryPath: join(runtimeScriptsDir, "data-dir-scan.ts"),
    defaultCwd: workspaceRoot,
    launchCommand: "node",
    launchArgsPrefix: [tsxCliPath],
  },
];

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {};
  }

  const result: SkillFrontmatter = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      break;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, rawKey, rawValue] = match;
    const key = rawKey as keyof SkillFrontmatter;
    result[key] = rawValue.trim() as never;
  }

  return result;
}

function coerceBoolean(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function normalizeRuntimeScriptId(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function readProjectSkills() {
  if (!existsSync(projectSkillsDir)) {
    return [] satisfies SkillDefinition[];
  }

  return readdirSync(projectSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillPath = join(projectSkillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) {
        return null;
      }

      const source = readFileSync(skillPath, "utf8");
      const frontmatter = parseSkillFrontmatter(source);
      if (!frontmatter.name || !frontmatter.description) {
        return null;
      }

      return {
        id: frontmatter.name,
        label: frontmatter.label?.trim() || frontmatter.name,
        description: frontmatter.description,
        status: frontmatter.status === "planned" ? "planned" : "available",
        taskType: frontmatter.taskType ?? null,
        usesSandbox: coerceBoolean(frontmatter.usesSandbox),
        runtimeScriptId: normalizeRuntimeScriptId(frontmatter.runtimeScriptId),
      } satisfies SkillDefinition;
    })
    .filter((skill): skill is SkillDefinition => Boolean(skill))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function listSkillDefinitions() {
  return readProjectSkills();
}

export function getSkillDefinition(skillId: string) {
  return listSkillDefinitions().find((skill) => skill.id === skillId) ?? null;
}

export function listMcpServerDefinitions() {
  return [...mcpServers];
}

export function getMcpServerDefinition(serverId: string) {
  return mcpServers.find((server) => server.id === serverId) ?? null;
}

function toPublicRuntimeScript(script: StoredRuntimeScriptDefinition): RuntimeScriptDefinition {
  return {
    id: script.id,
    label: script.label,
    description: script.description,
    runtime: script.runtime,
    status: script.status,
    usesSandbox: script.usesSandbox,
    defaultArgs: [...script.defaultArgs],
  };
}

export function listRuntimeScriptDefinitions() {
  return runtimeScripts.map(toPublicRuntimeScript);
}

export function getRuntimeScriptDefinition(scriptId: string) {
  const script = runtimeScripts.find((item) => item.id === scriptId);
  return script ? toPublicRuntimeScript(script) : null;
}

export function getStoredRuntimeScriptDefinition(scriptId: string) {
  return runtimeScripts.find((item) => item.id === scriptId) ?? null;
}

function countRows(tableName: string) {
  const db = getDatabase();
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

export function getRuntimeCatalogSnapshot(limit = 10): RuntimeCatalogSnapshot {
  return {
    runtimePresence: getRuntimePresence(),
    queue: {
      queuedSessionCount: getQueuedSessionCount(),
    },
    stats: {
      sessionCount: countRows("sessions"),
      messageCount: countRows("session_messages"),
      libraryItemCount: countRows("library_items"),
      artifactCount: countRows("study_artifacts"),
      taskRunCount: countRows("task_runs"),
      memoryCount: countRows("memory_notes"),
      sandboxRunCount: countRows("sandbox_runs"),
    },
    providers: listProviderConfigs(),
    skills: listSkillDefinitions(),
    scripts: listRuntimeScriptDefinitions(),
    mcpServers: listMcpServerDefinitions(),
    recentSandboxRuns: listSandboxRuns(limit),
  };
}
