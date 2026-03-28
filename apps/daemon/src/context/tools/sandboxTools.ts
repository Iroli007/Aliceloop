import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { tool } from "ai";
import type { createPermissionSandboxExecutor } from "../../services/sandboxExecutor";
import { getSandboxProjectRoot, isPathAllowed } from "../../runtime/sandbox/toolPolicy";
import { normalizeBashInput } from "./bashInputNormalizer";

const execFileAsync = promisify(execFile);

type SandboxExecutor = ReturnType<typeof createPermissionSandboxExecutor>;

function buildToolErrorResponse(error: string, hint: string) {
  return JSON.stringify({ error, hint }, null, 2);
}

function hasWildcard(value: string) {
  return /[*?[\]{}]/.test(value);
}

function normalizePolicyRoots(roots: string[]) {
  return roots.filter((root) => root !== "<all>");
}

export function createSandboxTools(sandbox: SandboxExecutor) {
  const policy = sandbox.describePolicy();
  const allowedReadRoots = normalizePolicyRoots(policy.allowedReadRoots);
  const allowedCwdRoots = normalizePolicyRoots(policy.allowedCwdRoots);
  const defaultSearchRoot = policy.defaultCwd ?? allowedReadRoots[0] ?? allowedCwdRoots[0] ?? getSandboxProjectRoot();

  async function execRg(args: string[], cwd: string, timeoutMs: number): Promise<string> {
    try {
      const { stdout } = await execFileAsync("rg", args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { HOME: process.env.HOME!, PATH: process.env.PATH! },
      });
      return stdout || "(no matches)";
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
      const errorCode = (err as { code?: string | number }).code;
      // rg 返回 1 表示没有匹配，这是正常的
      if (errorCode === 1 || errorCode === "1") {
        return err.stdout || "(no matches)";
      }
      // rg 不存在
      if (err.code === "ENOENT") {
        throw new Error("ripgrep (rg) not found on PATH");
      }
      // 其他错误返回 stderr 或错误信息
      throw new Error(err.stderr || err.message || String(error));
    }
  }

  return {
    grep: tool({
      description:
        "Strictly used for global text or regular expression searches inside files in the current workspace.\n\nUse case: Locating specific function definitions, variable names, or error logs (e.g., searching for function login). It returns the exact file path and line numbers containing the match.\n\nWARNING: If you already know the exact file path and want to view its full context, DO NOT use this tool. Use the read tool instead.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe("The regex pattern to search for"),
        path: z
          .string()
          .optional()
          .describe("Directory or file to search in (defaults to the current workspace)"),
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
        const searchPath = resolve(defaultSearchRoot, path ?? ".");
        if (allowedReadRoots.length > 0 && !isPathAllowed(searchPath, allowedReadRoots)) {
          return buildToolErrorResponse(
            "Search path is outside the allowed workspace roots.",
            `Use a path inside ${defaultSearchRoot} instead.`,
          );
        }

        const args: string[] = ["--line-number", "--no-heading", "--color", "never"];
        if (fixedStrings) args.push("--fixed-strings");
        if (caseSensitive === true) args.push("--case-sensitive");
        else if (caseSensitive === false) args.push("--ignore-case");
        if (maxCount !== undefined) args.push("--max-count", String(maxCount));
        if (contextLines !== undefined) args.push("--context", String(contextLines));
        if (globPattern) args.push("--glob", globPattern);
        args.push("--", pattern, searchPath);

        return execRg(args, defaultSearchRoot, 15_000);
      },
    }),

    glob: tool({
      description:
        "Strictly used to find files and directories in the current workspace by name or wildcard.\n\nUse case: Discovering workspace structure or finding specific files (e.g., **/*.test.ts).\n\nWARNING: This tool will NEVER return the internal code content of a file. If you need to search for specific code logic, you MUST use the grep tool.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe("Glob pattern to match (e.g. 'src/**/*.ts', '*.json')"),
        cwd: z
          .string()
          .optional()
          .describe("Base directory for the glob (defaults to the current workspace)"),
      }),
      execute: async ({ pattern, cwd }) => {
        const baseCwd = resolve(defaultSearchRoot, cwd ?? ".");
        if (allowedCwdRoots.length > 0 && !isPathAllowed(baseCwd, allowedCwdRoots)) {
          return buildToolErrorResponse(
            "Glob cwd is outside the allowed workspace roots.",
            `Use a cwd inside ${defaultSearchRoot} instead.`,
          );
        }

        const args: string[] = ["--files", "--glob", pattern, baseCwd];

        return execRg(args, baseCwd, 10_000);
      },
    }),

    read: tool({
      description:
        "Read the content of a file at a known, specific path with a sliding window.\n\nUse case: You have identified the target file via glob or grep and now need to carefully read its source code.\n\nThe tool returns a window of lines starting from `offset` (default 0, 0-indexed) with up to `limit` lines (default 500). The response header always includes the total line count so you can decide whether to request the next window.\n\nWARNING: You MUST provide an exact relative or absolute file path (e.g. src/app.ts). NEVER pass wildcards or directory names to this tool!",
      inputSchema: z.object({
        filePath: z
          .string()
          .describe("Absolute path to the file to read"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-indexed starting line number (default 0)"),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum number of lines to return (default 500)"),
      }),
      execute: async ({ filePath, offset: rawOffset, limit: rawLimit }) => {
        const resolvedPath = resolve(filePath);
        // 通配符检查直接返回错误提示
        if (hasWildcard(filePath)) {
          return buildToolErrorResponse(
            "Path contains a wildcard.",
            "Please use `glob` to discover matching files first, then call `read` with one exact file path."
          );
        }

        const content = await sandbox.readTextFile({ targetPath: resolvedPath });
        const allLines = content.split("\n");
        const totalLines = allLines.length;
        const offset = rawOffset ?? 0;
        const limit = rawLimit ?? 500;
        const windowLines = allLines.slice(offset, offset + limit);
        const endLine = Math.min(offset + limit, totalLines);
        const hasMore = endLine < totalLines;

        const header = `[file: ${filePath} | lines ${offset + 1}-${endLine} of ${totalLines}${hasMore ? ` | next offset: ${endLine}` : ""}]`;
        return `${header}\n${windowLines.join("\n")}`;
      },
    }),

    write: tool({
      description:
        "Strictly used to create a completely NEW file from scratch, or to 100% overwrite an extremely small file.\n\nUse case: Generating boilerplate files or creating new test cases.\n\nWARNING: It is STRICTLY FORBIDDEN to use this tool to modify existing code files that exceed 50 lines. Outputting the entire file will cause severe truncation errors. To modify existing code, you MUST use the edit tool.",
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

    edit: tool({
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
        await sandbox.editTextFile({
          targetPath: filePath,
          transform: (content) => {
            // 抹平操作系统差异
            const normalizedContent = content.replace(/\r\n/g, '\n');
            const normalizedOld = oldText.replace(/\r\n/g, '\n');

            // 精确匹配
            const occurrences = normalizedContent.split(normalizedOld).length - 1;
            if (occurrences === 1) {
              return normalizedContent.replace(normalizedOld, newText);
            }

            // 匹配超过 1 次
            if (occurrences > 1) {
              throw new Error(
                `Ambiguous match! Found ${occurrences} identical occurrences. Please include more context.`
              );
            }

            // 弹性匹配
            const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const fuzzyRegexString = normalizedOld
              .trim()
              .split(/\s+/)
              .map(escapeRegex)
              .join('\\s+');

            if (!fuzzyRegexString) {
              throw new Error("oldText cannot be empty or just whitespace.");
            }

            const fuzzyRegex = new RegExp(fuzzyRegexString, 'g');
            const fuzzyMatches = [...normalizedContent.matchAll(fuzzyRegex)];

            if (fuzzyMatches.length === 0) {
              throw new Error(`Could not find the specified text in ${filePath}.`);
            }

            if (fuzzyMatches.length > 1) {
              throw new Error(`Ambiguous fuzzy match! Found ${fuzzyMatches.length} similar occurrences.`);
            }

            return normalizedContent.replace(fuzzyMatches[0][0], newText);
          },
        });
        return `File edited successfully: ${filePath}`;
      },
    }),

    bash: tool({
      description:
        "Execute shell commands and return their output. You can either pass a single executable in `command` plus tokenized `args`, or pass a multi-command shell line in `script` when you need chaining or pipelines such as `which aliceloop && aliceloop config list` or `ifconfig | grep \"inet \"`. Do not set both forms at once. In development mode, `script` supports simple chaining and pipelines only; avoid redirection and command substitution there. In full-access mode, normal shell script syntax is allowed. Allowed commands include file inspection, repository inspection, local script/test commands, environment diagnosis, Aliceloop CLI inspection, process/path inspection, system diagnostics, and safe file deletion.",
      inputSchema: z.preprocess(normalizeBashInput, z.object({
        command: z
          .string()
          .optional()
          .describe("Single executable name only (e.g., 'ls', 'cat', 'node', 'aliceloop')"),
        args: z
          .array(z.string())
          .default([])
          .describe("Command arguments, one token per entry"),
        script: z
          .string()
          .optional()
          .describe("Optional shell line for multi-command execution (supports pipes and &&/||/;)"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory for the command"),
      }).superRefine((value, ctx) => {
        const hasCommand = Boolean(value.command?.trim());
        const hasScript = Boolean(value.script?.trim());

        if (hasCommand === hasScript) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provide either `command` or `script`, but not both.",
            path: hasCommand ? ["script"] : ["command"],
          });
        }
      })),
      execute: async ({ command, args, script, cwd }) => {
        const result = await sandbox.runBash({
          command: command?.trim() || "",
          args,
          script,
          cwd,
        });
        return result;
      },
    }),
  };
}
