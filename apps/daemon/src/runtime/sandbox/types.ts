import type {
  SandboxExecutionAccess,
  SandboxPermissionProfile,
  SandboxPrimitive,
  SandboxRun,
} from "@aliceloop/runtime-core";
import type { ParsedBashRedirect } from "./bashAst";

export class SandboxViolationError extends Error {
  allowElevatedFallback: boolean;

  constructor(message: string, options?: { allowElevatedFallback?: boolean }) {
    super(message);
    this.name = "SandboxViolationError";
    this.allowElevatedFallback = options?.allowElevatedFallback ?? true;
  }
}

export type SandboxRuntimeKind = "host";

export interface SandboxExecutorOptions {
  label: string;
  permissionProfile?: SandboxPermissionProfile;
  autoApproveToolRequests?: boolean;
  workspaceRoot?: string;
  keepFilesystemBoundaryInFullAccess?: boolean;
  supportsElevatedActionsInFullAccess?: boolean;
  defaultCwd?: string;
  extraReadRoots?: string[];
  extraWriteRoots?: string[];
  extraCwdRoots?: string[];
  allowedCommands?: string[];
  defaultTimeoutMs?: number;
  maxBufferBytes?: number;
  requestBashApproval?: (input: { command: string; args: string[]; cwd: string }) => Promise<void>;
  requestElevatedApproval?: (input: SandboxElevatedApprovalInput) => Promise<void>;
  noteCreatedFile?: (targetPath: string) => Promise<void> | void;
  noteDeletedFile?: (targetPath: string) => Promise<void> | void;
}

export interface SandboxElevatedApprovalInput {
  toolCallId?: string;
  toolName: string;
  title: string;
  detail: string;
  commandLine: string;
  command: string;
  args: string[];
  cwd: string;
  approvalStateTracker?: ToolApprovalStateTracker;
}

export interface ToolApprovalStateTracker {
  onRequested?: () => void;
  onResolved?: (status: "approved" | "rejected", source: "user" | "abort" | "policy") => void;
}

export interface BashProgressUpdate {
  stdout: string;
  stderr: string;
  streaming: true;
  truncated?: boolean;
}

export interface BashProgressTracker {
  onProgress?: (update: BashProgressUpdate) => void;
}

export interface ReadTextFileInput {
  targetPath: string;
  toolCallId?: string;
  approvalStateTracker?: ToolApprovalStateTracker;
}

export interface ReadTextFileWindowInput {
  targetPath: string;
  offset?: number;
  limit?: number;
  toolCallId?: string;
  approvalStateTracker?: ToolApprovalStateTracker;
}

export interface ReadTextFileWindowResult {
  content: string;
  totalLines: number;
}

export interface WriteBinaryFileInput {
  targetPath: string;
  content: Uint8Array;
  toolCallId?: string;
  approvalStateTracker?: ToolApprovalStateTracker;
}

export interface WriteTextFileInput {
  targetPath: string;
  content: string;
  toolCallId?: string;
  approvalStateTracker?: ToolApprovalStateTracker;
}

export interface EditTextFileInput {
  targetPath: string;
  transform: (content: string) => string;
  toolCallId?: string;
  approvalStateTracker?: ToolApprovalStateTracker;
}

export interface DeletePathInput {
  targetPath: string;
  toolCallId?: string;
  approvalStateTracker?: ToolApprovalStateTracker;
}

export interface RunBashInput {
  command: string;
  args?: string[];
  script?: string;
  cwd?: string;
  timeoutMs?: number;
  toolCallId?: string;
  approvalStateTracker?: ToolApprovalStateTracker;
  progressTracker?: BashProgressTracker;
}

export interface ParsedBashCommand {
  command: string;
  args: string[];
  redirects?: ParsedBashRedirect[];
}

export interface NormalizedBashPolicyInput {
  cwd: string;
  command: string | null;
  args: string[];
  script: string | null;
  scriptCommands: ParsedBashCommand[];
}

