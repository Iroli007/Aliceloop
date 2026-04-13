import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { tool, type ToolExecutionOptions } from "ai";
import type { BashProgressTracker, PermissionSandboxExecutor, ToolApprovalStateTracker } from "../../runtime/sandbox/types";
import { getDataDir } from "../../db/client";
import { getSandboxProjectRoot, isPathAllowed } from "../../runtime/sandbox/toolPolicy";
import { normalizeBashInput } from "./bashInputNormalizer";
import { STABLE_TOOL_PROVIDER_OPTIONS } from "./toolProviderOptions";

const execFileAsync = promisify(execFile);
const DEFAULT_GREP_HEAD_LIMIT = 250;
const DEFAULT_GLOB_LIMIT = 200;
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 2_000;
const MAX_READ_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_WINDOW_CHARS = 48_000;
const MAX_READ_WINDOW_TOKENS = 12_000;
const MAX_TRACKED_READS_PER_SESSION = 256;
const MAX_TRACKED_SESSIONS = 64;
const PERSISTED_RESULT_PREVIEW_CHARS = 4_000;
const persistedToolResultsDir = join(getDataDir(), "tool-results");

type SandboxExecutor = PermissionSandboxExecutor;
type SandboxedToolExecutionOptions = ToolExecutionOptions & {
  approvalStateTracker?: ToolApprovalStateTracker;
  bashProgressTracker?: BashProgressTracker;
};
type SliceResult<T> = {
  items: T[];
  total: number;
  offset: number;
  end: number;
  truncated: boolean;
  appliedLimit: number | null;
};

interface FileReadSnapshot {
  timestamp: number;
  offset: number;
  limit: number;
  totalLines: number;
  isPartialView: boolean;
}

interface SessionSandboxToolState {
  readFiles: Map<string, FileReadSnapshot>;
}

const sessionSandboxToolStates = new Map<string, SessionSandboxToolState>();

function buildToolErrorResponse(error: string, hint: string) {
  return JSON.stringify({ error, hint }, null, 2);
}

function hasWildcard(value: string) {
  return /[*?[\]{}]/.test(value);
}

function normalizePolicyRoots(roots: string[]) {
  return roots.filter((root) => root !== "<all>");
}

function getSessionSandboxToolState(sessionId?: string) {
  const key = sessionId?.trim() || "__default__";
  const existing = sessionSandboxToolStates.get(key);
  if (existing) {
    sessionSandboxToolStates.delete(key);
    sessionSandboxToolStates.set(key, existing);
    return existing;
  }

  const created: SessionSandboxToolState = {
    readFiles: new Map<string, FileReadSnapshot>(),
  };
  sessionSandboxToolStates.set(key, created);
  while (sessionSandboxToolStates.size > MAX_TRACKED_SESSIONS) {
    const oldestKey = sessionSandboxToolStates.keys().next().value;
    if (!oldestKey) {
      break;
    }
    sessionSandboxToolStates.delete(oldestKey);
  }
  return created;
}

function rememberFileRead(
  state: SessionSandboxToolState,
  targetPath: string,
  snapshot: FileReadSnapshot,
) {
  state.readFiles.delete(targetPath);
  state.readFiles.set(targetPath, snapshot);
  while (state.readFiles.size > MAX_TRACKED_READS_PER_SESSION) {
    const oldestKey = state.readFiles.keys().next().value;
    if (!oldestKey) {
      break;
    }
    state.readFiles.delete(oldestKey);
  }
}

async function getFileTimestamp(targetPath: string) {
  try {
    const fileStat = await stat(targetPath);
    return fileStat.mtimeMs;
  } catch {
    return Date.now();
  }
}

function parseRgLines(output: string) {
  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && line !== "(no matches)");
}

function summarizeBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function estimateTextTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function sliceItems<T>(items: T[], input?: { limit?: number; offset?: number; defaultLimit?: number }): SliceResult<T> {
  const total = items.length;
  const offset = Math.max(0, input?.offset ?? 0);
  const requestedLimit = input?.limit;
  const effectiveLimit = requestedLimit === 0 ? null : Math.max(1, requestedLimit ?? input?.defaultLimit ?? total);
  const sliced = effectiveLimit === null
    ? items.slice(offset)
    : items.slice(offset, offset + effectiveLimit);
  const end = offset + sliced.length;
  return {
    items: sliced,
    total,
    offset,
    end,
    truncated: end < total,
    appliedLimit: effectiveLimit,
  };
}

