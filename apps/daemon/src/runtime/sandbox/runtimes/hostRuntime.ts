import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getDataDir } from "../../../db/client";
import {
  assertBashExecution,
  parseShellScriptCommandsForPolicy,
  assertReadable,
  assertWritable,
  getSandboxProjectRoot,
} from "../toolPolicy";
import { buildSeatbeltProfile, isSeatbeltAvailable, wrapWithSeatbelt } from "../seatbelt";
import {
  type DeletePathInput,
  type NormalizedBashPolicyInput,
  SandboxViolationError,
  type EditTextFileInput,
  type ReadTextFileInput,
  type RunBashInput,
  type SandboxElevatedApprovalInput,
  type BashProgressTracker,
  type SandboxRuntimeBackend,
  type SandboxRuntimeContext,
  type WriteBinaryFileInput,
  type WriteTextFileInput,
} from "../types";
const require = createRequire(import.meta.url);
const projectRoot = getSandboxProjectRoot();
const tsxCliPath = (() => {
  try {
    return require.resolve("tsx/dist/cli.mjs");
  } catch {
    return resolve(projectRoot, "node_modules/tsx/dist/cli.mjs");
  }
})();
const daemonServerEntryPath = (() => {
  try {
    return require.resolve("@aliceloop/daemon/server");
  } catch {
    return null;
  }
})();
const daemonDistRoot = daemonServerEntryPath ? dirname(daemonServerEntryPath) : null;
const daemonPackageRoot = daemonDistRoot ? resolve(daemonDistRoot, "..") : resolve(projectRoot, "apps/daemon");
const daemonDistCliPath = daemonDistRoot ? resolve(daemonDistRoot, "cli/index.js") : resolve(daemonPackageRoot, "dist/cli/index.js");
const daemonSourceCliPath = resolve(daemonPackageRoot, "src/cli/index.ts");
const runtimeBinDir = resolve(getDataDir(), "runtime-bin");
const aliceloopShimPath = resolve(runtimeBinDir, "aliceloop");

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
  for (const key of [
    "ALICELOOP_DAEMON_HOST",
    "ALICELOOP_DAEMON_PORT",
    "ALICELOOP_DAEMON_URL",
    "ALICELOOP_DATA_DIR",
    "ALICELOOP_DEFAULT_WORKSPACE_DIR",
    "ALICELOOP_PROMPTS_DIR",
    "ALICELOOP_RUNTIME_SCRIPTS_DIR",
    "ALICELOOP_SKILLS_DIR",
    "ELECTRON_RUN_AS_NODE",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "USER",
  ]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  const shimDir = ensureAliceloopCliShimDir();
  if (shimDir) {
    const currentPath = env.PATH?.trim();
    env.PATH = currentPath ? `${shimDir}:${currentPath}` : shimDir;
  }

  if (process.versions.electron && !env.ELECTRON_RUN_AS_NODE) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  return env;
}

function resolveAliceloopCliArgs(args: string[]) {
  if (existsSync(daemonDistCliPath)) {
    return [daemonDistCliPath, ...args];
  }

  if (existsSync(daemonSourceCliPath) && existsSync(tsxCliPath)) {
    return [tsxCliPath, daemonSourceCliPath, ...args];
  }

  return null;
}

function ensureAliceloopCliShimDir() {
  const cliArgs = resolveAliceloopCliArgs([]);
  if (!cliArgs) {
    return null;
  }

  mkdirSync(runtimeBinDir, { recursive: true });
  const shimContent = [
    "#!/bin/sh",
    `exec "${process.execPath}" ${cliArgs.map((arg) => `"${arg}"`).join(" ")} "$@"`,
    "",
  ].join("\n");

  if (!existsSync(aliceloopShimPath)) {
    writeFileSync(aliceloopShimPath, shimContent, "utf8");
    chmodSync(aliceloopShimPath, 0o755);
    return runtimeBinDir;
  }

  const currentContent = readFileSyncSafe(aliceloopShimPath);
  if (currentContent !== shimContent) {
    writeFileSync(aliceloopShimPath, shimContent, "utf8");
    chmodSync(aliceloopShimPath, 0o755);
  }

  return runtimeBinDir;
}

