import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { normalizeSandboxPermissionProfile } from "@aliceloop/runtime-core";
import { getDataDir, getUploadsDir } from "../../db/client";
import { isOutputRedirectOp, parseBashScriptAst } from "./bashAst";
import {
  type ParsedBashCommand,
  type NormalizedBashPolicyInput,
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
const defaultAllowedCommands = [
  "aliceloop",
  "cat",
  "date",
  "du",
  "echo",
  "env",
  "find",
  "git",
  "grep",
  "head",
  "id",
  "ifconfig",
  "lsof",
  "ls",
  "networksetup",
  "node",
  "npm",
  "ping",
  "pmset",
  "ps",
  "pwd",
  "realpath",
  "rg",
  "rm",
  "rmdir",
  "screencapture",
  "sed",
  "sips",
  "stat",
  "sw_vers",
  "sysctl",
  "system_profiler",
  "top",
  "tsx",
  "uname",
  "vm_stat",
  "wc",
  "which",
  "whoami",
];
const safeAbsoluteCommandRoots = new Set([
  "/bin",
  "/usr/bin",
  "/usr/sbin",
  "/opt/homebrew",
  "/usr/local",
  resolve(homedir(), ".nvm/versions/node"),
  resolve(homedir(), ".volta"),
]);
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

function isPathWithinCommandRoot(targetPath: string, root: string) {
  const resolvedTarget = resolve(targetPath);
  const resolvedRoot = resolve(root);
  const relativePath = relative(resolvedRoot, resolvedTarget);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isSedInPlace(args: string[]) {
  return args.some((arg) => arg === "-i" || arg === "--in-place" || arg.startsWith("-i"));
}

function assertSupportedShellScript(script: string) {
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    const next = script[index + 1];

    if (escape) {
      escape = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === '"') {
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (char === ">" || char === "<" || char === "`" || (char === "$" && next === "(") || char === "&") {
      if (char === "&" && next === "&") {
        index += 1;
        continue;
      }
      throw new SandboxViolationError(
        `bash denied for unsupported shell feature in script: ${char}; use simple commands, pipes, &&, ||, or ; only`,
        { allowElevatedFallback: false },
      );
    }

    if (char === "|" && next === "|") {
      index += 1;
    }
  }

  if (quote !== null) {
    throw new SandboxViolationError(
      "bash denied for unterminated quoted string in script",
      { allowElevatedFallback: false },
    );
  }
}

function splitShellCommands(script: string) {
  const commands: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    const next = script[index + 1];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (quote === "'") {
      current += char;
      if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === '"') {
      current += char;
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === "\\") {
      current += char;
      escape = true;
      continue;
    }

    if (char === ";" || char === "\n" || char === "|") {
      const trimmed = current.trim();
      if (trimmed) {
        commands.push(trimmed);
      }
      current = "";
      if (char === "|" && next === "|") {
        index += 1;
      }
      continue;
    }

    if (char === "&" && next === "&") {
      const trimmed = current.trim();
      if (trimmed) {
        commands.push(trimmed);
      }
      current = "";
      index += 1;
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) {
    commands.push(trimmed);
  }

  return commands;
}

function tokenizeShellWords(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function collectPathArguments(command: string, args: string[]): CollectedPathArgument[] {
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

function assertPathAccess(
  policy: SandboxToolPolicy,
  targetPath: string,
  access: PathArgumentAccess,
) {
  if (isPathAllowedForAccess(policy, targetPath, access)) {
    return;
  }

  const reason = access === "read"
    ? "read path"
    : access === "execute"
      ? "executable path"
      : "write path";
  const guidance = access === "read"
    ? "this command is confined to the configured workspace read roots"
    : access === "execute"
      ? "this command is confined to the configured workspace roots"
      : "this command is confined to the configured workspace write roots";
  throw new SandboxViolationError(
    `bash denied for ${reason} outside allowed roots: ${targetPath}; ${guidance}`,
  );
}

export function buildSandboxToolPolicy(options: SandboxExecutorOptions): SandboxToolPolicy {
  const permissionProfile = normalizeSandboxPermissionProfile(options.permissionProfile);
  const fullAccess = permissionProfile === "full-access";
  const keepFilesystemBoundaryInFullAccess = fullAccess && options.keepFilesystemBoundaryInFullAccess === true;
  const enforceWorkspaceBoundary = !fullAccess || keepFilesystemBoundaryInFullAccess;
  const workspaceRoot = options.workspaceRoot?.trim();
  const workspaceReadRoots = enforceWorkspaceBoundary && workspaceRoot
    ? uniqueRoots([workspaceRoot, ...(options.extraReadRoots ?? [])])
    : null;
  const workspaceWriteRoots = enforceWorkspaceBoundary && workspaceRoot
    ? uniqueRoots([workspaceRoot, ...(options.extraWriteRoots ?? [])])
    : null;
  const workspaceCwdRoots = enforceWorkspaceBoundary && workspaceRoot
    ? uniqueRoots([workspaceRoot, ...(options.extraCwdRoots ?? [])])
    : null;
  const supportsElevatedActions = permissionProfile === "development"
    || Boolean(options.supportsElevatedActionsInFullAccess);

  return {
    label: options.label,
    permissionProfile,
    fullAccess,
    elevatedAccess: supportsElevatedActions ? "elevated" : "standard",
    supportsElevatedActions,
    requiresBashApproval: !fullAccess && Boolean(options.requestBashApproval),
    allowedReadRoots: fullAccess && !keepFilesystemBoundaryInFullAccess
      ? null
      : workspaceReadRoots
        ? workspaceReadRoots
        : uniqueRoots([...defaultAllowedReadRoots, ...(options.extraReadRoots ?? [])]),
    allowedWriteRoots: fullAccess && !keepFilesystemBoundaryInFullAccess
      ? null
      : workspaceWriteRoots
        ? workspaceWriteRoots
        : uniqueRoots([...defaultAllowedWriteRoots, ...(options.extraWriteRoots ?? [])]),
    allowedCwdRoots: fullAccess && !keepFilesystemBoundaryInFullAccess
      ? null
      : workspaceCwdRoots
        ? workspaceCwdRoots
        : uniqueRoots([...defaultAllowedCwdRoots, ...(options.extraCwdRoots ?? [])]),
    allowedCommands: [...new Set([...(options.allowedCommands ?? []), ...defaultAllowedCommands])],
  };
}

export function assertReadable(policy: SandboxToolPolicy, targetPath: string) {
  if (policy.allowedReadRoots && !isPathAllowed(targetPath, policy.allowedReadRoots)) {
    throw new SandboxViolationError(
      `read denied for path outside allowed roots: ${targetPath}; add this path to the sandbox read roots before retrying`,
    );
  }
}

export function assertWritable(policy: SandboxToolPolicy, targetPath: string) {
  if (policy.allowedWriteRoots && !isPathAllowed(targetPath, policy.allowedWriteRoots)) {
    throw new SandboxViolationError(
      `write denied for path outside allowed roots: ${targetPath}; add this path to the sandbox write roots before retrying`,
    );
  }
}

export function assertCwd(policy: SandboxToolPolicy, cwd: string) {
  if (policy.allowedCwdRoots && !isPathAllowed(cwd, policy.allowedCwdRoots)) {
    throw new SandboxViolationError(
      `bash denied for cwd outside allowed roots: ${cwd}; add this folder to the workspace sandbox roots before retrying`,
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
    ? (uniqueRoots([...safeAbsoluteCommandRoots]).some((root) => isPathWithinCommandRoot(dirname(command), root))
      ? basename(command)
      : command)
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
  if (!policy.fullAccess) {
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
  }

  const hasFilesystemBoundary = policy.allowedReadRoots !== null
    || policy.allowedWriteRoots !== null
    || policy.allowedCwdRoots !== null;
  if (!hasFilesystemBoundary) {
    return;
  }

  const pathLikeArgs = collectPathArguments(input.command, input.args);
  for (const { value, access } of pathLikeArgs) {
    const candidatePath = resolve(input.cwd, value);
    assertPathAccess(policy, candidatePath, access);
  }
}

export function assertBashExecution(policy: SandboxToolPolicy, input: NormalizedBashPolicyInput) {
  assertCwd(policy, input.cwd);

  if (input.script) {
    for (const shellCommand of input.scriptCommands) {
      assertCommand(policy, shellCommand.command);
      assertCommandArguments(policy, {
        command: shellCommand.command,
        args: shellCommand.args,
        cwd: input.cwd,
      });
      for (const redirect of shellCommand.redirects ?? []) {
        const access: PathArgumentAccess = isOutputRedirectOp(redirect.op) ? "write" : "read";
        assertPathAccess(policy, resolve(input.cwd, redirect.target), access);
      }
    }
    return;
  }

  assertCommand(policy, input.command ?? "");
  assertCommandArguments(policy, {
    command: input.command ?? "",
    args: input.args,
    cwd: input.cwd,
  });
}

export function parseShellScriptCommandsForPolicy(
  script: string,
  options?: { allowRedirects?: boolean },
): ParsedBashCommand[] {
  const parsed = parseBashScriptAst(script);
  if (parsed.kind === "too-complex") {
    throw new SandboxViolationError(
      `bash denied for unsupported shell feature in script: ${parsed.reason}; use simple commands, pipes, &&, ||, or ; only`,
      { allowElevatedFallback: false },
    );
  }

  for (const command of parsed.commands) {
    if (!options?.allowRedirects && command.redirects.length > 0) {
      throw new SandboxViolationError(
        "bash denied for unsupported shell feature in script: redirection; use simple commands, pipes, &&, ||, or ; only",
        { allowElevatedFallback: false },
      );
    }
  }

  return parsed.commands.map((command) => ({
    command: command.command,
    args: command.args,
    redirects: command.redirects,
  }));
}

export function getDefaultSandboxRoots() {
  return {
    projectRoot,
    workspaceRoot: getDefaultWorkspaceRoot(),
    dataDir: getDataDir(),
    uploadsDir: getUploadsDir(),
  };
}

export function getDefaultWorkspaceRoot() {
  return process.env.ALICELOOP_DEFAULT_WORKSPACE_DIR?.trim()
    ? resolve(process.env.ALICELOOP_DEFAULT_WORKSPACE_DIR)
    : resolve(getDataDir(), "workspaces", "default");
}

export function getSandboxProjectRoot() {
  return projectRoot;
}

export function listDefaultAllowedCommands() {
  return [...defaultAllowedCommands];
}
