import type { ToolSet } from "ai";
import type { SkillDefinition } from "@aliceloop/runtime-core";
import type { createPermissionSandboxExecutor } from "../../services/sandboxExecutor";
import type { SkillRouteHints } from "../skills/skillRouting";
import { createSandboxTools } from "./sandboxTools";
import { BASE_TOOL_NAMES, getSkillTool, listUnresolvedSkillTools, resolveSkillTools } from "./skillToolFactories";

type SandboxExecutor = ReturnType<typeof createPermissionSandboxExecutor>;

interface BuildToolSetOptions {
  sessionId?: string;
  query?: string | null;
  routeHints?: SkillRouteHints;
}

function collectRequestedSkillTools(activeSkills: SkillDefinition[]) {
  const requested = new Set<string>();
  for (const skill of activeSkills) {
    for (const toolName of skill.allowedTools) {
      if (!BASE_TOOL_NAMES.has(toolName)) {
        requested.add(toolName);
      }
    }
  }

  return requested;
}

export function listRequestedSkillToolNames(activeSkills: SkillDefinition[]) {
  return [...collectRequestedSkillTools(activeSkills)].sort();
}

export function assertResolvableSkillTools(activeSkills: SkillDefinition[]) {
  const requested = collectRequestedSkillTools(activeSkills);
  const unresolved = listUnresolvedSkillTools(requested);
  if (unresolved.length > 0) {
    throw new Error(
      `Active skills declared unresolved tool adapters: ${unresolved.sort().join(", ")}. ` +
      "Mark the skill as planned or add a matching adapter factory.",
    );
  }
}

export function buildToolSet(
  sandbox: SandboxExecutor,
  activeSkills: SkillDefinition[],
  options?: BuildToolSetOptions,
): ToolSet {
  // Architecture rule:
  // 1. The six sandbox primitives (Bash/Read/Write/Edit/Glob/Grep) are the only always-on native tools.
  // 2. The Skill tool is always available for invoking skills directly.
  // 3. Skills route capabilities by declaring allowed-tools. Everything else comes from skill routing.
  // 4. Bash can invoke unlimited scripts = unlimited capabilities. Skills封装这些能力。
  // Layer 1: always load the 6 base sandbox tools + Skill tool.
  const baseTools = createSandboxTools(sandbox);
  const skillTool = getSkillTool();
  const tools: ToolSet = { ...baseTools, ...skillTool };

  // Layer 2: once a skill is routed for this turn, expose its declared tool adapters.
  // This keeps prompt-visible routed skills and actually attached tools in sync.
  const requested = collectRequestedSkillTools(activeSkills);

  // Fail fast before attaching runtime adapters to a live agent context.
  const unresolved = listUnresolvedSkillTools(requested);
  if (unresolved.length > 0) {
    throw new Error(
      `Active skills declared unresolved tool adapters: ${unresolved.sort().join(", ")}. ` +
      "Mark the skill as planned or add a matching adapter factory.",
    );
  }

  // Layer 3: resolve and attach routed skill tools on demand.
  Object.assign(tools, resolveSkillTools(requested, { sessionId: options?.sessionId }));

  return tools;
}
