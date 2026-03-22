import type { ToolSet } from "ai";
import { createBrowserTools } from "./browserTool";
import { createCodingAgentTool } from "./codingAgentTool";
import { createManagedTaskTools } from "./managedTaskTools";
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

// Tool name -> factory, each factory returns { [toolName]: tool({...}) }
const skillToolFactories = new Map<string, () => ToolSet>([
  ["browser_navigate", () => createBrowserTools()],
  ["browser_snapshot", () => createBrowserTools()],
  ["browser_click", () => createBrowserTools()],
  ["browser_type", () => createBrowserTools()],
  ["browser_screenshot", () => createBrowserTools()],
  ["coding_agent_run", () => createCodingAgentTool()],
  ["document_ingest", () => ({ document_ingest: getManagedTaskTools().document_ingest })],
  ["review_coach", () => ({ review_coach: getManagedTaskTools().review_coach })],
  ["web_fetch", () => createWebFetchTool()],
  ["web_search", () => createWebSearchTool()],
]);

function resolveSkillToolSelection(requestedNames: Set<string>) {
  const tools: ToolSet = {};
  const unresolved: string[] = [];

  for (const name of requestedNames) {
    if (BASE_TOOL_NAMES.has(name)) {
      continue;
    }

    const factory = skillToolFactories.get(name);
    if (factory) {
      Object.assign(tools, factory());
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
 * Resolve skill-requested tool names into concrete ToolSet entries.
 * Base tools (grep/glob/read/write/edit/bash) are skipped — they are always loaded.
 * runtime_script_* names use prefix matching against managedTaskTools.
 */
export function resolveSkillTools(requestedNames: Set<string>): ToolSet {
  return resolveSkillToolSelection(requestedNames).tools;
}

export function listUnresolvedSkillTools(requestedNames: Set<string>) {
  return resolveSkillToolSelection(requestedNames).unresolved;
}

/** Reset the managed-task cache (for testing). */
export function resetSkillToolCache() {
  cachedManagedTaskTools = null;
}