function readFileSyncSafe(filePath: string) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
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

function tailText(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(-maxLength);
}

function summarizeCommandLine(command: string, args: string[]) {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(" ").trim();
}

function summarizeShellScript(script: string) {
  const normalized = script.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 240).trimEnd()}…` : normalized;
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

async function requestDeleteApproval(
  context: SandboxRuntimeContext,
  input: {
    toolCallId?: string;
    title: string;
    detail: string;
    commandLine: string;
    command: string;
    args: string[];
    cwd: string;
    approvalStateTracker?: SandboxElevatedApprovalInput["approvalStateTracker"];
  },
) {
  if (!context.requestElevatedApproval) {
    return;
  }

  await context.requestElevatedApproval({
    toolCallId: input.toolCallId,
    toolName: "delete",
    title: input.title,
    detail: input.detail,
    commandLine: input.commandLine,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    approvalStateTracker: input.approvalStateTracker,
  });
}

function resolveExecution(command: string, args: string[]) {
  if (command === "node") {
    return {
      executable: process.execPath,
      args,
    };
  }

  if (command === "aliceloop") {
    const cliArgs = resolveAliceloopCliArgs(args);
    if (cliArgs) {
      return {
        executable: process.execPath,
        args: cliArgs,
      };
    }
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
    && (context.autoApproveToolRequests || Boolean(context.requestElevatedApproval));
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
          if (!input.context.autoApproveToolRequests && input.context.requestElevatedApproval) {
            await input.context.requestElevatedApproval!(input.buildElevatedApproval());
          }
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
    assertWritable(context.toolPolicy, targetPath);
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
  try {
    await lstat(targetPath);
    throw new Error(`delete completed but target still exists: ${targetPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw error;
    }
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
  seatbeltProfile: string | null = null,
  progressTracker?: BashProgressTracker,
) {
  let execution = resolveExecution(command, args);
  if (seatbeltProfile) {
    execution = wrapWithSeatbelt(execution.executable, execution.args, seatbeltProfile);
  }
  const { stdout, stderr } = await executeBashProcessResult(
    execution.executable,
    execution.args,
    cwd,
    timeoutMs,
    maxBufferBytes,
    progressTracker,
  );
  return {
    result: {
      stdout,
      stderr,
    },
    detail: `bash ${command} completed; stdout=${summarizeText(stdout)}; stderr=${summarizeText(stderr)}`,
  };
}

async function executeBashScriptResult(
  script: string,
  cwd: string,
  timeoutMs: number,
  maxBufferBytes: number,
  seatbeltProfile: string | null = null,
  progressTracker?: BashProgressTracker,
) {
  let execution = {
    executable: "/bin/sh",
    args: ["-lc", script],
  };
  if (seatbeltProfile) {
    execution = wrapWithSeatbelt(execution.executable, execution.args, seatbeltProfile);
  }
  const { stdout, stderr } = await executeBashProcessResult(
    execution.executable,
    execution.args,
    cwd,
    timeoutMs,
    maxBufferBytes,
    progressTracker,
  );
  return {
    result: {
      stdout,
      stderr,
    },
    detail: `bash script completed; stdout=${summarizeText(stdout)}; stderr=${summarizeText(stderr)}`,
  };
}

