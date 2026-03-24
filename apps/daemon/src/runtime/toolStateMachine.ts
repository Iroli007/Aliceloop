/**
 * Tool Call State Machine
 * 
 * 管理工具调用的完整生命周期，支持 approval 流程。
 * 
 * 状态流转:
 *   input-streaming → input-available → approval-requested (可选) → output-available → done
 *                                         ↓
 *                                    permission-denied
 */

export type ToolCallStatus =
  | "input-streaming"   // 输入正在流式传输
  | "input-available"    // 输入已完成
  | "approval-requested" // 等待用户批准
  | "approval-responded" // 用户已响应
  | "output-available"  // 输出可用
  | "output-error"      // 执行出错
  | "permission-denied" // 权限拒绝
  | "done";            // 完成

export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: ToolCallStatus;
  output?: unknown;
  error?: string;
  approvalOption?: string;  // 批准选项 (allow_once, deny_once, etc.)
  createdAt: number;
  updatedAt: number;
}

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  input: unknown;
  options: ApprovalOption[];
}

export interface ApprovalOption {
  kind: "allow_once" | "deny_once" | "allow_always" | "deny_always";
  label: string;
  optionId: string;
}

export type ToolStateChangeHandler = (state: ToolCallState) => void;
export type ApprovalRequestHandler = (request: ApprovalRequest) => Promise<string>; // 返回 optionId

export class ToolStateMachine {
  private states = new Map<string, ToolCallState>();
  private changeHandlers: ToolStateChangeHandler[] = [];
  private approvalHandler?: ApprovalRequestHandler;

  onStateChange(handler: ToolStateChangeHandler) {
    this.changeHandlers.push(handler);
  }

  setApprovalHandler(handler: ApprovalRequestHandler) {
    this.approvalHandler = handler;
  }

  private emit(state: ToolCallState) {
    this.states.set(state.toolCallId, state);
    for (const handler of this.changeHandlers) {
      handler(state);
    }
  }

  start(toolCallId: string, toolName: string, input: unknown): ToolCallState {
    const state: ToolCallState = {
      toolCallId: toolCallId,
      toolName,
      input,
      status: "input-streaming",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.emit(state);
    return state;
  }

  markInputAvailable(toolCallId: string): ToolCallState | null {
    const state = this.states.get(toolCallId);
    if (!state) return null;

    const updated: ToolCallState = {
      ...state,
      status: "input-available",
      updatedAt: Date.now(),
    };
    this.emit(updated);
    return updated;
  }

  async requestApproval(toolCallId: string): Promise<ToolCallState | null> {
    const state = this.states.get(toolCallId);
    if (!state || !this.approvalHandler) return null;

    const request: ApprovalRequest = {
      toolCallId,
      toolName: state.toolName,
      input: state.input,
      options: [
        { kind: "allow_once", label: "Allow this time", optionId: "allow_once" },
        { kind: "deny_once", label: "Deny this time", optionId: "deny_once" },
      ],
    };

    const optionId = await this.approvalHandler(request);

    const updated: ToolCallState = {
      ...state,
      status: "approval-responded",
      approvalOption: optionId,
      updatedAt: Date.now(),
    };
    this.emit(updated);
    return updated;
  }

  markPermissionDenied(toolCallId: string): ToolCallState | null {
    const state = this.states.get(toolCallId);
    if (!state) return null;

    const updated: ToolCallState = {
      ...state,
      status: "permission-denied",
      updatedAt: Date.now(),
    };
    this.emit(updated);
    return updated;
  }

  markOutputAvailable(toolCallId: string, output: unknown): ToolCallState | null {
    const state = this.states.get(toolCallId);
    if (!state) return null;

    const updated: ToolCallState = {
      ...state,
      status: "output-available",
      output,
      updatedAt: Date.now(),
    };
    this.emit(updated);
    return updated;
  }

  markError(toolCallId: string, error: unknown): ToolCallState | null {
    const state = this.states.get(toolCallId);
    if (!state) return null;

    const updated: ToolCallState = {
      ...state,
      status: "output-error",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    };
    this.emit(updated);
    return updated;
  }

  complete(toolCallId: string): ToolCallState | null {
    const state = this.states.get(toolCallId);
    if (!state) return null;

    const updated: ToolCallState = {
      ...state,
      status: "done",
      updatedAt: Date.now(),
    };
    this.emit(updated);
    return updated;
  }

  get(toolCallId: string): ToolCallState | undefined {
    return this.states.get(toolCallId);
  }

  getAll(): ToolCallState[] {
    return [...this.states.values()];
  }

  clear() {
    this.states.clear();
  }

  // 检查是否需要 approval
  needsApproval(toolName: string): boolean {
    const dangerousTools = ["bash", "edit", "write", "delete"];
    return dangerousTools.includes(toolName);
  }
}
