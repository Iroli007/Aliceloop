import { z } from "zod";
import { tool } from "ai";
import type { createPermissionSandboxExecutor } from "../../services/sandboxExecutor";

type SandboxExecutor = ReturnType<typeof createPermissionSandboxExecutor>;

export function createSandboxTools(sandbox: SandboxExecutor) {
  return {
    sandbox_read: tool({
      description:
        "Read the contents of a file from the local filesystem. Returns the text content of the file.",
      inputSchema: z.object({
        filePath: z
          .string()
          .describe("Absolute path to the file to read"),
      }),
      execute: async ({ filePath }) => {
        const content = await sandbox.readTextFile({ targetPath: filePath });
        return content;
      },
    }),

    sandbox_write: tool({
      description:
        "Write content to a file, creating it if it doesn't exist or overwriting if it does.",
      inputSchema: z.object({
        targetPath: z
          .string()
          .describe("Absolute path to the file to write"),
        content: z
          .string()
          .describe("The text content to write to the file"),
      }),
      execute: async ({ targetPath, content }) => {
        await sandbox.writeTextFile({ targetPath, content });
        return `File written successfully: ${targetPath}`;
      },
    }),

    sandbox_edit: tool({
      description:
        "Edit an existing file by applying a transform function. Use this for precise modifications to specific parts of a file.",
      inputSchema: z.object({
        filePath: z
          .string()
          .describe("Absolute path to the file to edit"),
        oldText: z
          .string()
          .describe("The exact text to find in the file"),
        newText: z
          .string()
          .describe("The replacement text"),
      }),
      execute: async ({ filePath, oldText, newText }) => {
        await sandbox.editTextFile({
          targetPath: filePath,
          transform: (content) => {
            if (!content.includes(oldText)) {
              throw new Error(
                `Could not find the specified text in ${filePath}`,
              );
            }
            return content.replace(oldText, newText);
          },
        });
        return `File edited successfully: ${filePath}`;
      },
    }),

    sandbox_bash: tool({
      description:
        "Execute a shell command and return its output. Allowed commands include file inspection, repository inspection, and local script/test commands such as cat, find, git, head, ls, node, npm, pwd, rg, sed, tsx, and wc.",
      inputSchema: z.object({
        command: z
          .string()
          .describe("The command to execute (e.g., 'ls', 'cat', 'node')"),
        args: z
          .array(z.string())
          .default([])
          .describe("Command arguments"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory for the command"),
      }),
      execute: async ({ command, args, cwd }) => {
        const result = await sandbox.runBash({ command, args, cwd });
        return result;
      },
    }),
  };
}
