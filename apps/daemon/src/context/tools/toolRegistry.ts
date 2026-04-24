import type { ToolSet } from "ai";
import type { JSONObject, SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { SkillDefinition } from "@aliceloop/runtime-core";
import type { createPermissionSandboxExecutor } from "../../services/sandboxExecutor";
import { withToolCacheBreakpoint } from "../cacheControl";
import type { SkillRouteHints } from "../skills/skillRouting";
import { setBrowserSessionPreference } from "./browserSessionRegistry";
import { createSandboxTools } from "./sandboxTools";
import { createToolSearchTool, type ToolSearchCatalogEntry } from "./toolSearchTool";
import {
  BASE_TOOL_NAMES,
  getAnthropicToolSearchToolSet,
  listAvailableToolAdapterNames,
  listUnresolvedSkillTools,
  resolveSkillTools,
} from "./skillToolFactories";
import { routeToolNamesForTurn } from "./toolRouter";

type SandboxExecutor = ReturnType<typeof createPermissionSandboxExecutor>;

interface BuildToolSetOptions {
  sessionId?: string;
  query?: string | null;
  routeHints?: SkillRouteHints;
  hasImageAttachment?: boolean;
  additionalToolNames?: string[];
  browserRelayAvailable?: boolean;
  enableAnthropicToolSearch?: boolean;
}

const BASE_TOOL_ORDER = ["grep", "glob", "read", "write", "edit", "bash"] as const;
const TOOL_SEARCH_ALWAYS_LOADED = new Set([
  ...BASE_TOOL_ORDER,
  "tool_search",
  "web_search",
  "web_fetch",
  "view_image",
  "browser_snapshot",
  "browser_navigate",
]);
const MIN_TOOL_COUNT_FOR_TOOL_SEARCH = 10;
const SESSION_STABLE_TOOL_ORDER = [
  "audio_understand",
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
  "document_ingest",
  "review_coach",
] as const;
const SESSION_STABLE_TOOL_SET = new Set<string>(SESSION_STABLE_TOOL_ORDER);
const VOLATILE_TOOL_PREFIXES = ["runtime_script_"] as const;

export type ToolSchemaLifecycle = "base" | "session-stable" | "dynamic" | "volatile";

const SPECIAL_TOOL_NAMES = new Set(["tool_search"]);

function isVolatileToolName(toolName: string) {
  return VOLATILE_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

export function getToolSchemaLifecycle(toolName: string): ToolSchemaLifecycle {
  if (BASE_TOOL_NAMES.has(toolName)) {
    return "base";
  }
  if (SESSION_STABLE_TOOL_SET.has(toolName)) {
    return "session-stable";
  }
  if (isVolatileToolName(toolName)) {
    return "volatile";
  }
  return "dynamic";
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

function addTool(tools: ToolSet, toolName: string, source: ToolSet) {
  if (!(toolName in source)) {
    return;
  }

  tools[toolName] = source[toolName];
}

function getToolSearchGroup(toolName: string): Pick<ToolSearchCatalogEntry, "groupId" | "groupLabel"> {
  if (toolName === "tool_search" || toolName === "tool_search_tool_bm25" || toolName === "agent" || toolName === "task" || toolName === "skill") {
    return { groupId: "agentic", groupLabel: "Agent & Skills" };
  }

  if (toolName === "document_ingest" || toolName === "review_coach") {
    return { groupId: "workflow", groupLabel: "Workflow" };
  }

  if (toolName.startsWith("runtime_script_")) {
    return { groupId: "runtime", groupLabel: "Runtime Scripts" };
  }

  if (toolName.startsWith("browser_")) {
    return { groupId: "browser", groupLabel: "Browser" };
  }

  if (toolName.startsWith("chrome_relay_")) {
    return { groupId: "chrome_relay", groupLabel: "Chrome Relay" };
  }

  if (toolName === "web_search" || toolName === "web_fetch") {
    return { groupId: "web", groupLabel: "Web" };
  }

  if (toolName === "audio_understand" || toolName === "view_image") {
    return { groupId: "media", groupLabel: "Media" };
  }

  if (toolName === "bash") {
    return { groupId: "shell", groupLabel: "Shell" };
  }

  if (["grep", "glob", "read", "write", "edit"].includes(toolName)) {
    return { groupId: "filesystem", groupLabel: "File Ops" };
  }

  return { groupId: "other", groupLabel: "Other" };
}

function buildToolSearchCatalog(
  sandboxTools: ToolSet,
  orderedTools: ToolSet,
  sessionId: string | undefined,
): ToolSearchCatalogEntry[] {
  const catalog: ToolSearchCatalogEntry[] = BASE_TOOL_ORDER.map((toolName) => ({
    name: toolName,
    description: sandboxTools[toolName]?.description ?? "",
    attached: toolName in orderedTools,
    lifecycle: "base",
    ...getToolSearchGroup(toolName),
  }));

  const discoverableToolNames = listAvailableToolAdapterNames().filter((toolName) => {
    return !BASE_TOOL_NAMES.has(toolName) && !SPECIAL_TOOL_NAMES.has(toolName) && toolName !== "tool_search_tool_bm25";
  });
  const discoverableToolSet = resolveSkillTools(new Set(discoverableToolNames), { sessionId });

  for (const [toolName, toolDefinition] of Object.entries(discoverableToolSet)) {
    catalog.push({
      name: toolName,
      description: toolDefinition.description ?? "",
      attached: toolName in orderedTools,
      lifecycle: getToolSchemaLifecycle(toolName),
      ...getToolSearchGroup(toolName),
    });
  }

  catalog.push({
    name: "tool_search",
    description: "Agent-side tool discovery utility for searching Aliceloop's available tools by capability, name, and description.",
    attached: true,
    lifecycle: "dynamic",
    ...getToolSearchGroup("tool_search"),
  });

  catalog.push({
    name: "tool_search_tool_bm25",
    description: "Anthropic BM25 server-side tool discovery utility for deferred tools when the current provider supports it.",
    attached: "tool_search_tool_bm25" in orderedTools,
    lifecycle: "external",
    ...getToolSearchGroup("tool_search_tool_bm25"),
  });

  return catalog;
}

function withAnthropicDeferLoading(tools: ToolSet, deferredToolNames: Set<string>) {
  if (deferredToolNames.size === 0) {
    return tools;
  }

  const next: ToolSet = {};
  for (const [toolName, toolDefinition] of Object.entries(tools)) {
    if (!deferredToolNames.has(toolName)) {
      next[toolName] = toolDefinition;
      continue;
    }

    const providerOptions = toolDefinition.providerOptions as SharedV3ProviderOptions | undefined;
    const anthropic = providerOptions?.anthropic;
    const anthropicOptions = anthropic && typeof anthropic === "object"
      ? anthropic as JSONObject
      : {};

    next[toolName] = {
      ...toolDefinition,
      providerOptions: {
        ...(providerOptions ?? {}),
        anthropic: {
          ...anthropicOptions,
          deferLoading: true,
        },
      },
    };
  }

  return next;
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

  const requestedAdapterNames = new Set(
    [...requested].filter((toolName) => !BASE_TOOL_NAMES.has(toolName) && !SPECIAL_TOOL_NAMES.has(toolName)),
  );
  const unresolved = listUnresolvedSkillTools(requestedAdapterNames);
  if (unresolved.length > 0) {
    throw new Error(
      `Tool router selected unresolved tool adapters: ${unresolved.sort().join(", ")}.`,
    );
  }

  const resolvedSkillTools = resolveSkillTools(requestedAdapterNames, { sessionId: options?.sessionId });
  const orderedTools: ToolSet = {};
  const attachedBaseToolNames = BASE_TOOL_ORDER.filter((toolName) => requested.has(toolName));
  const attachedSkillToolNames = Object.keys(resolvedSkillTools);
  const attachedSessionStableToolNames = SESSION_STABLE_TOOL_ORDER.filter((toolName) => attachedSkillToolNames.includes(toolName));
  const attachedDynamicToolNames = attachedSkillToolNames
    .filter((toolName) => getToolSchemaLifecycle(toolName) === "dynamic")
    .sort((left, right) => left.localeCompare(right, "en"));
  const attachedVolatileToolNames = attachedSkillToolNames
    .filter((toolName) => getToolSchemaLifecycle(toolName) === "volatile")
    .sort((left, right) => left.localeCompare(right, "en"));

  for (const toolName of attachedBaseToolNames) {
    if (BASE_TOOL_NAMES.has(toolName) && toolName in allSandboxTools) {
      addTool(orderedTools, toolName, allSandboxTools);
    }
  }

  for (const toolName of attachedSessionStableToolNames) {
    addTool(orderedTools, toolName, resolvedSkillTools);
  }

  for (const toolName of attachedDynamicToolNames) {
    addTool(orderedTools, toolName, resolvedSkillTools);
  }

  for (const toolName of attachedVolatileToolNames) {
    addTool(orderedTools, toolName, resolvedSkillTools);
  }

  if (requested.has("tool_search")) {
    const toolSearchCatalog = buildToolSearchCatalog(allSandboxTools, orderedTools, options?.sessionId);
    Object.assign(orderedTools, createToolSearchTool(toolSearchCatalog));
  }

  const shouldEnableAnthropicToolSearch = options?.enableAnthropicToolSearch === true
    && Object.keys(orderedTools).length >= MIN_TOOL_COUNT_FOR_TOOL_SEARCH;
  const deferredToolNames = shouldEnableAnthropicToolSearch
    ? new Set(Object.keys(orderedTools).filter((toolName) => !TOOL_SEARCH_ALWAYS_LOADED.has(toolName)))
    : new Set<string>();
  const toolSearchReadyTools = shouldEnableAnthropicToolSearch
    ? withAnthropicDeferLoading(orderedTools, deferredToolNames)
    : orderedTools;
  const cacheMarkerToolName = [...attachedSessionStableToolNames, ...attachedBaseToolNames]
    .filter((toolName) => !deferredToolNames.has(toolName))
    .at(-1) ?? null;
  const cacheReadyTools = withToolCacheBreakpoint(toolSearchReadyTools, cacheMarkerToolName);

  if (!shouldEnableAnthropicToolSearch) {
    return cacheReadyTools;
  }

  return {
    ...getAnthropicToolSearchToolSet(),
    ...cacheReadyTools,
  };
}

export { listAvailableToolAdapterNames };
