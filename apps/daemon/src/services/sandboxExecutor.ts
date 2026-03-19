import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SandboxPermissionProfile, SandboxPrimitive, SandboxRun } from "@aliceloop/runtime-core";
import { getDataDir, getUploadsDir } from "../db/client";
import { createSandboxRun, finishSandboxRun } from "../repositories/sandboxRunRepository";

const execFileAsync = promisify(execFile);
const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "../../../../");

const defaultAllowedReadRoots = [projectRoot, getDataDir(), getUploadsDir()];
const defaultAllowedWriteRoots = [projectRoot, getDataDir(), getUploadsDir()];
const defaultAllowedCwdRoots = [projectRoot, getDataDir(), getUploadsDir()];
const defaultAllowedCommands = ["cat", "find", "git", "head", "ls", "node", "npm", "pwd", "rg", "sed", "tsx", "wc"];
const tsxCliPath = resolve(projectRoot, "node_modules/tsx/dist/cli.mjs");
const restrictedFindDisallowedArgs = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const restrictedNpmAllowedSubcommands = new Set([
  "help",
  "root",
  "prefix",
  "bin",
  "version",
  "view",
  "query",
  "search",
  "ls",
  "outdated",
  "explain",
  "pkg",
]);

export class SandboxViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolationError";
  }
}

interface SandboxExecutorOptions {
  label: string;
  permissionProfile?: SandboxPermissionProfile;
  extraReadRoots?: string[];
  extraWriteRoots?: string[];
  extraCwdRoots?: string[];
  allowedCommands?: string[];
  defaultTimeoutMs?: number;
  requestBashApproval?: (input: { command: string; args: string[]; cwd: string }) => Promise<void>;
}

interface ReadTextFileInput {
  targetPath: string;
}

interface WriteBinaryFileInput {
  targetPath: string;
  content: Uint8Array;
}

interface WriteTextFileInput {
  targetPath: string;
  content: string;
}

interface EditTextFileInput {
  targetPath: string;
  transform: (content: string) => string;
}

interface RunBashInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

function uniqueRoots(roots: string[]) {
  return [...new Set(roots.map((root) => resolve(root)))];
}

