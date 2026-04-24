import type {
  SandboxExecutionAccess,
  SandboxPermissionProfile,
  SandboxPrimitive,
  SandboxRun,
} from "@aliceloop/runtime-core";

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
  sessionId?: string | null;
  permissionProfile?: SandboxPermissionProfile;
  autoApproveToolRequests?: boolean;
  workspaceRoot?: string;
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
  canDeleteFile?: (targetPath: string) => Promise<boolean> | boolean;
  noteDeletedFile?: (targetPath: string) => Promise<void> | void;
}

export interface SandboxElevatedApprovalInput {
  toolName: string;
  title: string;
  detail: string;
  commandLine: string;
  command: string;
  args: string[];
  cwd: string;
}

export interface ReadTextFileInput {
  targetPath: string;
}

export interface WriteBinaryFileInput {
  targetPath: string;
  content: Uint8Array;
}

export interface WriteTextFileInput {
  targetPath: string;
  content: string;
}

export interface EditTextFileInput {
  targetPath: string;
  transform: (content: string) => string;
}

export interface DeletePathInput {
  targetPath: string;
}

export interface RunBashInput {
  command: string;
  args?: string[];
  script?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ParsedBashCommand {
  command: string;
  args: string[];
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
  sessionId: string | null;
  toolPolicy: SandboxToolPolicy;
  runtimePolicy: SandboxRuntimePolicy;
  autoApproveToolRequests: boolean;
  defaultCwd: string | null;
  audit: SandboxAuditLogger;
  defaultTimeoutMs: number;
  maxBufferBytes: number;
  seatbeltEnabled: boolean;
  seenBashApprovalFingerprints: Set<string>;
  requestBashApproval?: (input: { command: string; args: string[]; cwd: string }) => Promise<void>;
  requestElevatedApproval?: (input: SandboxElevatedApprovalInput) => Promise<void>;
  noteCreatedFile?: (targetPath: string) => Promise<void> | void;
  canDeleteFile?: (targetPath: string) => Promise<boolean> | boolean;
  noteDeletedFile?: (targetPath: string) => Promise<void> | void;
}

export interface SandboxRuntimeBackend {
  kind: SandboxRuntimeKind;
  readTextFile(context: SandboxRuntimeContext, input: ReadTextFileInput): Promise<string>;
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
