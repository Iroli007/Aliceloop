import type { ToolExecutionOptions, ToolSet } from "ai";
import {
  applyAggregateToolResultBudget,
  applyToolResultBudget,
  getToolExecutionContract,
  measureToolResultChars,
  type ToolConcurrencyMode,
  type ToolExecutionContract,
} from "../context/tools/toolExecutionContracts";
import type { BashProgressTracker, ToolApprovalStateTracker } from "./sandbox/types";
import { ToolStateMachine } from "./toolStateMachine";

const AGGREGATE_TOOL_RESULT_BUDGET_CHARS = 90_000;

interface QueueEntry {
  toolCallId: string;
  toolName: string;
  contract: ToolExecutionContract;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  abortSignal?: AbortSignal;
  cleanupAbortListener?: () => void;
}

class ToolExecutionCoordinator {
  private active = new Map<string, { toolName: string; concurrency: ToolConcurrencyMode }>();
  private queue: QueueEntry[] = [];
  private aggregateResultChars = 0;

  constructor(private readonly stateMachine: ToolStateMachine) {}

  async acquire(input: {
    toolCallId: string;
    toolName: string;
    contract: ToolExecutionContract;
    abortSignal?: AbortSignal;
  }) {
    if (input.abortSignal?.aborted && input.contract.interruptBehavior === "cancel") {
      throw new Error(`Tool call ${input.toolName} was cancelled before execution started.`);
    }

    if (this.canStart(input.contract.concurrency)) {
      return this.startNow(input.toolCallId, input.toolName, input.contract.concurrency);
    }

    this.stateMachine.markQueued(input.toolCallId);

    return await new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        contract: input.contract,
        resolve,
        reject,
        abortSignal: input.abortSignal,
      };

      if (input.abortSignal) {
        const handleAbort = () => {
          if (entry.contract.interruptBehavior !== "cancel") {
            return;
          }

          this.queue = this.queue.filter((queued) => queued !== entry);
          entry.cleanupAbortListener?.();
          reject(new Error(`Tool call ${input.toolName} was interrupted while waiting in the queue.`));
        };

        input.abortSignal.addEventListener("abort", handleAbort, { once: true });
        entry.cleanupAbortListener = () => {
          input.abortSignal?.removeEventListener("abort", handleAbort);
        };
      }

      this.queue.push(entry);
    });
  }

  private canStart(concurrency: ToolConcurrencyMode) {
    const activeEntries = [...this.active.values()];
    return activeEntries.length === 0 || (
      concurrency === "shared"
      && activeEntries.every((entry) => entry.concurrency === "shared")
    );
  }

  private startNow(toolCallId: string, toolName: string, concurrency: ToolConcurrencyMode) {
    this.active.set(toolCallId, { toolName, concurrency });
    this.stateMachine.markExecuting(toolCallId);

    return () => {
      this.active.delete(toolCallId);
      this.processQueue();
    };
  }

  private processQueue() {
    for (const entry of [...this.queue]) {
      if (!this.canStart(entry.contract.concurrency)) {
        if (entry.contract.concurrency === "exclusive") {
          break;
        }
        continue;
      }

      this.queue = this.queue.filter((queued) => queued !== entry);
      entry.cleanupAbortListener?.();
      entry.resolve(this.startNow(entry.toolCallId, entry.toolName, entry.contract.concurrency));
    }
  }

  applyAggregateBudget(toolName: string, result: unknown) {
    const remainingBudget = AGGREGATE_TOOL_RESULT_BUDGET_CHARS - this.aggregateResultChars;
    const budgetedResult = applyAggregateToolResultBudget(toolName, result, remainingBudget);
    this.aggregateResultChars += measureToolResultChars(budgetedResult);
    return budgetedResult;
  }
}

export function wrapToolSetWithExecutionCoordinator(
  tools: ToolSet,
  stateMachine: ToolStateMachine,
): ToolSet {
  const coordinator = new ToolExecutionCoordinator(stateMachine);
  const wrapped: ToolSet = {};

  for (const [toolName, toolDefinition] of Object.entries(tools)) {
    if (typeof toolDefinition.execute !== "function") {
      wrapped[toolName] = toolDefinition;
      continue;
    }

    wrapped[toolName] = {
      ...toolDefinition,
      execute: async (input, options: ToolExecutionOptions) => {
        const contract = getToolExecutionContract(toolName, input);
        const approvalStateTracker: ToolApprovalStateTracker = {
          onRequested: () => {
            stateMachine.markApprovalRequested(options.toolCallId);
          },
          onResolved: (status, source) => {
            if (source === "policy") {
              if (status === "rejected") {
                stateMachine.markPermissionDenied(options.toolCallId);
              }
              return;
            }
            stateMachine.markApprovalResponded(options.toolCallId, status);
            if (status === "rejected" && source === "user") {
              stateMachine.markPermissionDenied(options.toolCallId);
            }
          },
        };
        const bashProgressTracker: BashProgressTracker = {
          onProgress: (update) => {
            stateMachine.markProgress(options.toolCallId, update);
          },
        };
        const release = await coordinator.acquire({
          toolCallId: options.toolCallId,
          toolName,
          contract,
          abortSignal: options.abortSignal,
        });

        try {
          const result = await toolDefinition.execute!(input, {
            ...options,
            approvalStateTracker,
            bashProgressTracker,
          } as ToolExecutionOptions & {
            approvalStateTracker: ToolApprovalStateTracker;
            bashProgressTracker: BashProgressTracker;
          });
          const budgetedResult = applyToolResultBudget(toolName, input, result);
          return coordinator.applyAggregateBudget(toolName, budgetedResult);
        } finally {
          release();
        }
      },
    };
  }

  return wrapped;
}
