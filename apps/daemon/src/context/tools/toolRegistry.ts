import type { ToolSet } from "ai";
import type { SkillDefinition } from "@aliceloop/runtime-core";
import type { createPermissionSandboxExecutor } from "../../services/sandboxExecutor";
import type { SkillRouteHints } from "../skills/skillRouting";
import { createSandboxTools } from "./sandboxTools";
import { BASE_TOOL_NAMES, listAvailableToolAdapterNames, listUnresolvedSkillTools, resolveSkillTools } from "./skillToolFactories";
import { routeToolNamesForTurn } from "./toolRouter";

type SandboxExecutor = ReturnType<typeof createPermissionSandboxExecutor>;

interface BuildToolSetOptions {
  sessionId?: string;
  query?: string | null;
  routeHints?: SkillRouteHints;
  hasImageAttachment?: boolean;
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
  const tools: ToolSet = {};

  const requested = new Set([
    ...routeToolNamesForTurn(options?.query, options?.routeHints, {
      hasImageAttachment: options?.hasImageAttachment,
    }),
    ...collectAllowedTools(activeSkills),
  ]);

  for (const toolName of requested) {
    if (BASE_TOOL_NAMES.has(toolName) && toolName in allSandboxTools) {
      tools[toolName] = allSandboxTools[toolName];
    }
  }

  const unresolved = listUnresolvedSkillTools(requested);
  if (unresolved.length > 0) {
    throw new Error(
      `Tool router selected unresolved tool adapters: ${unresolved.sort().join(", ")}.`,
    );
  }

  Object.assign(tools, resolveSkillTools(requested, { sessionId: options?.sessionId }));

  return tools;
}

export { listAvailableToolAdapterNames };
