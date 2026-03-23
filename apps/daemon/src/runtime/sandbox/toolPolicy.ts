import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { normalizeSandboxPermissionProfile } from "@aliceloop/runtime-core";
import { getDataDir, getUploadsDir } from "../../db/client";
import {
  SandboxViolationError,
  type RunBashInput,
  type SandboxExecutorOptions,
  type SandboxToolPolicy,
} from "./types";

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "../../../../../");

const defaultAllowedReadRoots = [projectRoot, getDataDir(), getUploadsDir()];
const defaultAllowedWriteRoots = [projectRoot, getDataDir(), getUploadsDir()];
const defaultAllowedCwdRoots = [projectRoot, getDataDir(), getUploadsDir()];
const defaultAllowedCommands = ["cat", "find", "git", "head", "ls", "node", "npm", "pwd", "rg", "rm", "rmdir", "screencapture", "sed", "sips", "tsx", "wc"];
const safeAbsoluteCommandDirs = new Set(["/bin", "/usr/bin", "/usr/sbin"]);
const developmentFindDisallowedArgs = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const developmentNpmAllowedSubcommands = new Set([
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
  "install",
  "run",
  "test",
  "ci",
  "audit",
  "rebuild",
  "dev",
  "start",
  "stop",
  "restart",
]);

type PathArgumentAccess = "read" | "write" | "execute";

interface CollectedPathArgument {
  value: string;
  access: PathArgumentAccess;
}

export function uniqueRoots(roots: string[]) {
  return [...new Set(roots.map((root) => resolve(root)))];
}

export function resolveRealPath(targetPath: string): string {
  const resolvedTarget = resolve(targetPath);
  try {
    return realpathSync(resolvedTarget);
  } catch {
    const missingSegments: string[] = [];
    let currentPath = resolvedTarget;
    while (true) {
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        return resolvedTarget;
      }

      missingSegments.unshift(basename(currentPath));
      try {
        return resolve(realpathSync(parentPath), ...missingSegments);
      } catch {
        currentPath = parentPath;
      }
    }
  }
}