export interface SandboxToolPolicy {
  label: string;
  permissionProfile: SandboxPermissionProfile;
  fullAccess: boolean;
  elevatedAccess: SandboxExecutionAccess;
  supportsElevatedActions: boolean;
  requiresBashApproval: boolean;
  allowedReadRoots: string[] | null;
  allowedWriteRoots: string[] | null;
  allowedCwdRoots: string[] | null;
  allowedCommands: string[];
}

export interface SandboxRuntimePolicy {
  preferredRuntime: SandboxRuntimeKind;
  allowHostFallback: boolean;
  reason: string;
}

export interface SandboxRunExecution<T> {
  primitive: SandboxPrimitive;
  access?: SandboxExecutionAccess;
  targetPath?: string | null;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  detail: string;
  execute: () => Promise<{ result: T; detail: string }>;
}

export interface SandboxAuditLogger {
  withRun<T>(input: SandboxRunExecution<T>): Promise<T>;
}

export interface SandboxRuntimeContext {
  label: string;
  toolPolicy: SandboxToolPolicy;
  runtimePolicy: SandboxRuntimePolicy;
  autoApproveToolRequests: boolean;
  defaultCwd: string | null;
  audit: SandboxAuditLogger;
  defaultTimeoutMs: number;
  maxBufferBytes: number;
  seatbeltEnabled: boolean;
  seenBashApprovalFingerprints: Set<string>;
  requestBashApproval?: (input: {
    command: string;
    args: string[];
    cwd: string;
    toolCallId?: string;
    approvalStateTracker?: ToolApprovalStateTracker;
  }) => Promise<void>;
  requestElevatedApproval?: (input: SandboxElevatedApprovalInput) => Promise<void>;
  noteCreatedFile?: (targetPath: string) => Promise<void> | void;
  noteDeletedFile?: (targetPath: string) => Promise<void> | void;
}

export interface SandboxRuntimeBackend {
  kind: SandboxRuntimeKind;
  readTextFile(context: SandboxRuntimeContext, input: ReadTextFileInput): Promise<string>;
  readTextFileWindow(
    context: SandboxRuntimeContext,
    input: ReadTextFileWindowInput,
  ): Promise<ReadTextFileWindowResult>;
  writeBinaryFile(context: SandboxRuntimeContext, input: WriteBinaryFileInput): Promise<string>;
  writeTextFile(context: SandboxRuntimeContext, input: WriteTextFileInput): Promise<string>;
  editTextFile(context: SandboxRuntimeContext, input: EditTextFileInput): Promise<string>;
  deletePath(context: SandboxRuntimeContext, input: DeletePathInput): Promise<string>;
  runBash(
    context: SandboxRuntimeContext,
    input: RunBashInput,
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface PermissionSandboxExecutor {
  readTextFile(input: ReadTextFileInput): Promise<string>;
  readTextFileWindow(input: ReadTextFileWindowInput): Promise<ReadTextFileWindowResult>;
  writeBinaryFile(input: WriteBinaryFileInput): Promise<string>;
  writeTextFile(input: WriteTextFileInput): Promise<string>;
  editTextFile(input: EditTextFileInput): Promise<string>;
  deletePath(input: DeletePathInput): Promise<string>;
  runBash(input: RunBashInput): Promise<{ stdout: string; stderr: string }>;
  describePolicy(): {
    label: string;
    permissionProfile: SandboxPermissionProfile;
    runtimeKind: SandboxRuntimeKind;
    runtimeReason: string;
    requiresBashApproval: boolean;
    elevatedAccess: SandboxExecutionAccess;
    supportsElevatedActions: boolean;
    allowedReadRoots: string[];
    allowedWriteRoots: string[];
    allowedCwdRoots: string[];
    defaultCwd: string | null;
    allowedCommands: string[];
    warnings: string[];
  };
}

export type { SandboxRun };
