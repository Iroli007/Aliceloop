import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertCommand,
  assertCommandArguments,
  assertCwd,
  assertReadable,
  assertWritable,
  getSandboxProjectRoot,
} from "../toolPolicy";
import {
  type DeletePathInput,
  SandboxViolationError,
  type EditTextFileInput,
  type ReadTextFileInput,
  type RunBashInput,
  type SandboxElevatedApprovalInput,
  type SandboxRuntimeBackend,
  type SandboxRuntimeContext,
  type WriteBinaryFileInput,
  type WriteTextFileInput,
} from "../types";

const execFileAsync = promisify(execFile);
const projectRoot = getSandboxProjectRoot();
const tsxCliPath = resolve(projectRoot, "node_modules/tsx/dist/cli.mjs");

type HostRuntimeRunInput = {
  primitive: "read" | "write" | "edit" | "delete" | "bash";
  targetPath?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  detail: string;
};

type DeleteTargetKind = "file" | "directory";

function pickEnvironment() {
  const env: Record<string, string> = {};
  for (const key of ["ALICELOOP_DATA_DIR", "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

function summarizeBytes(length: number) {
  return `${length} bytes`;
}

function summarizeText(text: string, maxLength = 240) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "empty";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trimEnd()}…` : normalized;
}

function summarizeCommandLine(command: string, args: string[]) {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(" ").trim();
}

function buildBashApprovalFingerprint(command: string, args: string[], cwd: string) {
  return JSON.stringify({
    command,
    args,
    cwd,
  });
}

function noteBashApprovalAttempt(
  context: SandboxRuntimeContext,
  command: string,
  args: string[],
  cwd: string,
) {
  const fingerprint = buildBashApprovalFingerprint(command, args, cwd);
  if (context.seenBashApprovalFingerprints.has(fingerprint)) {
    throw new SandboxViolationError(
      `duplicate bash approval suppressed for identical command in current run: ${summarizeCommandLine(command, args)}`,
    );
  }

  context.seenBashApprovalFingerprints.add(fingerprint);
}

function resolveExecution(command: string, args: string[]) {
  if (command === "node") {
    return {
      executable: process.execPath,
      args,
    };
  }

  if (command === "tsx" && existsSync(tsxCliPath)) {
    return {
      executable: process.execPath,
      args: [tsxCliPath, ...args],
    };
  }

  return {
    executable: command,
    args,
  };
}

function canUseElevatedFallback(context: SandboxRuntimeContext, error: unknown) {
  return error instanceof SandboxViolationError
    && error.allowElevatedFallback
    && !error.message.includes("invalid command")
    && !error.message.includes("bash denied for cwd outside allowed roots")
    && context.toolPolicy.permissionProfile === "development"
    && context.toolPolicy.supportsElevatedActions
    && Boolean(context.requestElevatedApproval);
}

async function recordBlockedAttempt<T>(
  context: SandboxRuntimeContext,
  run: HostRuntimeRunInput,
  error: unknown,
  access: "standard" | "elevated" = "standard",
) {
  return context.audit.withRun<T>({
    ...run,
    access,
    execute: async () => {
      throw error;
    },
  });
}

async function withPolicyFallback<T>(input: {
  context: SandboxRuntimeContext;
  run: HostRuntimeRunInput;
  preflight: () => void | Promise<void>;
  buildElevatedApproval: () => SandboxElevatedApprovalInput;
  executeStandard: () => Promise<{ result: T; detail: string }>;
  executeElevated: () => Promise<{ result: T; detail: string }>;
}) {
  try {
    await input.preflight();
  } catch (error) {
    if (canUseElevatedFallback(input.context, error)) {
      return input.context.audit.withRun({
        ...input.run,
        access: "elevated",
        execute: async () => {
          await input.context.requestElevatedApproval!(input.buildElevatedApproval());
          return input.executeElevated();
        },
      });
    }

    return recordBlockedAttempt<T>(input.context, input.run, error);
  }

  return input.context.audit.withRun({
    ...input.run,
    access: "standard",
    execute: input.executeStandard,
  });
}

async function readTextResult(targetPath: string) {
  const content = await readFile(targetPath, "utf8");
  return {
    result: content,
    detail: `read ${targetPath} (${summarizeBytes(Buffer.byteLength(content, "utf8"))})`,
  };
}

async function writeBinaryResult(targetPath: string, content: Uint8Array) {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content);
  return {
    result: targetPath,
    detail: `wrote ${targetPath} (${summarizeBytes(content.byteLength)})`,
  };
}

async function writeTextResult(targetPath: string, content: string) {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  return {
    result: targetPath,
    detail: `wrote ${targetPath} (${summarizeBytes(Buffer.byteLength(content, "utf8"))})`,
  };
}

async function editTextResult(targetPath: string, transform: (content: string) => string) {
  const before = await readFile(targetPath, "utf8");
  const after = transform(before);
  await writeFile(targetPath, after, "utf8");
  return {
    result: after,
    detail: `edited ${targetPath} (${summarizeText(after)})`,
  };
}

async function noteCreatedFile(context: SandboxRuntimeContext, targetPath: string, createdNew: boolean) {
  if (!createdNew || !context.noteCreatedFile) {
    return;
  }

  await context.noteCreatedFile(targetPath);
}

async function resolveDeleteTargetKind(targetPath: string): Promise<DeleteTargetKind> {
  let stats;
  try {
    stats = await lstat(targetPath);
  } catch {
    throw new SandboxViolationError(
      `delete denied for missing path: ${targetPath}`,
      { allowElevatedFallback: false },
    );
  }

  if (stats.isDirectory()) {
    return "directory";
  }

  return "file";
}

async function validateDeletePath(context: SandboxRuntimeContext, targetPath: string) {
  const kind = await resolveDeleteTargetKind(targetPath);
  if (context.toolPolicy.fullAccess) {
    return kind;
  }

  if (kind === "directory") {
    const entries = await readdir(targetPath);
    if (entries.length > 0) {
      throw new SandboxViolationError(
        `delete denied for non-empty directory: ${targetPath}; rm/rmdir only removes empty directories in sandbox mode`,
        { allowElevatedFallback: false },
      );
    }
    assertWritable(context.toolPolicy, targetPath);
    return kind;
  }

  const canDeleteFile = await context.canDeleteFile?.(targetPath) ?? false;
  if (!canDeleteFile) {
    throw new SandboxViolationError(
      `delete denied for file not previously generated by Aliceloop: ${targetPath}`,
      { allowElevatedFallback: false },
    );
  }

  assertWritable(context.toolPolicy, targetPath);
  return kind;
}

async function deletePathResult(
  context: SandboxRuntimeContext,
  targetPath: string,
  kind: DeleteTargetKind,
) {
  if (kind === "directory") {
    if (context.toolPolicy.fullAccess) {
      await rm(targetPath, {
        force: false,
        recursive: true,
      });
    } else {
      await rmdir(targetPath);
    }
  } else {
    await rm(targetPath, {
      force: false,
      recursive: false,
    });
  }
  if (kind === "file") {
    await context.noteDeletedFile?.(targetPath);
  }
  return {
    result: targetPath,
    detail: kind === "directory"
      ? `removed empty directory ${targetPath}`
      : `removed generated file ${targetPath}`,
  };
}

async function executeBashResult(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxBufferBytes: number,
) {
  const execution = resolveExecution(command, args);
  const { stdout, stderr } = await execFileAsync(execution.executable, execution.args, {
    cwd,
    timeout: timeoutMs,
    env: pickEnvironment(),
    maxBuffer: maxBufferBytes,
  });
  return {
    result: {
      stdout,
      stderr,
    },
    detail: `bash ${command} completed; stdout=${summarizeText(stdout)}; stderr=${summarizeText(stderr)}`,
  };
}

function createFileElevatedApproval(
  toolName: SandboxElevatedApprovalInput["toolName"],
  title: string,
  actionLabel: string,
  targetPath: string,
): SandboxElevatedApprovalInput {
  const syntheticCommand = toolName.replace("sandbox_", "");
  return {
    toolName,
    title,
    detail: `开发模式下，这次${actionLabel}超出了默认权限范围。确认后只放行这一次${actionLabel}。`,
    commandLine: `${syntheticCommand} ${targetPath}`,
    command: syntheticCommand,
    args: [targetPath],
    cwd: dirname(targetPath),
  };
}

function createBashElevatedApproval(command: string, args: string[], cwd: string): SandboxElevatedApprovalInput {
  return {
    toolName: "sandbox_bash",
    title: "等待确认 Elevated bash",
    detail: "开发模式下，这条命令超出了默认权限范围。确认后只放行这一次执行。",
    commandLine: summarizeCommandLine(command, args),
    command,
    args,
    cwd,
  };
}

async function readTextFile(context: SandboxRuntimeContext, input: ReadTextFileInput) {
  const targetPath = resolve(input.targetPath);
  return withPolicyFallback({
    context,
    run: {
      primitive: "read",
      targetPath,
      detail: `reading ${targetPath}`,
    },
    preflight() {
      assertReadable(context.toolPolicy, targetPath);
    },
    buildElevatedApproval() {
      return createFileElevatedApproval("sandbox_read", "等待确认 Elevated 读取", "读取", targetPath);
    },
    async executeStandard() {
      assertReadable(context.toolPolicy, targetPath);
      return readTextResult(targetPath);
    },
    async executeElevated() {
      return readTextResult(targetPath);
    },
  });
}

async function writeBinaryFile(context: SandboxRuntimeContext, input: WriteBinaryFileInput) {
  const targetPath = resolve(input.targetPath);
  const createdNew = !existsSync(targetPath);
  return withPolicyFallback({
    context,
    run: {
      primitive: "write",
      targetPath,
      detail: `writing binary file ${targetPath}`,
    },
    preflight() {
      assertWritable(context.toolPolicy, targetPath);
    },
    buildElevatedApproval() {
      return createFileElevatedApproval("sandbox_write", "等待确认 Elevated 写入", "写入", targetPath);
    },
    async executeStandard() {
      assertWritable(context.toolPolicy, targetPath);
      const result = await writeBinaryResult(targetPath, input.content);
      await noteCreatedFile(context, targetPath, createdNew);
      return result;
    },
    async executeElevated() {
      const result = await writeBinaryResult(targetPath, input.content);
      await noteCreatedFile(context, targetPath, createdNew);
      return result;
    },
  });
}

async function writeTextFile(context: SandboxRuntimeContext, input: WriteTextFileInput) {
  const targetPath = resolve(input.targetPath);
  const createdNew = !existsSync(targetPath);
  return withPolicyFallback({
    context,
    run: {
      primitive: "write",
      targetPath,
      detail: `writing text file ${targetPath}`,
    },
    preflight() {
      assertWritable(context.toolPolicy, targetPath);
    },
    buildElevatedApproval() {
      return createFileElevatedApproval("sandbox_write", "等待确认 Elevated 写入", "写入", targetPath);
    },
    async executeStandard() {
      assertWritable(context.toolPolicy, targetPath);
      const result = await writeTextResult(targetPath, input.content);
      await noteCreatedFile(context, targetPath, createdNew);
      return result;
    },
    async executeElevated() {
      const result = await writeTextResult(targetPath, input.content);
      await noteCreatedFile(context, targetPath, createdNew);
      return result;
    },
  });
}

async function editTextFile(context: SandboxRuntimeContext, input: EditTextFileInput) {
  const targetPath = resolve(input.targetPath);
  return withPolicyFallback({
    context,
    run: {
      primitive: "edit",
      targetPath,
      detail: `editing text file ${targetPath}`,
    },
    preflight() {
      assertReadable(context.toolPolicy, targetPath);
      assertWritable(context.toolPolicy, targetPath);
    },
    buildElevatedApproval() {
      return createFileElevatedApproval("sandbox_edit", "等待确认 Elevated 编辑", "编辑", targetPath);
    },
    async executeStandard() {
      assertReadable(context.toolPolicy, targetPath);
      assertWritable(context.toolPolicy, targetPath);
      return editTextResult(targetPath, input.transform);
    },
    async executeElevated() {
      return editTextResult(targetPath, input.transform);
    },
  });
}

async function deletePath(context: SandboxRuntimeContext, input: DeletePathInput) {
  const targetPath = resolve(input.targetPath);
  return withPolicyFallback({
    context,
    run: {
      primitive: "delete",
      targetPath,
      detail: `deleting ${targetPath}`,
    },
    async preflight() {
      await validateDeletePath(context, targetPath);
    },
    buildElevatedApproval() {
      return createFileElevatedApproval("sandbox_delete", "等待确认 Elevated 删除", "删除", targetPath);
    },
    async executeStandard() {
      const kind = await validateDeletePath(context, targetPath);
      return deletePathResult(context, targetPath, kind);
    },
    async executeElevated() {
      const kind = await validateDeletePath(context, targetPath);
      return deletePathResult(context, targetPath, kind);
    },
  });
}

async function runBashAsDelete(context: SandboxRuntimeContext, command: string, args: string[], cwd: string) {
  const pathArgs = args.filter((arg) => arg && !arg.startsWith("-"));
  if (pathArgs.length === 0) {
    throw new SandboxViolationError(
      `bash rm/rmdir denied: no target path provided`,
      { allowElevatedFallback: false },
    );
  }

  const results: string[] = [];
  for (const rawPath of pathArgs) {
    const targetPath = resolve(cwd, rawPath);
    const kind = await validateDeletePath(context, targetPath);
    await context.audit.withRun({
      primitive: "delete" as const,
      targetPath,
      command,
      args,
      cwd,
      access: "standard",
      detail: `${command} ${rawPath} (via sandbox_bash)`,
      async execute() {
        const r = await deletePathResult(context, targetPath, kind);
        results.push(r.result);
        return r;
      },
    });
  }

  return {
    stdout: results.map((p) => `deleted: ${p}`).join("\n") + "\n",
    stderr: "",
  };
}

async function runBash(context: SandboxRuntimeContext, input: RunBashInput) {
  const command = input.command.trim();
  const args = input.args ?? [];
  const cwd = resolve(input.cwd ?? projectRoot);
  const timeoutMs = Math.max(250, Math.min(input.timeoutMs ?? context.defaultTimeoutMs, 60_000));

  if (command === "rm" || command === "rmdir") {
    return runBashAsDelete(context, command, args, cwd);
  }

  return withPolicyFallback({
    context,
    run: {
      primitive: "bash",
      command,
      args,
      cwd,
      detail: `running ${command} ${args.join(" ")}`.trim(),
    },
    preflight() {
      assertCommand(context.toolPolicy, command);
      if (command !== "ls") {
        assertCwd(context.toolPolicy, cwd);
      }
      assertCommandArguments(context.toolPolicy, {
        command,
        args,
        cwd,
      });
    },
    buildElevatedApproval() {
      noteBashApprovalAttempt(context, command, args, cwd);
      return createBashElevatedApproval(command, args, cwd);
    },
    async executeStandard() {
      assertCommand(context.toolPolicy, command);
      if (command !== "ls") {
        assertCwd(context.toolPolicy, cwd);
      }
      assertCommandArguments(context.toolPolicy, {
        command,
        args,
        cwd,
      });
      if (!context.toolPolicy.fullAccess && context.requestBashApproval) {
        noteBashApprovalAttempt(context, command, args, cwd);
        await context.requestBashApproval({
          command,
          args,
          cwd,
        });
      }
      return executeBashResult(command, args, cwd, timeoutMs, context.maxBufferBytes);
    },
    async executeElevated() {
      return executeBashResult(command, args, cwd, timeoutMs, context.maxBufferBytes);
    },
  });
}

export function createHostSandboxRuntime(): SandboxRuntimeBackend {
  return {
    kind: "host",
    readTextFile,
    writeBinaryFile,
    writeTextFile,
    editTextFile,
    deletePath,
    runBash,
  };
}
