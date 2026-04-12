import { basename } from "node:path";
import { isOutputRedirectOp, parseBashScriptAst } from "../../runtime/sandbox/bashAst";
import { normalizeBashInput } from "./bashInputNormalizer";

export type ToolConcurrencyMode = "shared" | "exclusive";
export type ToolInterruptBehavior = "cancel" | "block";
export type ToolLoadBehavior = "eager" | "deferred";

export interface ToolExecutionContract {
  concurrency: ToolConcurrencyMode;
  interruptBehavior: ToolInterruptBehavior;
  loadBehavior: ToolLoadBehavior;
  resultBudgetChars: number | null;
}

const DEFAULT_CONTRACT: ToolExecutionContract = {
  concurrency: "exclusive",
  interruptBehavior: "block",
  loadBehavior: "eager",
  resultBudgetChars: null,
};

const TOOL_CONTRACTS: Record<string, Partial<ToolExecutionContract>> = {
  glob: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: 20_000,
  },
  grep: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: 20_000,
  },
  read: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: null,
  },
  web_search: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: 24_000,
  },
  use_skill: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: 4_000,
  },
  enter_plan_mode: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: 4_000,
  },
  exit_plan_mode: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: 4_000,
  },
  write_plan_artifact: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: 4_000,
  },
  web_fetch: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 50_000,
  },
  view_image: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: 16_000,
  },
  browser_snapshot: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: null,
  },
  browser_find: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: null,
  },
  browser_wait: {
    concurrency: "exclusive",
    interruptBehavior: "cancel",
    loadBehavior: "eager",
    resultBudgetChars: null,
  },
  browser_navigate: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "eager",
    resultBudgetChars: null,
  },
  browser_click: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  browser_type: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  browser_scroll: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  browser_screenshot: {
    concurrency: "exclusive",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 12_000,
  },
  browser_media_probe: {
    concurrency: "exclusive",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 16_000,
  },
  browser_video_watch_start: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: 16_000,
  },
  browser_video_watch_poll: {
    concurrency: "exclusive",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 20_000,
  },
  browser_video_watch_stop: {
    concurrency: "exclusive",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 12_000,
  },
  chrome_relay_status: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 12_000,
  },
  chrome_relay_list_tabs: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 16_000,
  },
  chrome_relay_read: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 24_000,
  },
  chrome_relay_read_dom: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  chrome_relay_open: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  chrome_relay_navigate: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  chrome_relay_click: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  chrome_relay_type: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  chrome_relay_scroll: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  chrome_relay_screenshot: {
    concurrency: "exclusive",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 12_000,
  },
  chrome_relay_eval: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: 16_000,
  },
  chrome_relay_back: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  chrome_relay_forward: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: null,
  },
  bash: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "eager",
    resultBudgetChars: 30_000,
  },
  write: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "eager",
    resultBudgetChars: 8_000,
  },
  edit: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "eager",
    resultBudgetChars: 8_000,
  },
  document_ingest: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: 12_000,
  },
  review_coach: {
    concurrency: "exclusive",
    interruptBehavior: "block",
    loadBehavior: "deferred",
    resultBudgetChars: 12_000,
  },
  agent: {
    concurrency: "exclusive",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 24_000,
  },
  task_output: {
    concurrency: "shared",
    interruptBehavior: "cancel",
    loadBehavior: "deferred",
    resultBudgetChars: 24_000,
  },
};

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "date",
  "du",
  "echo",
  "env",
  "find",
  "grep",
  "head",
  "id",
  "ifconfig",
  "ls",
  "networksetup",
  "ping",
  "pmset",
  "ps",
  "pwd",
  "realpath",
  "rg",
  "stat",
  "sw_vers",
  "sysctl",
  "system_profiler",
  "top",
  "uname",
  "vm_stat",
  "wc",
  "which",
  "whoami",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "blame",
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "remote",
  "rev-parse",
  "show",
  "status",
]);

function resolveBaseContract(toolName: string): ToolExecutionContract {
  return {
    ...DEFAULT_CONTRACT,
    ...(TOOL_CONTRACTS[toolName] ?? {}),
  };
}

function normalizeCommandName(command: string) {
  return basename(command.trim());
}

function firstNonFlag(args: string[]) {
  for (const arg of args) {
    if (!arg || arg === "--") {
      continue;
    }

    if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return null;
}

function isSedReadOnly(args: string[]) {
  return !args.some((arg) => arg === "-i" || arg === "--in-place" || arg.startsWith("-i"));
}

function isFindReadOnly(args: string[]) {
  return !args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg));
}

function isReadOnlyBashCommand(command: string, args: string[]) {
  const normalized = normalizeCommandName(command);

  if (READ_ONLY_COMMANDS.has(normalized)) {
    if (normalized === "find") {
      return isFindReadOnly(args);
    }

    return true;
  }

  if (normalized === "sed") {
    return isSedReadOnly(args);
  }

  if (normalized === "git") {
    const subcommand = firstNonFlag(args);
    return Boolean(subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand));
  }

  return false;
}

export function isReadOnlyBashInput(input: unknown) {
  const normalized = normalizeBashInput(input) as {
    command?: string;
    args?: string[];
    script?: string;
  };

  if (normalized.script) {
    const parsed = parseBashScriptAst(normalized.script);
    if (parsed.kind !== "simple") {
      return false;
    }

    return parsed.commands.length > 0 && parsed.commands.every((command) => {
      if (command.redirects.some((redirect) => isOutputRedirectOp(redirect.op))) {
        return false;
      }

      return isReadOnlyBashCommand(command.command, command.args);
    });
  }

  if (!normalized.command) {
    return false;
  }

  return isReadOnlyBashCommand(normalized.command, normalized.args ?? []);
}