export function isPathWithinRoot(targetPath: string, root: string) {
  const resolvedTarget = resolveRealPath(targetPath);
  const resolvedRoot = resolveRealPath(root);
  const relativePath = relative(resolvedRoot, resolvedTarget);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function isPathAllowed(targetPath: string, allowedRoots: string[]) {
  return uniqueRoots(allowedRoots).some((root) => isPathWithinRoot(targetPath, root));
}

function isSedInPlace(args: string[]) {
  return args.some((arg) => arg === "-i" || arg === "--in-place" || arg.startsWith("-i"));
}

function collectPathArguments(command: string, args: string[]): CollectedPathArgument[] {
  const nonFlagArgs = args.filter((arg) => arg && !arg.startsWith("-"));
  switch (command) {
    case "cat":
    case "head":
    case "wc":
    case "ls":
      return nonFlagArgs.map((value) => ({ value, access: "read" }));
    case "rg":
      return nonFlagArgs.slice(1).map((value) => ({ value, access: "read" }));
    case "sed": {
      const access: PathArgumentAccess = isSedInPlace(args) ? "write" : "read";
      return nonFlagArgs.slice(1).map((value) => ({ value, access }));
    }
    case "rm":
    case "rmdir":
      return nonFlagArgs.map((value) => ({ value, access: "write" }));
    case "node":
    case "tsx":
      return nonFlagArgs.slice(0, 1).map((value) => ({ value, access: "execute" }));
    case "find": {
      const pathArgs: CollectedPathArgument[] = [];
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

        pathArgs.push({
          value: arg,
          access: "read",
        });
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

function isPathAllowedForAccess(
  policy: SandboxToolPolicy,
  targetPath: string,
  access: PathArgumentAccess,
) {
  if (access === "read") {
    return policy.allowedReadRoots ? isPathAllowed(targetPath, policy.allowedReadRoots) : true;
  }

  return policy.allowedWriteRoots ? isPathAllowed(targetPath, policy.allowedWriteRoots) : true;
}

export function buildSandboxToolPolicy(options: SandboxExecutorOptions): SandboxToolPolicy {
  const permissionProfile = normalizeSandboxPermissionProfile(options.permissionProfile);
  const fullAccess = permissionProfile === "full-access";

  return {
    label: options.label,
    permissionProfile,
    fullAccess,
    elevatedAccess: permissionProfile === "development" ? "elevated" : "standard",
    supportsElevatedActions: permissionProfile === "development",
    requiresBashApproval: !fullAccess && Boolean(options.requestBashApproval),
    allowedReadRoots: fullAccess ? null : uniqueRoots([...defaultAllowedReadRoots, ...(options.extraReadRoots ?? [])]),
    allowedWriteRoots: fullAccess ? null : uniqueRoots([...defaultAllowedWriteRoots, ...(options.extraWriteRoots ?? [])]),
    allowedCwdRoots: fullAccess ? null : uniqueRoots([...defaultAllowedCwdRoots, ...(options.extraCwdRoots ?? [])]),
    allowedCommands: [...new Set([...(options.allowedCommands ?? []), ...defaultAllowedCommands])],
  };
}

export function assertReadable(policy: SandboxToolPolicy, targetPath: string) {
  if (policy.allowedReadRoots && !isPathAllowed(targetPath, policy.allowedReadRoots)) {
    throw new SandboxViolationError(
      `read denied for path outside allowed roots: ${targetPath}; this action would require elevated access in development mode or an explicit read root`,
    );
  }
}

export function assertWritable(policy: SandboxToolPolicy, targetPath: string) {
  if (policy.allowedWriteRoots && !isPathAllowed(targetPath, policy.allowedWriteRoots)) {
    throw new SandboxViolationError(
      `write denied for path outside allowed roots: ${targetPath}; this action would require elevated access in development mode`,
    );
  }
}

export function assertCwd(policy: SandboxToolPolicy, cwd: string) {
  if (policy.allowedCwdRoots && !isPathAllowed(cwd, policy.allowedCwdRoots)) {
    throw new SandboxViolationError(
      `bash denied for cwd outside allowed roots: ${cwd}; add this folder to sandbox roots before retrying`,
    );
  }
}

export function assertCommand(policy: SandboxToolPolicy, command: string) {
  if (!command || /\s/.test(command)) {
    throw new SandboxViolationError(`bash denied for invalid command: ${command}`);
  }

  if (policy.fullAccess) {
    return;
  }

  const normalizedCommand = command.includes("/")
    ? (safeAbsoluteCommandDirs.has(dirname(command)) ? basename(command) : command)
    : command;

  if (normalizedCommand.includes("/") || !policy.allowedCommands.includes(normalizedCommand)) {
    throw new SandboxViolationError(
      `bash denied for command outside allowlist: ${command}; this action would require elevated access in development mode`,
    );
  }
}

export function assertCommandArguments(
  policy: SandboxToolPolicy,
  input: Pick<RunBashInput, "command"> & { args: string[]; cwd: string },
) {
  if (policy.fullAccess) {
    return;
  }

  if (input.command === "ls") {
    return;
  }

  if (input.command === "find") {
    for (const arg of input.args) {
      if (developmentFindDisallowedArgs.has(arg)) {
        throw new SandboxViolationError(`bash denied for dangerous find expression: ${arg}`);
      }
    }
  }

  if (input.command === "rm" || input.command === "rmdir") {
    const dangerousRmFlags = new Set(["-r", "-R", "--recursive", "-rf", "-Rf", "-fr", "-fR"]);
    for (const arg of input.args) {
      if (dangerousRmFlags.has(arg)) {
        throw new SandboxViolationError(
          `bash denied for dangerous rm flag: ${arg}; use bash with rm on individual files or empty directories only`,
        );
      }
    }
  }

  if (input.command === "npm") {
    const subcommand = getNpmSubcommand(input.args);
    if (subcommand && !developmentNpmAllowedSubcommands.has(subcommand)) {
      throw new SandboxViolationError(
        `bash denied for npm subcommand in development mode: ${subcommand}`,
      );
    }
  }

  const pathLikeArgs = collectPathArguments(input.command, input.args);
  for (const { value, access } of pathLikeArgs) {
    const candidatePath = resolve(input.cwd, value);
    if (!isPathAllowedForAccess(policy, candidatePath, access)) {
      const reason = access === "read"
        ? "read path"
        : access === "execute"
          ? "executable path"
          : "write path";
      const guidance = access === "read"
        ? "this action would require elevated access in development mode or an explicit read root"
        : access === "execute"
          ? "this action would require elevated access in development mode"
          : "this action would require elevated access in development mode";
      throw new SandboxViolationError(
        `bash denied for ${reason} outside allowed roots: ${value}; ${guidance}`,
      );
    }
  }
}

export function getDefaultSandboxRoots() {
  return {
    projectRoot,
    dataDir: getDataDir(),
    uploadsDir: getUploadsDir(),
  };
}

export function getSandboxProjectRoot() {
  return projectRoot;
}

export function listDefaultAllowedCommands() {
  return [...defaultAllowedCommands];
}
