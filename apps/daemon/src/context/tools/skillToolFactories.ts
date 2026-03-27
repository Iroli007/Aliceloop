import { createAudioUnderstandTool } from "./audioUnderstandTool";
import type { ToolSet } from "ai";
import { createBrowserTools } from "./browserTool";
import { createManagedTaskTools } from "./managedTaskTools";
import { createViewImageTool } from "./viewImageTool";
import { createWebFetchTool } from "./webFetchTool";
import { createWebSearchTool } from "./webSearchTool";

export const BASE_TOOL_NAMES = new Set(["grep", "glob", "read", "write", "edit", "bash"]);

// Lazy-cached managed task tools (includes dynamic runtime_script_*)
let cachedManagedTaskTools: ToolSet | null = null;
function getManagedTaskTools(): ToolSet {
  if (!cachedManagedTaskTools) {
    cachedManagedTaskTools = createManagedTaskTools();
  }
  return cachedManagedTaskTools;
}

const cachedBrowserTools = new Map<string, ToolSet>();
const cachedWebFetchTools = new Map<string, ToolSet>();
const cachedWebSearchTools = new Map<string, ToolSet>();
const cachedAudioUnderstandTools = new Map<string, ToolSet>();
const cachedViewImageTools = new Map<string, ToolSet>();

interface SkillToolFactoryOptions {
  sessionId?: string;
}

function getSessionCacheKey(sessionId?: string) {
  return sessionId ?? "default";
}

function getBrowserToolSet(sessionId?: string) {
  const cacheKey = getSessionCacheKey(sessionId);
  const existing = cachedBrowserTools.get(cacheKey);
  if (existing) {
    return existing;
  }

  const tools = createBrowserTools(sessionId);
  cachedBrowserTools.set(cacheKey, tools);
  return tools;
}

function getWebFetchToolSet(sessionId?: string) {
  const cacheKey = getSessionCacheKey(sessionId);
  const existing = cachedWebFetchTools.get(cacheKey);
  if (existing) {
    return existing;
  }

  const tools = createWebFetchTool(sessionId);
  cachedWebFetchTools.set(cacheKey, tools);
  return tools;
}

function getWebSearchToolSet(sessionId?: string) {
  const cacheKey = getSessionCacheKey(sessionId);
  const existing = cachedWebSearchTools.get(cacheKey);
  if (existing) {
    return existing;
  }

  const tools = createWebSearchTool(sessionId);
  cachedWebSearchTools.set(cacheKey, tools);
  return tools;
}

function getAudioUnderstandToolSet(sessionId?: string) {
  const cacheKey = getSessionCacheKey(sessionId);
  const existing = cachedAudioUnderstandTools.get(cacheKey);
  if (existing) {
    return existing;
  }

  const tools = createAudioUnderstandTool(sessionId);
  cachedAudioUnderstandTools.set(cacheKey, tools);
  return tools;
}

function getViewImageToolSet(sessionId?: string) {
  const cacheKey = getSessionCacheKey(sessionId);
  const existing = cachedViewImageTools.get(cacheKey);
  if (existing) {
    return existing;
  }

  const tools = createViewImageTool(sessionId);
  cachedViewImageTools.set(cacheKey, tools);
  return tools;
}

const BROWSER_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_media_probe",
  "browser_video_watch_start",
  "browser_video_watch_poll",
  "browser_video_watch_stop",
]);

// Tool name -> factory, each factory returns { [toolName]: tool({...}) }
const skillToolFactories = new Map<string, (options?: SkillToolFactoryOptions) => ToolSet>([
  ["audio_understand", (options) => getAudioUnderstandToolSet(options?.sessionId)],
  ["browser_navigate", (options) => getBrowserToolSet(options?.sessionId)],
  ["browser_snapshot", (options) => getBrowserToolSet(options?.sessionId)],
  ["browser_click", (options) => getBrowserToolSet(options?.sessionId)],
  ["browser_type", (options) => getBrowserToolSet(options?.sessionId)],
  ["browser_screenshot", (options) => getBrowserToolSet(options?.sessionId)],
  ["browser_media_probe", (options) => getBrowserToolSet(options?.sessionId)],
  ["browser_video_watch_start", (options) => getBrowserToolSet(options?.sessionId)],
  ["browser_video_watch_poll", (options) => getBrowserToolSet(options?.sessionId)],
  ["browser_video_watch_stop", (options) => getBrowserToolSet(options?.sessionId)],
  ["document_ingest", () => ({ document_ingest: getManagedTaskTools().document_ingest })],
  ["review_coach", () => ({ review_coach: getManagedTaskTools().review_coach })],
  ["view_image", (options) => getViewImageToolSet(options?.sessionId)],
  ["web_fetch", (options) => getWebFetchToolSet(options?.sessionId)],
  ["web_search", (options) => getWebSearchToolSet(options?.sessionId)],
]);

function resolveSkillToolSelection(requestedNames: Set<string>, options?: SkillToolFactoryOptions) {
  const tools: ToolSet = {};
  const unresolved: string[] = [];
  let browserToolsAttached = false;

  for (const name of requestedNames) {
    if (BASE_TOOL_NAMES.has(name)) {
      continue;
    }

    if (BROWSER_TOOL_NAMES.has(name)) {
      if (!browserToolsAttached) {
        Object.assign(tools, getBrowserToolSet(options?.sessionId));
        browserToolsAttached = true;
      }
      continue;
    }

    const factory = skillToolFactories.get(name);
    if (factory) {
      Object.assign(tools, factory(options));
      continue;
    }

    if (name.startsWith("runtime_script_")) {
      const managed = getManagedTaskTools();
      if (name in managed) {
        tools[name] = managed[name];
        continue;
      }
    }

    unresolved.push(name);
  }

  return {
    tools,
    unresolved,
  };
}

/**
 * Resolve tool-router-selected tool names into concrete ToolSet entries.
 * Base tools (grep/glob/read/write/edit/bash) are skipped — they are always loaded.
 * runtime_script_* names use prefix matching against managedTaskTools.
 */
export function resolveSkillTools(requestedNames: Set<string>, options?: SkillToolFactoryOptions): ToolSet {
  return resolveSkillToolSelection(requestedNames, options).tools;
}

export function listUnresolvedSkillTools(requestedNames: Set<string>) {
  return resolveSkillToolSelection(requestedNames).unresolved;
}

export function listAvailableToolAdapterNames() {
  return [...new Set([
    ...BROWSER_TOOL_NAMES,
    ...skillToolFactories.keys(),
  ])].sort();
}

/** Reset the managed-task cache (for testing). */
export function resetSkillToolCache() {
  cachedManagedTaskTools = null;
  cachedBrowserTools.clear();
  cachedWebFetchTools.clear();
  cachedWebSearchTools.clear();
  cachedAudioUnderstandTools.clear();
  cachedViewImageTools.clear();
}
