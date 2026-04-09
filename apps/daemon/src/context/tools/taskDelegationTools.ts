import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { getTaskDelegationOutput, normalizeAgentSubagentType, runTaskDelegation } from "../../services/delegatedTaskService";

const delegatedTaskTypeSchema = z.string().trim().min(1).describe(
  "Fresh subagent role. Prefer coder, plan, researcher, or general-purpose. planner and Plan are accepted as aliases for plan.",
);

export function createAgentTools(sessionId?: string): ToolSet {
  return {
    agent: tool({
      description: [
        "Launch an agent only when the work is genuinely better isolated from the main context.",
        "Use mode=fork when you want a context-aware split for noisy research or self-contained implementation work.",
        "Use mode=subagent when you want a fresh role, second opinion, or a specialized independent worker.",
        "Prefer foreground mode when you need the result before your next step.",
        "Background runs return an output_path and post a completion notice back into the parent thread when they finish.",
      ].join(" "),
      inputSchema: z.object({
        mode: z.enum(["fork", "subagent"]).optional().default("fork").describe("fork inherits current thread context; subagent starts fresh with the requested role"),
        name: z.string().trim().min(1).max(40).optional().describe("Short human-readable label for the launched agent"),
        subagent_type: delegatedTaskTypeSchema.optional().describe("Required when mode=subagent; ignored for fork mode"),
        prompt: z.string().min(1).describe("Standalone task description for the launched agent"),
        run_in_background: z.boolean().optional().default(false).describe("Whether to let the delegated task keep running in the background"),
      }),
      execute: async ({ mode, name, subagent_type, prompt, run_in_background }, executionOptions?: ToolExecutionOptions) => {
        if (!sessionId) {
          throw new Error("agent requires a bound session.");
        }

        const result = await runTaskDelegation({
          sessionId,
          mode,
          name,
          type: mode === "subagent"
            ? normalizeAgentSubagentType(subagent_type ?? "general-purpose")
            : "general-purpose",
          prompt,
          runInBackground: run_in_background,
          abortSignal: executionOptions?.abortSignal,
        });
        return JSON.stringify(result);
      },
    }),
    task_output: tool({
      description: [
        "Check the status or retrieve the result of a background agent task.",
        "Each response includes output_path; prefer reading that file once the delegated task finishes.",
        "Prefer wait=false for a quick status check.",
        "Use wait=true only when you are intentionally ready to wait for the delegated result.",
        "Do not background an agent and then immediately block on task_output; if you need the answer right away, run the agent in foreground instead.",
      ].join(" "),
      inputSchema: z.object({
        task_id: z.string().min(1).describe("Background task id returned by agent"),
        wait: z.boolean().optional().default(false).describe("Whether to wait until the delegated task reaches a terminal state"),
        timeout_ms: z.number().int().positive().max(300_000).optional().default(30_000).describe("Maximum blocking wait time when wait=true"),
      }),
      execute: async ({ task_id, wait, timeout_ms }, executionOptions?: ToolExecutionOptions) => {
        const result = await getTaskDelegationOutput(task_id, wait, executionOptions?.abortSignal, timeout_ms);
        return JSON.stringify(result);
      },
    }),
  };
}