async function executeBashProcessResult(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxBufferBytes: number,
  progressTracker?: BashProgressTracker,
) {
  const child = spawn(executable, args, {
    cwd,
    env: pickEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;
  let bufferExceeded = false;
  let lastProgressAt = 0;
  let lastProgressKey = "";
  const startedAt = Date.now();

  const emitProgress = (force = false) => {
    if (!progressTracker?.onProgress) {
      return;
    }
    if (!force && Date.now() - startedAt < 2_000) {
      return;
    }
    if (!stdout && !stderr) {
      return;
    }

    const progressStdout = tailText(stdout, 4_000);
    const progressStderr = tailText(stderr, 4_000);
    const progressKey = `${progressStdout.length}:${progressStderr.length}:${stdout.length}:${stderr.length}`;
    if (!force && progressKey === lastProgressKey) {
      return;
    }

    lastProgressKey = progressKey;
    lastProgressAt = Date.now();
    progressTracker.onProgress({
      stdout: progressStdout,
      stderr: progressStderr,
      streaming: true,
      truncated: progressStdout.length !== stdout.length || progressStderr.length !== stderr.length,
    });
  };

  const progressTimer = setTimeout(() => {
    emitProgress(true);
  }, 2_000);

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  const checkBufferLimit = () => {
    const totalBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    if (totalBytes <= maxBufferBytes) {
      return;
    }
    bufferExceeded = true;
    child.kill("SIGTERM");
  };

  return await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(progressTimer);
      clearTimeout(timeoutHandle);
      callback();
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      checkBufferLimit();
      if (Date.now() - lastProgressAt >= 300) {
        emitProgress();
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      checkBufferLimit();
      if (Date.now() - lastProgressAt >= 300) {
        emitProgress();
      }
    });

    child.once("error", (error) => {
      finalize(() => {
        rejectPromise(error);
      });
    });

    child.once("close", (code, signal) => {
      finalize(() => {
        if (timedOut) {
          rejectPromise(new Error(`Command timed out after ${timeoutMs}ms.`));
          return;
        }
        if (bufferExceeded) {
          rejectPromise(new Error(`Command output exceeded ${maxBufferBytes} bytes.`));
          return;
        }
        if (code === 0) {
          resolvePromise({ stdout, stderr });
          return;
        }

        const detail = stderr.trim() || stdout.trim() || (signal ? `Command terminated by ${signal}.` : `Command exited with code ${code ?? "unknown"}.`);
        rejectPromise(new Error(detail));
      });
    });
  });
}

function buildSeatbeltProfileForContext(context: SandboxRuntimeContext): string | null {
  if (!context.seatbeltEnabled) {
    return null;
  }
  return buildSeatbeltProfile({
    allowedWriteRoots: context.toolPolicy.allowedWriteRoots ?? [],
    allowedReadRoots: context.toolPolicy.allowedReadRoots ?? [],
    denyNetwork: context.toolPolicy.permissionProfile === "development",
  });
}

const seatbeltBypassCommands = new Set([
  "lsof",
  "ping",
  "top",
]);

function shouldBypassSeatbeltForCommand(context: SandboxRuntimeContext, command: string) {
  return context.toolPolicy.permissionProfile === "development" && seatbeltBypassCommands.has(command);
}

function shouldBypassSeatbeltForScript(
  context: SandboxRuntimeContext,
  commands: Array<{ command: string; args: string[] }>,
) {
  return context.toolPolicy.permissionProfile === "development"
    && commands.some(({ command }) => seatbeltBypassCommands.has(command));
}

function createFileElevatedApproval(
  toolName: SandboxElevatedApprovalInput["toolName"],
  title: string,
  actionLabel: string,
  targetPath: string,
): SandboxElevatedApprovalInput {
  const syntheticCommand = toolName;
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
    toolName: "bash",
    title: "等待确认 Elevated bash",
    detail: "开发模式下，这条命令超出了默认权限范围。确认后只放行这一次执行。",
    commandLine: summarizeCommandLine(command, args),
    command,
    args,
    cwd,
  };
}

const destructiveShellCommandPattern = /(?:^|[;&|(){}])\s*(?:sudo\s+)?(?:rm|rmdir|unlink|trash|srm|shred)\b/;
const destructiveFindPattern = /\bfind\b[\s\S]*?(?:\B-delete\b|\b-exec(?:dir)?\b[\s\S]*?(?:\brm\b|\brmdir\b|\bunlink\b|\btrash\b|\bsrm\b|\bshred\b))/i;
const destructiveGitPattern = /\bgit\b[\s\S]*?\b(?:rm\b|clean\b[\s\S]*?(?:\b-f\b|--force))/i;
const destructiveScriptApiPattern = /\b(?:fs|node:fs)\.(?:rmSync|unlinkSync|rm|unlink)\b|\b(?:os|path)\.(?:remove|unlink)\b|\bshutil\.rmtree\b|\bPath\.unlink\b/;

