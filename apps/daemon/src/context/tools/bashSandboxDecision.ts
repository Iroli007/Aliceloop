import { resolve } from "node:path";
import { collectPathArguments, isPathWithinRoot, parseShellScriptCommandsForPolicy } from "../../runtime/sandbox/toolPolicy";

export type AgentBashExecutionMode = "sandbox" | "host";

function usesOnlyWorkspacePaths(
  cwd: string,
  workspaceRoot: string,
  command: string,
  args: string[],
  redirects: Array<{ target: string }> = [],
) {
  const pathArguments = collectPathArguments(command, args);
  for (const pathArgument of pathArguments) {
    if (!isPathWithinRoot(resolve(cwd, pathArgument.value), workspaceRoot)) {
      return false;
    }
  }

  for (const redirect of redirects) {
    if (!isPathWithinRoot(resolve(cwd, redirect.target), workspaceRoot)) {
      return false;
    }
  }

  return true;
}

export function decideAgentBashExecutionMode(
  input: {
    command?: string;
    args?: string[];
    script?: string;
    cwd?: string;
  },
  options: {
    workspaceRoot: string;
    defaultCwd: string;
  },
): AgentBashExecutionMode {
  const workspaceRoot = resolve(options.workspaceRoot);
  const cwd = resolve(input.cwd ?? options.defaultCwd);

  if (!isPathWithinRoot(cwd, workspaceRoot)) {
    return "host";
  }

  if (input.script?.trim()) {
    try {
      const commands = parseShellScriptCommandsForPolicy(input.script.trim(), {
        allowRedirects: true,
      });

      for (const command of commands) {
        if (!usesOnlyWorkspacePaths(cwd, workspaceRoot, command.command, command.args, command.redirects ?? [])) {
          return "host";
        }
      }

      return "sandbox";
    } catch {
      return "sandbox";
    }
  }

  if (!input.command?.trim()) {
    return "sandbox";
  }

  return usesOnlyWorkspacePaths(
    cwd,
    workspaceRoot,
    input.command.trim(),
    input.args ?? [],
  )
    ? "sandbox"
    : "host";
}