function formatPaginationSuffix(slice: SliceResult<unknown>) {
  if (slice.total === 0) {
    return "";
  }

  const shownStart = slice.offset + 1;
  const shownEnd = slice.end;
  const parts = [`showing ${shownStart}-${shownEnd} of ${slice.total}`];
  if (slice.truncated) {
    parts.push(`next offset: ${slice.end}`);
  }
  return ` | ${parts.join(" | ")}`;
}

async function sortPathsByMtimeDesc(paths: string[]) {
  const decorated = await Promise.all(paths.map(async (targetPath) => {
    try {
      const targetStat = await stat(targetPath);
      return {
        targetPath,
        mtimeMs: targetStat.mtimeMs,
      };
    } catch {
      return {
        targetPath,
        mtimeMs: 0,
      };
    }
  }));

  decorated.sort((left, right) => {
    if (right.mtimeMs === left.mtimeMs) {
      return left.targetPath.localeCompare(right.targetPath);
    }
    return right.mtimeMs - left.mtimeMs;
  });
  return decorated.map((entry) => entry.targetPath);
}

async function persistLargeTextResult(toolName: string, content: string) {
  await mkdir(persistedToolResultsDir, { recursive: true });
  const filePath = join(
    persistedToolResultsDir,
    `${toolName}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`,
  );
  await writeFile(filePath, content, "utf8");
  const preview = content.length > PERSISTED_RESULT_PREVIEW_CHARS
    ? `${content.slice(0, PERSISTED_RESULT_PREVIEW_CHARS).trimEnd()}\n\n[preview truncated]`
    : content;
  return [
    `[large ${toolName} result persisted]`,
    `path: ${filePath}`,
    "",
    preview,
  ].join("\n");
}

