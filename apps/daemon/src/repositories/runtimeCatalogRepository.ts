import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RuntimeCatalogSnapshot,
  RuntimeScriptDefinition,
} from "@aliceloop/runtime-core";
import { getSkillDefinition, listActiveSkillDefinitions, listSkillDefinitions } from "../context/skills/skillLoader";
import { getDatabase } from "../db/client";
import { listMcpServerDefinitions } from "./mcpServerRepository";
import { listProviderConfigs } from "./providerRepository";
import { listSandboxRuns } from "./sandboxRunRepository";
import { getRuntimePresence } from "./sessionRepository";
import { getQueuedSessionCount } from "../services/sessionRunQueue";

const currentDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function resolveExistingPath(candidates: Array<string | undefined>, fallbackPath: string) {
  return candidates.find((candidate): candidate is string => {
    if (!candidate) {
      return false;
    }

    return existsSync(candidate);
  })
    ?? candidates.find((candidate): candidate is string => Boolean(candidate))
    ?? fallbackPath;
}

const runtimeScriptsDir = resolveExistingPath([
  process.env.ALICELOOP_RUNTIME_SCRIPTS_DIR?.trim(),
  resolve(currentDir, "../../runtime-scripts"),
  resolve(currentDir, "../runtime-scripts"),
], currentDir);
const daemonRoot = dirname(runtimeScriptsDir);
const workspaceRoot = resolve(daemonRoot, "../..");
const defaultWorkspaceRoot = process.env.ALICELOOP_DEFAULT_WORKSPACE_DIR?.trim()
  ? resolve(process.env.ALICELOOP_DEFAULT_WORKSPACE_DIR)
  : workspaceRoot;
const tsxCliPath = (() => {
  try {
    return require.resolve("tsx/dist/cli.mjs");
  } catch {
    return resolve(workspaceRoot, "node_modules/tsx/dist/cli.mjs");
  }
})();

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
    defaultCwd: defaultWorkspaceRoot,
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
    defaultCwd: defaultWorkspaceRoot,
    launchCommand: "node",
    launchArgsPrefix: [tsxCliPath],
  },
];

export { getSkillDefinition, listActiveSkillDefinitions, listSkillDefinitions };

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
    skills: listActiveSkillDefinitions(),
    scripts: listRuntimeScriptDefinitions(),
    mcpServers: listMcpServerDefinitions(),
    recentSandboxRuns: listSandboxRuns(limit),
  };
}
