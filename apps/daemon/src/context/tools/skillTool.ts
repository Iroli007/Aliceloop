import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { listActiveSkillDefinitions, getSkillDefinition } from "../skills/skillLoader";

/**
 * Skill Tool - 专门用于调用 skill
 * 
 * 当 agent 需要执行某个 skill 时，调用这个工具来获取 skill 的详细信息。
 * skill 定义在 src/context/skills/<skill-name>/SKILL.md
 */
export function createSkillTool(): ToolSet {
  return {
    skill: tool({
      description:
        "Execute a skill within the main conversation. " +
        "Use this when you need to perform a specialized task that a skill provides. " +
        "The skill name should match an installed skill's ID (e.g., 'web-search', 'browser', 'scheduler').",
      inputSchema: z.object({
        skill: z.string().describe("The skill name to invoke"),
      }),
      execute: async ({ skill }) => {
        const definition = getSkillDefinition(skill);
        
        if (!definition) {
          const available = listActiveSkillDefinitions()
            .map((s) => s.id)
            .sort();
          return `Skill "${skill}" not found. Available skills: ${available.join(", ")}`;
        }

        return [
          `Skill: ${definition.label}`,
          `Description: ${definition.description}`,
          `Mode: ${definition.mode}`,
          definition.allowedTools.length > 0
            ? `Allowed tools: ${definition.allowedTools.join(", ")}`
            : "Allowed tools: (none - uses base tools only)",
          `Status: ${definition.status}`,
        ].join("\n");
      },
    }),
  };
}
