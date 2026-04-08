import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getTaskDelegationOutput, normalizeTaskDelegationType, runTaskDelegation } from "../../services/delegatedTaskService";

const delegatedTaskTypeSchema = z.string().trim().min(1).describe(
  "Delegated sub-agent role. Prefer coder, plan, researcher, or general-purpose. planner and Plan are accepted as aliases for plan.",
);

export function createTaskDelegationTools(sessionId?: string): ToolSet {
  return {
    task_delegation: tool({
      description: [
        "Launch a delegated sub-agent in an isolated thread for substantial multi-step work.",
        "Use this for coding, planning, research, or other self-contained tasks that are too large to handle inline.",
        "When run_in_background is true, return immediately with a task_id and fetch the result later with task_output.",
        "When run_in_background is false or omitted, wait for the delegated run to finish and return its result directly.",
      ].join(" "),
      inputSchema: z.object({
        type: delegatedTaskTypeSchema,
        prompt: z.string().min(1).describe("Standalone task description for the delegated sub-agent"),
        run_in_background: z.boolean().optional().default(false).describe("Whether to let the delegated task keep running in the background"),
      }),
      execute: async ({ type, prompt, run_in_background }) => {
        if (!sessionId) {
          throw new Error("task_delegation requires a bound session.");
        }

        const result = await runTaskDelegation({
          sessionId,
          type: normalizeTaskDelegationType(type),
          prompt,
          runInBackground: run_in_background,
        });
        return JSON.stringify(result);
      },
    }),
    task_output: tool({
      description: [
        "Check the status or retrieve the result of a delegated background task.",
        "Use wait=false to poll without blocking.",
        "Use wait=true when you are ready to block until the delegated task completes.",
      ].join(" "),
      inputSchema: z.object({
        task_id: z.string().min(1).describe("Delegated task id returned by task_delegation"),
        wait: z.boolean().optional().default(false).describe("Whether to wait until the delegated task reaches a terminal state"),
      }),
      execute: async ({ task_id, wait }) => {
        const result = await getTaskDelegationOutput(task_id, wait);
        return JSON.stringify(result);
      },
    }),
  };
}