function isPathWithinRoot(targetPath: string, root: string) {
  const relativePath = relative(resolve(root), resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isPathAllowed(targetPath: string, allowedRoots: string[]) {
  return uniqueRoots(allowedRoots).some((root) => isPathWithinRoot(targetPath, root));
}

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

function collectPathArguments(command: string, args: string[]) {
  const nonFlagArgs = args.filter((arg) => arg && !arg.startsWith("-"));
  switch (command) {
    case "cat":
    case "head":
    case "tail":
    case "wc":
    case "ls":
      return nonFlagArgs;
    case "rg":
      return nonFlagArgs.slice(1);
    case "sed":
      return nonFlagArgs.slice(1);
    case "node":
    case "tsx":
      return nonFlagArgs.slice(0, 1);
    case "find": {
      const pathArgs: string[] = [];
      for (const arg of args) {
        if (!arg) {
          continue;
        }

        if (arg === "!" || arg === "(" || arg === ")" || arg === ",") {
          break;
        }

        if (arg.startsWith("-")) {
          break;
        }

        pathArgs.push(arg);
      }
      return pathArgs;
    }
    default:
      return [];
  }
}

function getNpmSubcommand(args: string[]) {
  for (const arg of args) {
    if (!arg) {
      continue;
    }

    if (arg === "--") {
      break;
    }

    if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return null;
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

export function createPermissionSandboxExecutor(options: SandboxExecutorOptions) {
  const permissionProfile = options.permissionProfile ?? "restricted";
  const fullAccess = permissionProfile === "full-access";
  const allowedReadRoots = fullAccess ? null : uniqueRoots([...defaultAllowedReadRoots, ...(options.extraReadRoots ?? [])]);
  const allowedWriteRoots = fullAccess ? null : uniqueRoots([...defaultAllowedWriteRoots, ...(options.extraWriteRoots ?? [])]);
  const allowedCwdRoots = fullAccess ? null : uniqueRoots([...defaultAllowedCwdRoots, ...(options.extraCwdRoots ?? [])]);
  const allowedCommands = [...new Set([...(options.allowedCommands ?? []), ...defaultAllowedCommands])];

  async function withRun<T>(input: {
    primitive: SandboxPrimitive;
    targetPath?: string | null;
    command?: string | null;
    args?: string[];
    cwd?: string | null;
    detail: string;
    execute: () => Promise<{ result: T; detail: string }>;
  }) {
    const now = new Date().toISOString();
    const run = createSandboxRun({
      id: randomUUID(),
      primitive: input.primitive,
      status: "running",
      targetPath: input.targetPath ?? null,
      command: input.command ?? null,
      args: input.args ?? [],
      cwd: input.cwd ?? null,
      detail: `[${options.label}] ${input.detail}`,
      createdAt: now,
    });

    try {
      const { result, detail } = await input.execute();
      finishSandboxRun(run.id, {
        status: "done",
        detail: `[${options.label}] ${detail}`,
      });
      return result;
    } catch (error) {
      const status = error instanceof SandboxViolationError ? "blocked" : "failed";
      const detail = error instanceof Error ? error.message : "sandbox execution failed";
      finishSandboxRun(run.id, {
        status,
        detail: `[${options.label}] ${detail}`,
      });
      throw error;
    }
  }

  function assertReadable(targetPath: string) {
    if (allowedReadRoots && !isPathAllowed(targetPath, allowedReadRoots)) {
      throw new SandboxViolationError(`read denied for path outside allowed roots: ${targetPath}`);
    }
  }

  function assertWritable(targetPath: string) {
    if (allowedWriteRoots && !isPathAllowed(targetPath, allowedWriteRoots)) {
      throw new SandboxViolationError(`write denied for path outside allowed roots: ${targetPath}`);
    }
  }

  function assertCwd(cwd: string) {
    if (allowedCwdRoots && !isPathAllowed(cwd, allowedCwdRoots)) {
      throw new SandboxViolationError(`bash denied for cwd outside allowed roots: ${cwd}`);
    }
  }

  function assertCommand(command: string) {
    if (!command || /\s/.test(command)) {
      throw new SandboxViolationError(`bash denied for invalid command: ${command}`);
    }

    if (fullAccess) {
      return;
    }

    if (command.includes("/") || !allowedCommands.includes(command)) {
      throw new SandboxViolationError(`bash denied for command outside allowlist: ${command}`);
    }
  }

  function assertCommandArguments(command: string, args: string[], cwd: string) {
    if (fullAccess) {
      return;
    }

    if (command === "find") {
      for (const arg of args) {
        if (restrictedFindDisallowedArgs.has(arg)) {
          throw new SandboxViolationError(`bash denied for dangerous find expression: ${arg}`);
        }
      }
    }

    if (command === "npm") {
      const subcommand = getNpmSubcommand(args);
      if (subcommand && !restrictedNpmAllowedSubcommands.has(subcommand)) {
        throw new SandboxViolationError(
          `bash denied for npm subcommand in restricted mode: ${subcommand}`,
        );
      }
    }

    const pathLikeArgs = collectPathArguments(command, args);
    for (const value of pathLikeArgs) {
      const candidatePath = resolve(cwd, value);
      if (!isPathAllowed(candidatePath, [...(allowedReadRoots ?? []), ...(allowedWriteRoots ?? [])])) {
        throw new SandboxViolationError(`bash denied for path argument outside allowed roots: ${value}`);
      }
    }
  }

  return {
    async readTextFile(input: ReadTextFileInput) {
      const targetPath = resolve(input.targetPath);
      return withRun({
        primitive: "read",
        targetPath,
        detail: `reading ${targetPath}`,
        execute: async () => {
          assertReadable(targetPath);
          const content = await readFile(targetPath, "utf8");
          return {
            result: content,
            detail: `read ${targetPath} (${summarizeBytes(Buffer.byteLength(content, "utf8"))})`,
          };
        },
      });
    },

    async writeBinaryFile(input: WriteBinaryFileInput) {
      const targetPath = resolve(input.targetPath);
      return withRun({
        primitive: "write",
        targetPath,
        detail: `writing binary file ${targetPath}`,
        execute: async () => {
          assertWritable(targetPath);
          await mkdir(dirname(targetPath), { recursive: true });
          await writeFile(targetPath, input.content);
          return {
            result: targetPath,
            detail: `wrote ${targetPath} (${summarizeBytes(input.content.byteLength)})`,
          };
        },
      });
    },

    async writeTextFile(input: WriteTextFileInput) {
      const targetPath = resolve(input.targetPath);
      return withRun({
        primitive: "write",
        targetPath,
        detail: `writing text file ${targetPath}`,
        execute: async () => {
          assertWritable(targetPath);
          await mkdir(dirname(targetPath), { recursive: true });
          await writeFile(targetPath, input.content, "utf8");
          return {
            result: targetPath,
            detail: `wrote ${targetPath} (${summarizeBytes(Buffer.byteLength(input.content, "utf8"))})`,
          };
        },
      });
    },

    async editTextFile(input: EditTextFileInput) {
      const targetPath = resolve(input.targetPath);
      return withRun({
        primitive: "edit",
        targetPath,
        detail: `editing text file ${targetPath}`,
        execute: async () => {
          assertReadable(targetPath);
          assertWritable(targetPath);
          const before = await readFile(targetPath, "utf8");
          const after = input.transform(before);
          await writeFile(targetPath, after, "utf8");
          return {
            result: after,
            detail: `edited ${targetPath} (${summarizeText(after)})`,
          };
        },
      });
    },

    async runBash(input: RunBashInput) {
      const command = input.command.trim();
      const args = input.args ?? [];
      const cwd = resolve(input.cwd ?? projectRoot);
      const timeoutMs = Math.max(250, Math.min(input.timeoutMs ?? options.defaultTimeoutMs ?? 10_000, 60_000));

      return withRun({
        primitive: "bash",
        command,
        args,
        cwd,
        detail: `running ${command} ${args.join(" ")}`.trim(),
        execute: async () => {
          assertCommand(command);
          assertCwd(cwd);
          assertCommandArguments(command, args, cwd);
          if (options.requestBashApproval) {
            await options.requestBashApproval({
              command,
              args,
              cwd,
            });
          }
          const execution = resolveExecution(command, args);
          const { stdout, stderr } = await execFileAsync(execution.executable, execution.args, {
            cwd,
            timeout: timeoutMs,
            env: pickEnvironment(),
            maxBuffer: 1024 * 1024,
          });
          const detail = `bash ${command} completed; stdout=${summarizeText(stdout)}; stderr=${summarizeText(stderr)}`;
          return {
            result: {
              stdout,
              stderr,
            },
            detail,
          };
        },
      });
    },

    describePolicy() {
      return {
        label: options.label,
        permissionProfile,
        requiresBashApproval: Boolean(options.requestBashApproval),
        allowedReadRoots: allowedReadRoots ?? ["<all>"],
        allowedWriteRoots: allowedWriteRoots ?? ["<all>"],
        allowedCwdRoots: allowedCwdRoots ?? ["<all>"],
        allowedCommands: fullAccess ? ["<all>"] : allowedCommands,
      };
    },
  };
}

export type PermissionSandboxExecutor = ReturnType<typeof createPermissionSandboxExecutor>;

export function getDefaultSandboxRoots() {
  return {
    projectRoot,
    dataDir: getDataDir(),
    uploadsDir: getUploadsDir(),
  };
}

export function listDefaultAllowedCommands() {
  return [...defaultAllowedCommands];
}

export async function readTextThroughSandbox(
  targetPath: string,
  options: Pick<SandboxExecutorOptions, "label" | "extraReadRoots">,
) {
  const sandbox = createPermissionSandboxExecutor(options);
  return sandbox.readTextFile({
    targetPath,
  });
}

export async function writeBinaryThroughSandbox(
  targetPath: string,
  content: Uint8Array,
  options: Pick<SandboxExecutorOptions, "label" | "extraWriteRoots">,
) {
  const sandbox = createPermissionSandboxExecutor(options);
  return sandbox.writeBinaryFile({
    targetPath,
    content,
  });
}

export type { SandboxRun };
