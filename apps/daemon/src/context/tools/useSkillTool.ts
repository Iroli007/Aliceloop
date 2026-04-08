import type { SkillDefinition } from "@aliceloop/runtime-core";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getSkillDefinition } from "../skills/skillLoader";
import { STABLE_TOOL_PROVIDER_OPTIONS } from "./toolProviderOptions";

export const USE_SKILL_TOOL_NAME = "use_skill";

export function createUseSkillTool(selectedSkills: SkillDefinition[]): ToolSet {
  const selectedSkillIds = new Set(selectedSkills.map((skill) => skill.id));

  return {
    [USE_SKILL_TOOL_NAME]: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Load a local skill from the catalog into the current turn so its allowed-tools are attached on the next pass. Use this when a relevant catalog task skill is not currently selected. Start with the single smallest relevant task skill; add a second non-meta task skill only if execution truly requires it. Do not call skill-hub or skill-search just to inspect the catalog already shown in the prompt. Input must be the exact skill id from the catalog.",
      inputSchema: z.object({
        skill: z.string().min(1).describe("Exact skill id from the local skill catalog"),
      }),
      execute: async ({ skill }) => {
        const skillId = skill.trim();
        const definition = getSkillDefinition(skillId);
        if (!definition || definition.status !== "available") {
          return JSON.stringify({
            kind: USE_SKILL_TOOL_NAME,
            skillId,
            status: "invalid",
          });
        }

        if (selectedSkillIds.has(skillId)) {
          return JSON.stringify({
            kind: USE_SKILL_TOOL_NAME,
            skillId,
            status: "already_loaded",
          });
        }

        return JSON.stringify({
          kind: USE_SKILL_TOOL_NAME,
          skillId,
          status: "loaded",
        });
      },
    }),
  };
}