function truncateText(value: string, limit: number, label: string) {
  if (limit <= 0) {
    return "";
  }

  if (value.length <= limit) {
    return value;
  }

  const marker = `\n\n[${label} truncated at ${limit} characters]`;
  const sliceLength = Math.max(0, limit - marker.length);
  return `${value.slice(0, sliceLength)}${marker}`;
}

function applyBashResultBudget(
  result: { stdout?: unknown; stderr?: unknown },
  budget: number,
) {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const total = stdout.length + stderr.length;

  if (total <= budget) {
    return result;
  }

  const stderrBudget = Math.min(stderr.length, Math.floor(budget * 0.45));
  const stdoutBudget = Math.max(2_000, budget - stderrBudget);

  return {
    ...result,
    stdout: truncateText(stdout, stdoutBudget, "stdout"),
    stderr: truncateText(stderr, stderrBudget, "stderr"),
  };
}

export function getToolExecutionContract(toolName: string, input?: unknown): ToolExecutionContract {
  const contract = resolveBaseContract(toolName);

  if (toolName === "bash" && isReadOnlyBashInput(input)) {
    return {
      ...contract,
      concurrency: "shared",
      interruptBehavior: "cancel",
    };
  }

  return contract;
}

export function applyToolResultBudget(toolName: string, input: unknown, result: unknown) {
  const contract = getToolExecutionContract(toolName, input);
  const budget = contract.resultBudgetChars;

  if (!budget || budget <= 0) {
    return result;
  }

  if (typeof result === "string") {
    return truncateText(result, budget, "tool result");
  }

  if (
    toolName === "bash"
    && result
    && typeof result === "object"
    && ("stdout" in result || "stderr" in result)
  ) {
    return applyBashResultBudget(result as { stdout?: unknown; stderr?: unknown }, budget);
  }

  return result;
}

const PRESERVED_RESULT_KEYS = [
  "ok",
  "path",
  "url",
  "backend",
  "tabId",
  "title",
  "reason",
  "error",
  "fetchedAt",
  "imagePath",
  "prompt",
  "query",
];

function measureToolResultChars(result: unknown) {
  if (typeof result === "string") {
    return result.length;
  }

  try {
    return JSON.stringify(result)?.length ?? 0;
  } catch {
    return String(result).length;
  }
}

function truncateStructuredValue(value: unknown, maxStringChars: number): unknown {
  if (typeof value === "string") {
    return truncateText(value, maxStringChars, "field");
  }

  if (Array.isArray(value)) {
    return value.map((item) => truncateStructuredValue(item, maxStringChars));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, truncateStructuredValue(entryValue, maxStringChars)]),
    );
  }

  return value;
}

function serializeStructuredResultWithinLimit(value: unknown, limit: number) {
  if (limit <= 0) {
    return "";
  }

  if (!value || typeof value !== "object") {
    return truncateText(String(value ?? ""), limit, "tool result");
  }

  const serialized = JSON.stringify(value, null, 2);
  if (serialized && serialized.length <= limit) {
    return serialized;
  }

  for (const maxStringChars of [4000, 2000, 1000, 500, 250, 120]) {
    const shrunk = truncateStructuredValue(value, maxStringChars);
    const nextSerialized = JSON.stringify(shrunk, null, 2);
    if (nextSerialized && nextSerialized.length <= limit) {
      return nextSerialized;
    }
  }

  if (!Array.isArray(value)) {
    const preserved = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => PRESERVED_RESULT_KEYS.includes(key))
        .map(([key, entryValue]) => [key, truncateStructuredValue(entryValue, 240)]),
    );
    const minimal = {
      ...preserved,
      truncated: true,
      hint: "Aggregate tool-result budget exhausted for this model turn.",
    };
    const minimalSerialized = JSON.stringify(minimal, null, 2);
    if (minimalSerialized.length <= limit) {
      return minimalSerialized;
    }
  }

  return truncateText(serialized ?? String(value), limit, "tool result");
}

export function applyAggregateToolResultBudget(toolName: string, result: unknown, remainingChars: number) {
  if (remainingChars <= 0) {
    return serializeStructuredResultWithinLimit({
      tool: toolName,
      truncated: true,
      hint: "Aggregate tool-result budget exhausted for this model turn.",
    }, 240);
  }

  if (measureToolResultChars(result) <= remainingChars) {
    return result;
  }

  if (
    toolName === "bash"
    && result
    && typeof result === "object"
    && ("stdout" in result || "stderr" in result)
  ) {
    return applyBashResultBudget(result as { stdout?: unknown; stderr?: unknown }, remainingChars);
  }

  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === "object") {
        return serializeStructuredResultWithinLimit(parsed, remainingChars);
      }
    } catch {
      // Fall back to plain text truncation below.
    }

    return truncateText(result, remainingChars, "tool result");
  }

  return serializeStructuredResultWithinLimit(result, remainingChars);
}

export { measureToolResultChars };

export function shouldAttachSkillToolImmediately(toolName: string) {
  return resolveBaseContract(toolName).loadBehavior === "eager";
}