function getFirstNonFlagArgument(args: string[]) {
  return args.find((arg) => arg && !arg.startsWith("-")) ?? null;
}

function isDeleteLikeGitInvocation(args: string[]) {
  const subcommand = getFirstNonFlagArgument(args);
  if (subcommand === "rm") {
    return true;
  }

  if (subcommand !== "clean") {
    return false;
  }

  return args.some((arg) => arg === "-f" || arg === "--force" || arg === "-fd" || arg === "-df");
}

function isDeleteLikeFindInvocation(args: string[]) {
  if (args.includes("-delete")) {
    return true;
  }

  if (!args.some((arg) => arg === "-exec" || arg === "-execdir")) {
    return false;
  }

  return args.some((arg) => /(?:^|[;&|(){}])\s*(?:sudo\s+)?(?:rm|rmdir|unlink|trash|srm|shred)\b/.test(arg));
}

function isDeleteLikeScriptInvocation(command: string, args: string[]) {
  const scriptText = args.filter((arg) => arg && !arg.startsWith("-")).join(" ").trim();
  if (!scriptText) {
    return false;
  }

  if (destructiveShellCommandPattern.test(scriptText)) {
    return true;
  }

  if (destructiveFindPattern.test(scriptText)) {
    return true;
  }

  if (destructiveGitPattern.test(scriptText)) {
    return true;
  }

  return destructiveScriptApiPattern.test(scriptText);
}

function isDeleteLikeWrappedInvocation(args: string[], depth = 0): boolean {
  if (depth > 2) {
    return false;
  }

  const wrappedCommandIndex = args.findIndex((arg) => arg && !arg.startsWith("-"));
  if (wrappedCommandIndex < 0) {
    return false;
  }

  const wrappedCommand = args[wrappedCommandIndex];
  const wrappedArgs = args.slice(wrappedCommandIndex + 1);

  if (wrappedCommand === "rm" || wrappedCommand === "rmdir" || wrappedCommand === "unlink" || wrappedCommand === "trash" || wrappedCommand === "srm" || wrappedCommand === "shred") {
    return true;
  }

  if (wrappedCommand === "git") {
    return isDeleteLikeGitInvocation(wrappedArgs);
  }

  if (wrappedCommand === "find") {
    return isDeleteLikeFindInvocation(wrappedArgs);
  }

  if (
    wrappedCommand === "bash"
    || wrappedCommand === "sh"
    || wrappedCommand === "zsh"
    || wrappedCommand === "fish"
    || wrappedCommand === "node"
    || wrappedCommand === "tsx"
    || wrappedCommand === "ts-node"
    || wrappedCommand === "python"
    || wrappedCommand === "python3"
    || wrappedCommand === "perl"
    || wrappedCommand === "ruby"
    || wrappedCommand === "php"
    || wrappedCommand === "deno"
  ) {
    return isDeleteLikeScriptInvocation(wrappedCommand, wrappedArgs);
  }

  if (
    wrappedCommand === "sudo"
    || wrappedCommand === "env"
    || wrappedCommand === "command"
    || wrappedCommand === "nice"
    || wrappedCommand === "nohup"
    || wrappedCommand === "timeout"
    || wrappedCommand === "xargs"
  ) {
    return isDeleteLikeWrappedInvocation(wrappedArgs, depth + 1);
  }

  return false;
}

