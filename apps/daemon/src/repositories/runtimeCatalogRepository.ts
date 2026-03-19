import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  McpServerDefinition,
  RuntimeCatalogSnapshot,
  RuntimeScriptDefinition,
} from "@aliceloop/runtime-core";
import { getSkillDefinition, listSkillDefinitions } from "../context/skills/skillLoader";
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

export function listMcpServerDefinitions() {
  return [...mcpServers];
}

export { getSkillDefinition, listSkillDefinitions };

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
