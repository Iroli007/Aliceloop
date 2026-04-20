import type { ToolSet } from "ai";
import type { SkillDefinition } from "@aliceloop/runtime-core";
import type { createPermissionSandboxExecutor } from "../../services/sandboxExecutor";
import { withToolCacheBreakpoint } from "../cacheControl";
import type { SkillRouteHints } from "../skills/skillRouting";
import { setBrowserSessionPreference } from "./browserSessionRegistry";
import { createSandboxTools } from "./sandboxTools";
import { BASE_TOOL_NAMES, listAvailableToolAdapterNames, listUnresolvedSkillTools, resolveSkillTools } from "./skillToolFactories";
import { routeToolNamesForTurn } from "./toolRouter";

type SandboxExecutor = ReturnType<typeof createPermissionSandboxExecutor>;

interface BuildToolSetOptions {
  sessionId?: string;
  query?: string | null;
  routeHints?: SkillRouteHints;
  hasImageAttachment?: boolean;
  additionalToolNames?: string[];
  browserRelayAvailable?: boolean;
}

const BASE_TOOL_ORDER = ["grep", "glob", "read", "write", "edit", "bash"] as const;
const STABLE_TOOL_PREFIX_ORDER = [
  "web_search",
  "web_fetch",
  "view_image",
  "browser_find",
  "browser_navigate",
  "browser_snapshot",
  "browser_wait",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_batch",
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
  "chrome_relay_click",
  "chrome_relay_type",
  "chrome_relay_screenshot",
  "chrome_relay_scroll",
  "chrome_relay_eval",
  "chrome_relay_back",
  "chrome_relay_forward",
] as const;
const STABLE_TOOL_PREFIX_SET = new Set<string>(STABLE_TOOL_PREFIX_ORDER);

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

function addTool(tools: ToolSet, toolName: string, source: ToolSet) {
  if (!(toolName in source)) {
    return;
  }

  tools[toolName] = source[toolName];
}

export function buildToolSet(
  sandbox: SandboxExecutor,
  activeSkills: SkillDefinition[],
  options?: BuildToolSetOptions,
): ToolSet {
  // Architecture rule:
  // 1. No tool is always on by default.
  // 2. Final tool set = direct tool hits ∪ allowed-tools from routed skills.
  // 3. Skills provide workflow guidance and may also opt into a minimal tool surface.
  const allSandboxTools = createSandboxTools(sandbox);

  const requested = new Set([
    ...routeToolNamesForTurn(options?.query, options?.routeHints, {
      hasImageAttachment: options?.hasImageAttachment,
    }),
    ...(options?.additionalToolNames ?? []),
    ...collectAllowedTools(activeSkills),
  ]);

  if (options?.sessionId && [...requested].some((toolName) => toolName.startsWith("browser_"))) {
    setBrowserSessionPreference(
      options.sessionId,
      inferBrowserBackendPreference(options?.query, options?.browserRelayAvailable),
    );
  }

  const unresolved = listUnresolvedSkillTools(requested);
  if (unresolved.length > 0) {
    throw new Error(
      `Tool router selected unresolved tool adapters: ${unresolved.sort().join(", ")}.`,
    );
  }

  const resolvedSkillTools = resolveSkillTools(requested, { sessionId: options?.sessionId });
  const orderedTools: ToolSet = {};
  const attachedBaseToolNames = BASE_TOOL_ORDER.filter((toolName) => requested.has(toolName));
  const attachedSkillToolNames = Object.keys(resolvedSkillTools);
  const attachedStableSkillToolNames = STABLE_TOOL_PREFIX_ORDER.filter((toolName) => attachedSkillToolNames.includes(toolName));
  const attachedDynamicSkillToolNames = attachedSkillToolNames
    .filter((toolName) => !STABLE_TOOL_PREFIX_SET.has(toolName))
    .sort((left, right) => left.localeCompare(right, "en"));

  for (const toolName of attachedBaseToolNames) {
    if (BASE_TOOL_NAMES.has(toolName) && toolName in allSandboxTools) {
      addTool(orderedTools, toolName, allSandboxTools);
    }
  }

  for (const toolName of attachedStableSkillToolNames) {
    addTool(orderedTools, toolName, resolvedSkillTools);
  }

  for (const toolName of attachedDynamicSkillToolNames) {
    addTool(orderedTools, toolName, resolvedSkillTools);
  }

  const cacheMarkerToolName = attachedStableSkillToolNames.at(-1) ?? attachedBaseToolNames.at(-1) ?? null;
  return withToolCacheBreakpoint(orderedTools, cacheMarkerToolName);
}

export { listAvailableToolAdapterNames };
