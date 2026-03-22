import type { ToolSet } from "ai";
import type { SkillDefinition } from "@aliceloop/runtime-core";
import type { createPermissionSandboxExecutor } from "../../services/sandboxExecutor";
import { createSandboxTools } from "./sandboxTools";
import { BASE_TOOL_NAMES, listUnresolvedSkillTools, resolveSkillTools } from "./skillToolFactories";

type SandboxExecutor = ReturnType<typeof createPermissionSandboxExecutor>;

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
): ToolSet {
  // Layer 1: always load the 6 base sandbox tools
  const baseTools = createSandboxTools(sandbox);
  const tools: ToolSet = {};

  // Mark base tools for caching
  for (const [name, toolDef] of Object.entries(baseTools)) {
    tools[name] = {
      ...toolDef,
      experimental_providerMetadata: {
        anthropic: { cacheControl: { type: "ephemeral" } }
      }
    };
  }

  // Layer 2: collect extra tool names requested by active skills
  const requested = collectRequestedSkillTools(activeSkills);

  // Fail fast before attaching runtime adapters to a live agent context.
  assertResolvableSkillTools(activeSkills);

  // Layer 3: resolve and attach on-demand tools (not cached)
  Object.assign(tools, resolveSkillTools(requested));

  return tools;
}