function requiresDeleteApprovalForBash(command: string, args: string[]) {
  if (command === "rm" || command === "rmdir") {
    return false;
  }

  if (command === "git") {
    return isDeleteLikeGitInvocation(args);
  }

  if (command === "find") {
    return isDeleteLikeFindInvocation(args);
  }

  if (command === "bash" || command === "sh" || command === "zsh" || command === "fish" || command === "node" || command === "tsx" || command === "ts-node" || command === "python" || command === "python3" || command === "perl" || command === "ruby" || command === "php" || command === "deno") {
    return isDeleteLikeScriptInvocation(command, args);
  }

  if (command === "sudo" || command === "env" || command === "command" || command === "nice" || command === "nohup" || command === "timeout" || command === "xargs") {
    return isDeleteLikeWrappedInvocation(args);
  }

  return false;
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
      return createFileElevatedApproval("read", "等待确认 Elevated 读取", "读取", targetPath);
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
      return {
        ...createFileElevatedApproval("write", "等待确认 Elevated 写入", "写入", targetPath),
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      };
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
      return {
        ...createFileElevatedApproval("write", "等待确认 Elevated 写入", "写入", targetPath),
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      };
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
      return {
        ...createFileElevatedApproval("edit", "等待确认 Elevated 编辑", "编辑", targetPath),
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      };
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
  const run = {
    primitive: "delete" as const,
    targetPath,
    detail: `deleting ${targetPath}`,
  };
  const approval = {
    toolCallId: input.toolCallId,
    title: "等待确认删除文件",
    detail: `即将删除 ${targetPath}。你可以直接在聊天里回复“可以删除”继续，或者回复“取消”拒绝。`,
    commandLine: targetPath,
    command: "delete",
    args: [targetPath],
    cwd: dirname(targetPath),
    approvalStateTracker: input.approvalStateTracker,
  };

  try {
    await validateDeletePath(context, targetPath);
  } catch (error) {
    if (canUseElevatedFallback(context, error)) {
      return context.audit.withRun({
        ...run,
        access: "elevated",
        execute: async () => {
          await requestDeleteApproval(context, approval);
          const kind = await validateDeletePath(context, targetPath);
          return deletePathResult(context, targetPath, kind);
        },
      });
    }

    return recordBlockedAttempt<string>(context, run, error);
  }

  return context.audit.withRun({
    ...run,
    access: "standard",
    execute: async () => {
      if (!context.toolPolicy.fullAccess) {
        await requestDeleteApproval(context, approval);
      }
      const kind = await validateDeletePath(context, targetPath);
      return deletePathResult(context, targetPath, kind);
    },
  });
}

