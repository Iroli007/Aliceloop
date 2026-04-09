import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { requestSessionUserQuestion } from "../../services/sessionToolApprovalService";
import type { ToolApprovalStateTracker } from "../../runtime/sandbox/types";
import { STABLE_TOOL_PROVIDER_OPTIONS } from "./toolProviderOptions";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

type AskUserQuestionExecutionOptions = ToolExecutionOptions & {
  approvalStateTracker?: ToolApprovalStateTracker;
};

export function createAskUserQuestionTool(sessionId: string): ToolSet {
  return {
    [ASK_USER_QUESTION_TOOL_NAME]: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Ask the user a structured clarification question only when execution is genuinely blocked by an unresolved decision. Use 2-3 concrete, mutually exclusive options. Do not use this for speculative suggestions, fuzzy related-topic surfacing, or choices you can reasonably infer yourself. The user can either click an option or type a custom freeform answer.",
      inputSchema: z.object({
        header: z.string().min(1).max(24).describe("Short chip-style header for the question, such as 平台 or 范围"),
        question: z.string().min(1).max(200).describe("The actual question shown to the user"),
        options: z.array(z.object({
          label: z.string().min(1).max(32).describe("Short option label"),
          description: z.string().min(1).max(120).optional().describe("Optional short explanation for the option"),
        })).min(2).max(3).describe("2-3 explicit options the user can choose from"),
        multiSelect: z.boolean().optional().describe("Allow selecting multiple options before sending"),
      }),
      execute: async ({ header, question, options, multiSelect }, executionOptions?: AskUserQuestionExecutionOptions) => {
        const answer = await requestSessionUserQuestion({
          sessionId,
          toolCallId: executionOptions?.toolCallId,
          header,
          question,
          options,
          multiSelect,
          abortSignal: executionOptions?.abortSignal ?? new AbortController().signal,
          approvalStateTracker: executionOptions?.approvalStateTracker,
        });

        return JSON.stringify({
          kind: ASK_USER_QUESTION_TOOL_NAME,
          answer,
        });
      },
    }),
  };
}
