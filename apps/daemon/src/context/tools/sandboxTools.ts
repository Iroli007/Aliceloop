import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { tool } from "ai";
import type { createPermissionSandboxExecutor } from "../../services/sandboxExecutor";
import { getSandboxProjectRoot } from "../../runtime/sandbox/toolPolicy";

const execFileAsync = promisify(execFile);

type SandboxExecutor = ReturnType<typeof createPermissionSandboxExecutor>;

function buildToolErrorResponse(error: string, hint: string) {
  return JSON.stringify({ error, hint }, null, 2);
}

function hasWildcard(value: string) {
  return /[*?[\]{}]/.test(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function guardReadableFilePath(filePath: string) {
  if (hasWildcard(filePath)) {
    return buildToolErrorResponse(
      "Path contains a wildcard, but sandbox_read requires an exact file path.",
      "You attempted to use `sandbox_read` with a wildcard path. Please use `sandbox_glob` to discover matching files first, then call `sandbox_read` again with one exact file path.",
    );
  }

  try {
    const stats = await lstat(filePath);
    if (stats.isDirectory()) {
      return buildToolErrorResponse(
        "Target is a directory, not a file.",
        "You attempted to use `sandbox_read` on a directory. Please use `sandbox_glob` to view the directory structure, or provide a specific file path instead.",
      );
    }
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes("ENOENT")) {
      return buildToolErrorResponse(
        "Target file does not exist.",
        "You attempted to use `sandbox_read` on a path that does not exist. Please use `sandbox_glob` or `sandbox_grep` to locate the correct file path first.",
      );
    }
  }

  return null;
}

function mapToolExecutionError(toolName: string, error: unknown) {
  const message = getErrorMessage(error);

  if (toolName === "sandbox_read" && message.includes("EISDIR")) {
    return buildToolErrorResponse(
      "Target is a directory, not a file.",
      "You attempted to use `sandbox_read` on a directory. Please use `sandbox_glob` to view the directory structure, or provide a specific file path instead.",
    );
  }

  if (toolName === "sandbox_read" && message.includes("read denied")) {
    return buildToolErrorResponse(
      "Read permission denied for this path.",
      "This path is outside the current readable roots. Please use a file inside the mounted workspace, upload the folder so it becomes a readable root, or request an elevated read if appropriate.",
    );
  }

  if (toolName === "sandbox_write" && message.includes("write denied")) {
    return buildToolErrorResponse(
      "Write permission denied for this path.",
      "This path is outside the current writable roots. Please write inside the mounted workspace, upload or mount the target folder first, or request an elevated write if appropriate.",
    );
  }

  if (toolName === "sandbox_edit" && message.includes("Could not find the specified text")) {
    return buildToolErrorResponse(
      "Original code block was not found.",
      "You attempted to use `sandbox_edit` without providing an exact existing code block. Please read the file first, then pass the exact [Original Code Block] and [Replacement Code Block].",
    );
  }

  throw error;
}

function pickSearchEnvironment() {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "LANG", "USER"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

export function createSandboxTools(sandbox: SandboxExecutor) {
  const projectRoot = getSandboxProjectRoot();

  async function execRg(args: string[], cwd: string, timeoutMs: number): Promise<string> {
    try {
      const { stdout } = await execFileAsync("rg", args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: pickSearchEnvironment(),
      });
      return stdout || "(no matches)";
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; code?: string | number };
      const code = err.code == null ? undefined : String(err.code);
      if (code === "1") {
        return "(no matches)";
      }
      if (code === "ENOENT") {
        throw new Error("ripgrep (rg) not found on PATH; install it or ensure it is available");
      }
      const partial = err.stdout?.trim();
      if (partial) {
        return partial;
      }
      throw error;
    }
  }

  return {
    sandbox_grep: tool({
      description:
        "Strictly used for global text or regular expression searches INSIDE files.\n\nUse case: Locating specific function definitions, variable names, or error logs (e.g., searching for function login). It returns the exact file path and line numbers containing the match.\n\nWARNING: If you already know the exact file path and want to view its full context, DO NOT use this tool. Use the sandbox_read tool instead.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe("The regex pattern to search for"),
        path: z
          .string()
          .optional()
          .describe("Directory or file to search in (defaults to project root)"),
        glob: z
          .string()
          .optional()
          .describe("Glob pattern to filter files (e.g. '*.ts', '*.{js,tsx}')"),
        fixedStrings: z
          .boolean()
          .optional()
          .describe("Treat pattern as a literal string instead of regex"),
        caseSensitive: z
          .boolean()
          .optional()
          .describe("Force case-sensitive search (default: smart case)"),
        maxCount: z
          .number()
          .optional()
          .describe("Maximum number of matches per file"),
        context: z
          .number()
          .optional()
          .describe("Number of context lines before and after each match"),
      }),
      execute: async ({ pattern, path, glob: globPattern, fixedStrings, caseSensitive, maxCount, context: contextLines }) => {
        const searchPath = resolve(path ?? projectRoot);
        const args: string[] = ["--line-number", "--no-heading", "--color", "never"];
        if (fixedStrings) args.push("--fixed-strings");
        if (caseSensitive === true) args.push("--case-sensitive");
        else if (caseSensitive === false) args.push("--ignore-case");
        if (maxCount !== undefined) args.push("--max-count", String(maxCount));
        if (contextLines !== undefined) args.push("--context", String(contextLines));
        if (globPattern) args.push("--glob", globPattern);
        args.push("--", pattern, searchPath);

        return execRg(args, projectRoot, 15_000);
      },
    }),

    sandbox_glob: tool({
      description:
        "Strictly used to find files and directories in the project by name or wildcard.\n\nUse case: Discovering project structure or finding specific files (e.g., **/*.test.ts).\n\nWARNING: This tool will NEVER return the internal code content of a file. If you need to search for specific code logic, you MUST use the sandbox_grep tool.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe("Glob pattern to match (e.g. 'src/**/*.ts', '*.json')"),
        cwd: z
          .string()
          .optional()
          .describe("Base directory for the glob (defaults to project root)"),
      }),
      execute: async ({ pattern, cwd }) => {
        const baseCwd = resolve(cwd ?? projectRoot);
        const args: string[] = ["--files", "--glob", pattern, baseCwd];

        return execRg(args, baseCwd, 10_000);
      },
    }),

    sandbox_read: tool({
      description:
        "Strictly used to read the complete content of a file at a known, specific path.\n\nUse case: You have identified the target file via glob or grep and now need to carefully read its source code.\n\nWARNING: You MUST provide an exact relative or absolute file path (e.g. src/app.ts). NEVER pass wildcards or directory names to this tool!",
      inputSchema: z.object({
        filePath: z
          .string()
          .describe("Absolute path to the file to read"),
      }),
      execute: async ({ filePath }) => {
        const resolvedPath = resolve(filePath);
        const preflightError = await guardReadableFilePath(resolvedPath);
        if (preflightError) {
          return preflightError;
        }

        try {
          const content = await sandbox.readTextFile({ targetPath: resolvedPath });
          return content;
        } catch (error) {
          return mapToolExecutionError("sandbox_read", error);
        }
      },
    }),

    sandbox_write: tool({
      description:
        "Strictly used to create a completely NEW file from scratch, or to 100% overwrite an extremely small file.\n\nUse case: Generating boilerplate files or creating new test cases.\n\nWARNING: It is STRICTLY FORBIDDEN to use this tool to modify existing code files that exceed 50 lines. Outputting the entire file will cause severe truncation errors. To modify existing code, you MUST use the sandbox_edit tool.",
      inputSchema: z.object({
        targetPath: z
          .string()
          .describe("Absolute path to the file to write"),
        content: z
          .string()
          .describe("The text content to write to the file"),
      }),
      execute: async ({ targetPath, content }) => {
        try {
          await sandbox.writeTextFile({ targetPath, content });
          return `File written successfully: ${targetPath}`;
        } catch (error) {
          return mapToolExecutionError("sandbox_write", error);
        }
      },
    }),

    sandbox_edit: tool({
      description:
        "Used for localized, precise block replacements (Search and Replace) within existing code files.\n\nUse case: Fixing bugs, adding a few lines of logic, or modifying specific functions.\n\nRULE: You must provide the exact [Original Code Block] to be replaced and the new [Replacement Code Block]. DO NOT output the entire file content!",
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
        try {
          await sandbox.editTextFile({
            targetPath: filePath,
            transform: (content) => {
              // 1. 抹平操作系统差异（防止 Windows \r\n 和 Linux \n 打架）
              const normalizedContent = content.replace(/\r\n/g, '\n');
              const normalizedOld = oldText.replace(/\r\n/g, '\n');

              // 2. 统计精确匹配的次数
              const occurrences = normalizedContent.split(normalizedOld).length - 1;

              // 🟢 完美匹配 1 次：最安全的替换
              if (occurrences === 1) {
                return normalizedContent.replace(normalizedOld, newText);
              }

              // 🔴 匹配超过 1 次：触发"唯一性校验拦截"
              if (occurrences > 1) {
                throw new Error(
                  `Ambiguous match! Found ${occurrences} identical occurrences of the provided oldText. Please include more surrounding context (lines above and below) in your oldText to make it strictly unique.`
                );
              }

              // 🟡 匹配 0 次：启动"弹性空白符匹配 (Fuzzy Whitespace Match)"
              // LLM 经常漏掉前置缩进，我们把 oldText 里所有的连续空格/换行，全部转换成正则的 \s+
              const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const fuzzyRegexString = normalizedOld
                .trim()
                .split(/\s+/) // 按空白符打散
                .map(escapeRegex)
                .join('\\s+'); // 用 \s+ 重新连接

              if (!fuzzyRegexString) {
                throw new Error("oldText cannot be empty or just whitespace.");
              }

              const fuzzyRegex = new RegExp(fuzzyRegexString, 'g');
              const fuzzyMatches = [...normalizedContent.matchAll(fuzzyRegex)];

              if (fuzzyMatches.length === 0) {
                throw new Error(
                  `Could not find the specified text in ${filePath}. Please ensure indentation, spaces, and line endings match exactly. Hint: use sandbox_read to get the exact original text.`
                );
              }

              if (fuzzyMatches.length > 1) {
                throw new Error(
                  `Ambiguous fuzzy match! Found ${fuzzyMatches.length} similar occurrences (ignoring spacing differences). Please include more surrounding context.`
                );
              }

              // 🟢 弹性匹配成功 1 次：用原文中实际匹配到的带真实缩进的字符串块进行替换
              return normalizedContent.replace(fuzzyMatches[0][0], newText);
            },
          });
          return `File edited successfully: ${filePath}`;
        } catch (error) {
          return mapToolExecutionError("sandbox_edit", error);
        }
      },
    }),

    sandbox_bash: tool({
      description:
        "Execute a shell command and return its output. Allowed commands include file inspection, repository inspection, local script/test commands, and safe file deletion. Allowed commands: cat, find, git, head, ls, node, npm, pwd, rg, rm, rmdir, sed, tsx, wc. Use `rm` to delete files previously generated by Aliceloop and `rmdir` for empty directories.",
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
