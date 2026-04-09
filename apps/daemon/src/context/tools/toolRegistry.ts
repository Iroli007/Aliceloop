import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import type { SkillDefinition } from "@aliceloop/runtime-core";
import type { PermissionSandboxExecutor } from "../../runtime/sandbox/types";
import type { SkillRouteHints } from "../skills/skillRouting";
import { setBrowserSessionPreference } from "./browserSessionRegistry";
import { createSandboxTools } from "./sandboxTools";
import { BASE_TOOL_NAMES, BASE_TOOL_ORDER, listAvailableToolAdapterNames, listUnresolvedSkillTools, resolveSkillTools } from "./skillToolFactories";
import { routeToolNamesForTurn } from "./toolRouter";
import { createAskUserQuestionTool } from "./askUserQuestionTool";
import { createPlanModeToolSet } from "./planModeTools";
import { createUseSkillTool } from "./useSkillTool";

type SandboxExecutor = PermissionSandboxExecutor;

interface BuildToolSetOptions {
  sessionId?: string;
  query?: string | null;
  routeHints?: SkillRouteHints;
  hasImageAttachment?: boolean;
  additionalToolNames?: string[];
  browserRelayAvailable?: boolean;
  planModeActive?: boolean;
}

export const DEFAULT_ATTACHED_TOOL_NAMES: readonly string[] = BASE_TOOL_ORDER;
const PLAN_MODE_READONLY_TOOL_NAMES = [
  "bash",
  "read",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "view_image",
  "browser_navigate",
  "browser_snapshot",
  "browser_find",
  "browser_wait",
  "browser_scroll",
  "browser_screenshot",
  "browser_media_probe",
  "browser_video_watch_start",
  "browser_video_watch_poll",
  "browser_video_watch_stop",
  "chrome_relay_status",
  "chrome_relay_list_tabs",
  "chrome_relay_open",
  "chrome_relay_navigate",
  "chrome_relay_read",
  "chrome_relay_read_dom",
  "chrome_relay_screenshot",
  "chrome_relay_scroll",
  "chrome_relay_back",
  "chrome_relay_forward",
] as const;
const PLAN_MODE_ALLOWED_TOOL_NAMES = new Set<string>(PLAN_MODE_READONLY_TOOL_NAMES);
export const STATIC_BASE_TOOL_BLOCK = [
  "Stable atomic tool base for every turn:",
  `- ${DEFAULT_ATTACHED_TOOL_NAMES.join(", ")}`,
  "These six tools are the long-lived execution substrate for this project.",
  "Skills should usually work through bash, read, and write. Use glob, grep, and edit only when the task truly needs file discovery, code search, or precise in-place edits.",
  "The native `agent` tool is the coordination escape hatch for isolated fork/subagent work. Do not use it for ordinary single-thread tasks.",
  "Extra native tools are exceptions layered on top of this base, not the default path.",
].join("\n");
export const BASE_TOOL_SCHEMA_KEY = createHash("sha1")
  .update("base6:v1")
  .update(DEFAULT_ATTACHED_TOOL_NAMES.join("\u001f"))
  .digest("hex")
  .slice(0, 16);

export function computeToolSurfaceKey(toolNames: readonly string[]) {
  return createHash("sha1").update(toolNames.join("\u001f")).digest("hex").slice(0, 16);
}

function inferBrowserBackendPreference(
  _query: string | null | undefined,
  browserRelayAvailable: boolean | undefined,
) {
  return browserRelayAvailable ? "desktop_chrome" as const : "pinchtab" as const;
}

function collectAllowedTools(activeSkills: SkillDefinition[]) {
  const requested = new Set<string>();
  for (const skill of activeSkills) {
    for (const toolName of skill.allowedTools) {
      requested.add(toolName);
    }
  }

  return requested;
}

function sortToolNames(names: Iterable<string>) {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function collectRequestedToolNames(
  activeSkills: SkillDefinition[],
  options?: BuildToolSetOptions,
) {
  const orderedNames: string[] = [];
  const seen = new Set<string>();

  const pushToolNames = (names: Iterable<string>) => {
    for (const name of names) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      orderedNames.push(name);
    }
  };

  if (options?.planModeActive) {
    pushToolNames(PLAN_MODE_READONLY_TOOL_NAMES);
    pushToolNames(sortToolNames(collectAllowedTools(activeSkills)).filter((toolName) => PLAN_MODE_ALLOWED_TOOL_NAMES.has(toolName)));
    return orderedNames;
  }

  pushToolNames(DEFAULT_ATTACHED_TOOL_NAMES);
  pushToolNames(["agent"]);
  pushToolNames(routeToolNamesForTurn(options?.query, options?.routeHints, {
    hasImageAttachment: options?.hasImageAttachment,
  }));
  pushToolNames(sortToolNames(options?.additionalToolNames ?? []));
  pushToolNames(sortToolNames(collectAllowedTools(activeSkills)));

  return orderedNames;
}

export function buildToolSet(
  sandbox: SandboxExecutor,
  activeSkills: SkillDefinition[],
  options?: BuildToolSetOptions,
): ToolSet {
  // Architecture rule:
  // 1. The six atomic tools are always available as the stable execution base.
  // 2. Final tool set = base 6 ∪ direct tool hits ∪ additionalToolNames ∪ allowed-tools from routed skills.
  // 3. Skills provide workflow guidance and define the non-base capability budget for the turn.
  const allSandboxTools = createSandboxTools(sandbox);
  const tools: ToolSet = {};

  const requestedNames = collectRequestedToolNames(activeSkills, options);
  const requested = new Set(requestedNames);

  if (options?.sessionId && requestedNames.some((toolName) => toolName.startsWith("browser_"))) {
    setBrowserSessionPreference(
      options.sessionId,
      inferBrowserBackendPreference(options?.query, options?.browserRelayAvailable),
    );
  }

  for (const toolName of requestedNames) {
    if (BASE_TOOL_NAMES.has(toolName) && toolName in allSandboxTools) {
      const sandboxToolName = toolName as keyof typeof allSandboxTools;
      tools[sandboxToolName] = allSandboxTools[sandboxToolName];
    }
  }

  const unresolved = listUnresolvedSkillTools(requested);
  if (unresolved.length > 0) {
    throw new Error(
      `Tool router selected unresolved tool adapters: ${unresolved.sort().join(", ")}.`,
    );
  }

  Object.assign(tools, resolveSkillTools(requested, { sessionId: options?.sessionId }));
  if (options?.sessionId) {
    if (options?.planModeActive) {
      Object.assign(tools, createAskUserQuestionTool(options.sessionId));
    }
    Object.assign(tools, createPlanModeToolSet(options.sessionId, options?.planModeActive ?? false));
  }
  if (!options?.planModeActive) {
    Object.assign(tools, createUseSkillTool(activeSkills));
  }
  const orderedTools: ToolSet = {};

  for (const toolName of requestedNames) {
    if (toolName in tools) {
      orderedTools[toolName] = tools[toolName];
    }
  }

  for (const [toolName, toolValue] of Object.entries(tools).sort(([a], [b]) => a.localeCompare(b))) {
    if (toolName in orderedTools) {
      continue;
    }
    orderedTools[toolName] = toolValue;
  }

  return orderedTools;
}

export { listAvailableToolAdapterNames };
