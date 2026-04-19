import { logPerfTrace, roundMs } from "./perfTrace";
import type { ToolCallState, ToolStateMachine } from "./toolStateMachine";

type RuntimeEventType =
  | "tool.call.started"
  | "tool.call.completed"
  | "tool.approval.requested"
  | "tool.state.change";

type RuntimeEventPublisher = (
  sessionId: string,
  type: RuntimeEventType,
  payload: Record<string, unknown>,
) => unknown;

type ToolRuntimePrediction = {
  backend?: string | null;
  tabId?: string | null;
};

type BrowserToolPayload = {
  backend?: string;
  tabId?: string;
};

interface ToolCallStartEvent {
  toolCall: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
}

interface ToolCallFinishEvent {
  success: boolean;
  output?: unknown;
  error?: unknown;
  durationMs?: number;
  toolCall: {
    toolCallId: string;
    toolName: string;
  };
}

interface CreateToolOrchestrationInput {
  sessionId: string;
  stateMachine: ToolStateMachine;
  autoApproveToolRequests: boolean;
  checkActive(): void;
  summarizeUnknown(value: unknown, maxLength?: number): string | null;
  predictToolBackend(sessionId: string, toolName: string): ToolRuntimePrediction;
  extractBrowserToolPayload(value: unknown): BrowserToolPayload;
  publishRuntimeEvent: RuntimeEventPublisher;
  maybePublishToolImageAttachment(
    sessionId: string,
    toolName: string,
    output: unknown,
    input?: unknown,
  ): Promise<void>;
}

export function createToolOrchestration(input: CreateToolOrchestrationInput) {
  const toolCallInputs = new Map<string, unknown>();

  input.stateMachine.onStateChange((state: ToolCallState) => {
    input.publishRuntimeEvent(input.sessionId, "tool.state.change", {
      toolCallId: state.toolCallId,
      toolName: state.toolName,
      status: state.status,
      input: state.input,
      output: state.output,
      error: state.error,
    });
  });

  return {
    experimental_onToolCallStart({ toolCall }: ToolCallStartEvent) {
      input.checkActive();
      toolCallInputs.set(toolCall.toolCallId, toolCall.input);

      input.stateMachine.start(toolCall.toolCallId, toolCall.toolName, toolCall.input);
      input.stateMachine.markInputAvailable(toolCall.toolCallId);

      if (!input.autoApproveToolRequests && input.stateMachine.needsApproval(toolCall.toolName)) {
        input.publishRuntimeEvent(input.sessionId, "tool.approval.requested", {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          inputPreview: input.summarizeUnknown(toolCall.input),
        });
      }

      const predictedRuntime = input.predictToolBackend(input.sessionId, toolCall.toolName);
      input.publishRuntimeEvent(input.sessionId, "tool.call.started", {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        inputPreview: input.summarizeUnknown(toolCall.input),
        backend: predictedRuntime.backend,
        tabId: predictedRuntime.tabId,
        state: "input-available",
      });
    },

    experimental_onToolCallFinish(event: ToolCallFinishEvent) {
      input.checkActive();
      const resultValue = event.success ? event.output : event.error;
      const resultPreview = input.summarizeUnknown(resultValue);
      const browserPayload = input.extractBrowserToolPayload(resultValue);
      const completedBackend = browserPayload.backend
        ?? input.predictToolBackend(input.sessionId, event.toolCall.toolName).backend
        ?? null;
      const completedTabId = browserPayload.tabId ?? null;

      if (event.success) {
        input.stateMachine.markOutputAvailable(event.toolCall.toolCallId, event.output);
      } else {
        input.stateMachine.markError(event.toolCall.toolCallId, event.error);
      }
      input.stateMachine.complete(event.toolCall.toolCallId);

      input.publishRuntimeEvent(input.sessionId, "tool.call.completed", {
        toolCallId: event.toolCall.toolCallId,
        toolName: event.toolCall.toolName,
        success: event.success,
        resultPreview,
        durationMs: event.durationMs,
        backend: completedBackend,
        tabId: completedTabId,
        state: event.success ? "output-available" : "output-error",
      });
      logPerfTrace("tool_call", {
        sessionId: input.sessionId,
        toolCallId: event.toolCall.toolCallId,
        toolName: event.toolCall.toolName,
        success: event.success ? 1 : 0,
        durationMs: typeof event.durationMs === "number" ? roundMs(event.durationMs) : null,
        browserBackend: completedBackend,
        tabId: completedTabId,
      });

      if (event.success) {
        void input.maybePublishToolImageAttachment(
          input.sessionId,
          event.toolCall.toolName,
          event.output,
          toolCallInputs.get(event.toolCall.toolCallId),
        ).catch(() => {});
      }
      toolCallInputs.delete(event.toolCall.toolCallId);
    },
  };
}
