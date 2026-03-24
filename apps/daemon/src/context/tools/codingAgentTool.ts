import { execFile } from "node:child_process";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { tool } from "ai";
import { getDataDir } from "../../db/client";
import { isPathWithinRoot } from "../../runtime/sandbox/toolPolicy";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const defaultWorkspaceRoot = join(getDataDir(), "workspaces", "default");

export function createCodingAgentTool() {
  return {
    coding_agent_run: tool({
      description:
        "Delegate a complex coding task to Claude Code (sub-agent). Best for multi-file edits, large refactors, debugging sessions, or feature implementations spanning 3+ files. The sub-agent runs with full permissions in the workspace.",
      inputSchema: z.object({
        task: z
          .string()
          .describe("A clear, self-contained description of the coding task to perform"),
        workingDir: z
          .string()
          .optional()
          .describe("Working directory for the sub-agent (defaults to the default workspace)"),
      }),
      execute: async ({ task, workingDir }) => {
        const args = [
          "-p",
          task,
          "--output-format",
          "text",
          "--dangerously-skip-permissions",
        ];
        const cwd = workingDir?.trim()
          ? resolve(defaultWorkspaceRoot, workingDir)
          : defaultWorkspaceRoot;

        if (!isPathWithinRoot(cwd, defaultWorkspaceRoot)) {
          return `Error: workingDir must stay inside the default workspace: ${defaultWorkspaceRoot}`;
        }

        try {
          const { stdout, stderr } = await execFileAsync("claude", args, {
            cwd,
            timeout: DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER_BYTES,
            env: {
              ...process.env,
              CI: "true",
            },
          });

          const output = stdout.trim();
          if (stderr.trim()) {
            return `${output}\n\n[stderr]: ${stderr.trim()}`;
          }
          return output || "(no output)";
        } catch (error: unknown) {
          const err = error as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            killed?: boolean;
          };
          if (err.code === "ENOENT") {
            return "Error: `claude` CLI not found. Install Claude Code first: npm install -g @anthropic-ai/claude-code";
          }
          if (err.killed) {
            const partial = err.stdout?.trim() ?? "";
            return `Error: sub-agent timed out after ${DEFAULT_TIMEOUT_MS / 1000}s.${partial ? `\n\nPartial output:\n${partial}` : ""}`;
          }
          const output = err.stdout?.trim() ?? "";
          const errMsg = err.stderr?.trim() ?? err.message ?? String(error);
          return `Error running coding agent: ${errMsg}${output ? `\n\nOutput:\n${output}` : ""}`;
        }
      },
    }),
  };
}