export function createSandboxTools(
  sandbox: SandboxExecutor,
  options?: { sessionId?: string },
) {
  const policy = sandbox.describePolicy();
  const allowedReadRoots = normalizePolicyRoots(policy.allowedReadRoots);
  const allowedWriteRoots = normalizePolicyRoots(policy.allowedWriteRoots);
  const allowedCwdRoots = normalizePolicyRoots(policy.allowedCwdRoots);
  const defaultSearchRoot = policy.defaultCwd ?? allowedReadRoots[0] ?? allowedCwdRoots[0] ?? getSandboxProjectRoot();
  const sessionState = getSessionSandboxToolState(options?.sessionId);

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
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
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
        outputMode: z
          .enum(["content", "files_with_matches", "count"])
          .optional()
          .describe("Result format. `files_with_matches` is the default and cheapest mode."),
        type: z
          .string()
          .optional()
          .describe("Ripgrep file type filter such as `ts`, `js`, `py`, or `rust`."),
        headLimit: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(`Maximum result entries to return after offset. Defaults to ${DEFAULT_GREP_HEAD_LIMIT}. Use 0 for unlimited.`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Skip the first N result entries before applying headLimit."),
        multiline: z
          .boolean()
          .optional()
          .describe("Enable multiline matching so patterns may span line breaks."),
      }),
      execute: async ({
        pattern,
        path,
        glob: globPattern,
        fixedStrings,
        caseSensitive,
        maxCount,
        context: contextLines,
        outputMode = "files_with_matches",
        type,
        headLimit,
        offset,
        multiline,
      }) => {
        const searchPath = resolve(defaultSearchRoot, path ?? ".");
        if (allowedReadRoots.length > 0 && !isPathAllowed(searchPath, allowedReadRoots)) {
          return buildToolErrorResponse(
            "Search path is outside the allowed workspace roots.",
            `Use a path inside ${defaultSearchRoot} instead.`,
          );
        }

        const args: string[] = ["--hidden", "--no-heading", "--color", "never", "--max-columns", "500"];
        for (const vcsDir of [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]) {
          args.push("--glob", `!${vcsDir}`);
        }
        if (fixedStrings) args.push("--fixed-strings");
        if (caseSensitive === true) args.push("--case-sensitive");
        else if (caseSensitive === false) args.push("--ignore-case");
        if (maxCount !== undefined) args.push("--max-count", String(maxCount));
        if (outputMode === "content") {
          args.push("--line-number");
          if (contextLines !== undefined) args.push("--context", String(contextLines));
        } else if (outputMode === "files_with_matches") {
          args.push("--files-with-matches");
        } else if (outputMode === "count") {
          args.push("--count");
        }
        if (type) args.push("--type", type);
        if (globPattern) args.push("--glob", globPattern);
        if (multiline) args.push("-U", "--multiline-dotall");
        args.push("--", pattern, searchPath);

        const rawOutput = await execRg(args, defaultSearchRoot, 15_000);
        const outputLines = parseRgLines(rawOutput);

        if (outputMode === "content") {
          const slice = sliceItems(outputLines, {
            limit: headLimit,
            offset,
            defaultLimit: DEFAULT_GREP_HEAD_LIMIT,
          });
          if (slice.total === 0) {
            return "No matches found";
          }
          const resultText = [
            `[grep: content${formatPaginationSuffix(slice)}]`,
            ...slice.items,
          ].join("\n");
          return resultText.length > 20_000
            ? await persistLargeTextResult("grep", resultText)
            : resultText;
        }

        if (outputMode === "count") {
          const slice = sliceItems(outputLines, {
            limit: headLimit,
            offset,
            defaultLimit: DEFAULT_GREP_HEAD_LIMIT,
          });
          if (slice.total === 0) {
            return "No matches found";
          }
          const resultText = [
            `[grep: count${formatPaginationSuffix(slice)}]`,
            ...slice.items,
          ].join("\n");
          return resultText.length > 20_000
            ? await persistLargeTextResult("grep", resultText)
            : resultText;
        }

        const sortedMatches = await sortPathsByMtimeDesc(outputLines);
        const slice = sliceItems(sortedMatches, {
          limit: headLimit,
          offset,
          defaultLimit: DEFAULT_GREP_HEAD_LIMIT,
        });
        if (slice.total === 0) {
          return "No files found";
        }
        const resultText = [
          `[grep: files_with_matches${formatPaginationSuffix(slice)}]`,
          ...slice.items,
        ].join("\n");
        return resultText.length > 20_000
          ? await persistLargeTextResult("grep", resultText)
          : resultText;
      },
    }),

    glob: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
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
        limit: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(`Maximum number of matched paths to return after offset. Defaults to ${DEFAULT_GLOB_LIMIT}. Use 0 for unlimited.`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Skip the first N matched paths before applying limit."),
      }),
      execute: async ({ pattern, cwd, limit, offset }) => {
        const baseCwd = resolve(defaultSearchRoot, cwd ?? ".");
        if (allowedCwdRoots.length > 0 && !isPathAllowed(baseCwd, allowedCwdRoots)) {
          return buildToolErrorResponse(
            "Glob cwd is outside the allowed workspace roots.",
            `Use a cwd inside ${defaultSearchRoot} instead.`,
          );
        }

        const args: string[] = ["--files", "--glob", pattern, baseCwd];
        const rawOutput = await execRg(args, baseCwd, 10_000);
        const matchedPaths = await sortPathsByMtimeDesc(parseRgLines(rawOutput));
        const slice = sliceItems(matchedPaths, {
          limit,
          offset,
          defaultLimit: DEFAULT_GLOB_LIMIT,
        });
        if (slice.total === 0) {
          return "No files found";
        }
        const resultText = [
          `[glob${formatPaginationSuffix(slice)}]`,
          ...slice.items,
        ].join("\n");
        return resultText.length > 20_000
          ? await persistLargeTextResult("glob", resultText)
          : resultText;
      },
    }),

    read: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Read the content of a file at a known, specific path with a sliding window.\n\nUse case: You have identified the target file via glob or grep and now need to carefully read its source code.\n\nThe tool returns a window of lines starting from `offset` (default 0, 0-indexed) with up to `limit` lines (default 500, max 2000). The response header always includes the total line count so you can decide whether to request the next window. Files above 2 MiB and windows above roughly 48k chars / 12k tokens are rejected.\n\nWARNING: You MUST provide an exact relative or absolute file path (e.g. src/app.ts). NEVER pass wildcards or directory names to this tool. Re-reading the exact same unchanged window is wasteful and may return a dedup reminder instead of the file contents.",
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
          .max(MAX_READ_LIMIT)
          .optional()
          .describe(`Maximum number of lines to return (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT})`),
      }),
      execute: async ({ filePath, offset: rawOffset, limit: rawLimit }, options?: SandboxedToolExecutionOptions) => {
        const resolvedPath = resolve(filePath);
        // 通配符检查直接返回错误提示
        if (hasWildcard(filePath)) {
          return buildToolErrorResponse(
            "Path contains a wildcard.",
            "Please use `glob` to discover matching files first, then call `read` with one exact file path."
          );
        }
        if (allowedReadRoots.length > 0 && !isPathAllowed(resolvedPath, allowedReadRoots)) {
          return buildToolErrorResponse(
            "Read path is outside the allowed workspace roots.",
            `Use a path inside ${defaultSearchRoot} instead.`,
          );
        }

        const currentStat = await lstat(resolvedPath).catch(() => null);
        const previousSnapshot = sessionState.readFiles.get(resolvedPath);
        const offset = rawOffset ?? 0;
        const limit = rawLimit ?? DEFAULT_READ_LIMIT;
        if (currentStat?.isFile() && currentStat.size > MAX_READ_FILE_BYTES) {
          return buildToolErrorResponse(
            `File is too large to read safely (${summarizeBytes(currentStat.size)}).`,
            `Use \`grep\` or \`glob\` to narrow the target first. \`read\` only accepts files up to ${summarizeBytes(MAX_READ_FILE_BYTES)}.`,
          );
        }
        if (currentStat && previousSnapshot && currentStat.mtimeMs <= previousSnapshot.timestamp) {
          const sameWindow = previousSnapshot.offset === offset && previousSnapshot.limit === limit;
          if (sameWindow) {
            const endLine = Math.min(offset + limit, previousSnapshot.totalLines);
            return `[file unchanged: ${filePath} | lines ${offset + 1}-${endLine} of ${previousSnapshot.totalLines}] Earlier read result for this exact range is still current; reuse it instead of reading again.`;
          }
        }

        const readResult = await sandbox.readTextFileWindow({
          targetPath: resolvedPath,
          offset,
          limit,
          toolCallId: options?.toolCallId,
          approvalStateTracker: options?.approvalStateTracker,
        });
        const totalLines = readResult.totalLines;
        const windowText = readResult.content;
        const estimatedTokens = estimateTextTokens(windowText);
        const endLine = Math.min(offset + limit, totalLines);
        const hasMore = endLine < totalLines;
        const timestamp = currentStat?.mtimeMs ?? await getFileTimestamp(resolvedPath);
        rememberFileRead(sessionState, resolvedPath, {
          timestamp,
          offset,
          limit,
          totalLines,
          isPartialView: offset > 0 || endLine < totalLines,
        });

        if (offset >= totalLines) {
          return `[file: ${filePath} | total lines: ${totalLines}] Requested offset ${offset} is beyond the end of the file.`;
        }
        if (windowText.length > MAX_READ_WINDOW_CHARS || estimatedTokens > MAX_READ_WINDOW_TOKENS) {
          const suggestedLimit = Math.max(50, Math.floor(limit / 2));
          return buildToolErrorResponse(
            `Requested read window is too large (${windowText.length} chars, ~${estimatedTokens} tokens).`,
            `Retry with a smaller \`limit\` (for example ${suggestedLimit}) so the result stays under ${MAX_READ_WINDOW_CHARS} chars and ~${MAX_READ_WINDOW_TOKENS} tokens.`,
          );
        }

        const header = `[file: ${filePath} | lines ${offset + 1}-${endLine} of ${totalLines}${hasMore ? ` | next offset: ${endLine}` : ""}]`;
        return windowText.length > 0 ? `${header}\n${windowText}` : header;
      },
    }),

    write: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Strictly used to create a completely NEW file from scratch, or to 100% overwrite an extremely small file.\n\nUse case: Generating boilerplate files or creating new test cases.\n\nWARNING: It is STRICTLY FORBIDDEN to use this tool to modify existing code files that exceed 50 lines. Outputting the entire file will cause severe truncation errors. To modify existing code, you MUST use the edit tool. If the target file already exists, you MUST read it first in the current session or the write will be rejected.",
      inputSchema: z.object({
        targetPath: z
          .string()
          .describe("Absolute path to the file to write"),
        content: z
          .string()
          .describe("The text content to write to the file"),
      }),
      execute: async ({ targetPath, content }, options?: SandboxedToolExecutionOptions) => {
        const resolvedPath = resolve(targetPath);
        if (allowedWriteRoots.length > 0 && !isPathAllowed(resolvedPath, allowedWriteRoots)) {
          return buildToolErrorResponse(
            "Write path is outside the allowed workspace roots.",
            `Use a path inside ${defaultSearchRoot} instead.`,
          );
        }
        const existingStat = await lstat(resolvedPath).catch(() => null);
        if (existingStat) {
          const previousSnapshot = sessionState.readFiles.get(resolvedPath);
          if (!previousSnapshot || previousSnapshot.isPartialView) {
            return buildToolErrorResponse(
              "File has not been fully read yet.",
              "Use `read` on the exact file path first, then retry the write.",
            );
          }
          if (existingStat.mtimeMs > previousSnapshot.timestamp) {
            return buildToolErrorResponse(
              "File has been modified since the last read.",
              "Read the file again before writing so you do not overwrite newer changes.",
            );
          }
        }
        await sandbox.writeTextFile({
          targetPath: resolvedPath,
          content,
          toolCallId: options?.toolCallId,
          approvalStateTracker: options?.approvalStateTracker,
        });
        const timestamp = await getFileTimestamp(resolvedPath);
        const totalLines = content.split("\n").length;
        rememberFileRead(sessionState, resolvedPath, {
          timestamp,
          offset: 0,
          limit: totalLines,
          totalLines,
          isPartialView: false,
        });
        return `File written successfully: ${resolvedPath}`;
      },
    }),

    edit: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Used for localized, precise block replacements (Search and Replace) within existing code files.\n\nUse case: Fixing bugs, adding a few lines of logic, or modifying specific functions.\n\nRULE: You must provide the exact [Original Code Block] to be replaced and the new [Replacement Code Block]. DO NOT output the entire file content. You must read the file first, and repeated matches require either more context or `replaceAll: true`.",
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
        replaceAll: z
          .boolean()
          .optional()
          .default(false)
          .describe("Replace all exact matches of oldText. Defaults to false."),
      }),
      execute: async ({ filePath, oldText, newText, replaceAll }, options?: SandboxedToolExecutionOptions) => {
        const resolvedPath = resolve(filePath);
        if (allowedReadRoots.length > 0 && !isPathAllowed(resolvedPath, allowedReadRoots)) {
          return buildToolErrorResponse(
            "Edit path is outside the allowed workspace roots.",
            `Use a path inside ${defaultSearchRoot} instead.`,
          );
        }
        if (allowedWriteRoots.length > 0 && !isPathAllowed(resolvedPath, allowedWriteRoots)) {
          return buildToolErrorResponse(
            "Edit path is outside the allowed workspace roots.",
            `Use a path inside ${defaultSearchRoot} instead.`,
          );
        }
        const previousSnapshot = sessionState.readFiles.get(resolvedPath);
        if (!previousSnapshot || previousSnapshot.isPartialView) {
          return buildToolErrorResponse(
            "File has not been fully read yet.",
            "Use `read` on the exact file path first, then retry the edit.",
          );
        }
        const existingStat = await lstat(resolvedPath).catch(() => null);
        if (!existingStat) {
          return buildToolErrorResponse(
            `Could not find the specified text in ${resolvedPath}.`,
            "Read the file again to confirm the path and contents, then retry the edit.",
          );
        }
        if (existingStat.mtimeMs > previousSnapshot.timestamp) {
          return buildToolErrorResponse(
            "File has been modified since the last read.",
            "Read the file again before editing so you do not patch stale content.",
          );
        }

        const updatedContent = await sandbox.editTextFile({
          targetPath: resolvedPath,
          toolCallId: options?.toolCallId,
          approvalStateTracker: options?.approvalStateTracker,
          transform: (content) => {
            // 抹平操作系统差异
            const normalizedContent = content.replace(/\r\n/g, '\n');
            const normalizedOld = oldText.replace(/\r\n/g, '\n');
            if (!normalizedOld.length) {
              throw new Error("oldText cannot be empty.");
            }
            if (normalizedOld === newText) {
              throw new Error("oldText and newText are identical; no edit is needed.");
            }

            // 精确匹配
            const occurrences = normalizedContent.split(normalizedOld).length - 1;
            if (occurrences === 0) {
              throw new Error(
                `Could not find the specified text in ${resolvedPath}.`
              );
            }
            if (occurrences > 1 && !replaceAll) {
              throw new Error(
                `Ambiguous match! Found ${occurrences} identical occurrences. Please include more context or set replaceAll to true.`
              );
            }
            return replaceAll
              ? normalizedContent.split(normalizedOld).join(newText)
              : normalizedContent.replace(normalizedOld, newText);
          },
        });
        const normalizedUpdatedContent = updatedContent.replace(/\r\n/g, "\n");
        const totalLines = normalizedUpdatedContent.split("\n").length;
        const timestamp = await getFileTimestamp(resolvedPath);
        rememberFileRead(sessionState, resolvedPath, {
          timestamp,
          offset: 0,
          limit: totalLines,
          totalLines,
          isPartialView: false,
        });
        return `File edited successfully: ${resolvedPath}`;
      },
    }),

    bash: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
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
      execute: async ({ command, args, script, cwd }, options?: SandboxedToolExecutionOptions) => {
        const result = await sandbox.runBash({
          command: command?.trim() || "",
          args,
          script,
          cwd,
          toolCallId: options?.toolCallId,
          approvalStateTracker: options?.approvalStateTracker,
          progressTracker: options?.bashProgressTracker,
        });
        const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("\n\n");
        if (combinedOutput.length > 30_000) {
          return {
            stdout: await persistLargeTextResult("bash", combinedOutput),
            stderr: "",
          };
        }
        return result;
      },
    }),
  };
}