async function runBashAsDelete(
  context: SandboxRuntimeContext,
  command: string,
  args: string[],
  cwd: string,
  toolCallId?: string,
  approvalStateTracker?: SandboxElevatedApprovalInput["approvalStateTracker"],
) {
  const pathArgs = args.filter((arg) => arg && !arg.startsWith("-"));
  if (pathArgs.length === 0) {
    throw new SandboxViolationError(
      `bash rm/rmdir denied: no target path provided`,
      { allowElevatedFallback: false },
    );
  }

  const results: string[] = [];
  if (!context.toolPolicy.fullAccess) {
    await requestDeleteApproval(context, {
      toolCallId,
      title: "等待确认删除命令",
      detail: `即将通过 ${command} 删除以下路径：${pathArgs.join(", ")}。你可以直接在聊天里回复“可以删除”继续，或者回复“取消”拒绝。`,
      commandLine: summarizeCommandLine(command, args),
      command,
      args,
      cwd,
      approvalStateTracker,
    });
  }
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
      detail: `${command} ${rawPath} (via bash)`,
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
  const script = input.script?.trim() || null;
  const command = input.command.trim();
  const args = input.args ?? [];
  const cwd = resolve(input.cwd ?? context.defaultCwd ?? projectRoot);
  const timeoutMs = Math.max(250, Math.min(input.timeoutMs ?? context.defaultTimeoutMs, 60_000));
  const scriptCommands = script && !context.toolPolicy.fullAccess ? parseShellScriptCommandsForPolicy(script) : [];
  const policyInput: NormalizedBashPolicyInput = {
    cwd,
    command: script ? null : command,
    args,
    script,
    scriptCommands,
  };
  const shellApprovalCommand = script ? "sh" : command;
  const shellApprovalArgs = script ? ["-lc", script] : args;
  const deleteLikeBashApproval = requiresDeleteApprovalForBash(command, args)
    ? {
        toolCallId: input.toolCallId,
        title: "等待确认删除命令",
        detail: `即将通过 ${summarizeCommandLine(command, args)} 删除工作区内的文件。确认后只执行这一次命令。`,
        commandLine: summarizeCommandLine(command, args),
        command,
        args,
        cwd,
        approvalStateTracker: input.approvalStateTracker,
      }
    : null;

  const deleteLikeScriptApproval = script && requiresDeleteApprovalForBash("sh", ["-lc", script])
    ? {
        toolCallId: input.toolCallId,
        title: "等待确认删除脚本命令",
        detail: `即将通过 ${summarizeShellScript(script)} 删除工作区内的文件。确认后只执行这一次脚本。`,
        commandLine: summarizeShellScript(script),
        command: "sh",
        args: ["-lc", script],
        cwd,
        approvalStateTracker: input.approvalStateTracker,
      }
    : null;

  if (command === "rm" || command === "rmdir") {
    return runBashAsDelete(
      context,
      command,
      args,
      cwd,
      input.toolCallId,
      input.approvalStateTracker,
    );
  }

  return withPolicyFallback({
    context,
    run: {
      primitive: "bash",
      command: script ? "sh" : command,
      args: shellApprovalArgs,
      cwd,
      detail: script ? `running shell script ${summarizeShellScript(script)}` : `running ${command} ${args.join(" ")}`.trim(),
    },
    preflight() {
      assertBashExecution(context.toolPolicy, policyInput);
    },
    buildElevatedApproval() {
      noteBashApprovalAttempt(context, shellApprovalCommand, shellApprovalArgs, cwd);
      return {
        ...createBashElevatedApproval(shellApprovalCommand, shellApprovalArgs, cwd),
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      };
    },
    async executeStandard() {
      assertBashExecution(context.toolPolicy, policyInput);
      if (!context.toolPolicy.fullAccess && deleteLikeBashApproval) {
        await requestDeleteApproval(context, deleteLikeBashApproval);
      }
      if (!context.toolPolicy.fullAccess && deleteLikeScriptApproval) {
        await requestDeleteApproval(context, deleteLikeScriptApproval);
      }
      if (!context.toolPolicy.fullAccess && context.requestBashApproval && !context.autoApproveToolRequests) {
        noteBashApprovalAttempt(context, shellApprovalCommand, shellApprovalArgs, cwd);
        await context.requestBashApproval({
          command: shellApprovalCommand,
          args: shellApprovalArgs,
          cwd,
          toolCallId: input.toolCallId,
          approvalStateTracker: input.approvalStateTracker,
        });
      }
      const profile = script
        ? (shouldBypassSeatbeltForScript(context, scriptCommands) ? null : buildSeatbeltProfileForContext(context))
        : (shouldBypassSeatbeltForCommand(context, command) ? null : buildSeatbeltProfileForContext(context));
      return script
        ? executeBashScriptResult(script, cwd, timeoutMs, context.maxBufferBytes, profile, input.progressTracker)
        : executeBashResult(command, args, cwd, timeoutMs, context.maxBufferBytes, profile, input.progressTracker);
    },
    async executeElevated() {
      if (!context.toolPolicy.fullAccess && deleteLikeBashApproval) {
        await requestDeleteApproval(context, deleteLikeBashApproval);
      }
      if (!context.toolPolicy.fullAccess && deleteLikeScriptApproval) {
        await requestDeleteApproval(context, deleteLikeScriptApproval);
      }
      return script
        ? executeBashScriptResult(script, cwd, timeoutMs, context.maxBufferBytes, null, input.progressTracker)
        : executeBashResult(command, args, cwd, timeoutMs, context.maxBufferBytes, null, input.progressTracker);
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
