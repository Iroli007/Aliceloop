import { extractStructuredPlanDraft } from "@aliceloop/runtime-core";

import { MessageContent } from "./MessageContent";
import { SourceLinksSection, type SourceLink } from "./SourceLinks";
import type { ToolWorkflowEntry } from "./useShellConversation";

interface ToolWorkflowCardProps {
  entry: ToolWorkflowEntry;
}

const toolLabelMap: Record<string, string> = {
  bash: "Bash",
  browser_click: "Browser Click",
  browser_find: "Browser Find",
  browser_navigate: "Browser Navigate",
  browser_scroll: "Browser Scroll",
  browser_snapshot: "Browser Snapshot",
  browser_screenshot: "Browser Screenshot",
  browser_type: "Browser Type",
  browser_wait: "Browser Wait",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  skill: "Skill",
  agent: "Agent",
  task_output: "Background Agent",
  tool_search: "Tool Search",
  tool_search_tool_bm25: "Tool Search",
  web_fetch: "Web Fetch",
  web_search: "Web Search",
  write: "Write",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tryParseJson(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if ((trimmed[0] !== "{" && trimmed[0] !== "[") || trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function compactInline(value: string, maxLength = 96) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trimEnd()}…` : normalized;
}

function compactPathLike(value: string) {
  if (value.includes("/") && !/[*?[\]{}]/.test(value) && !/^https?:\/\//i.test(value)) {
    return value.split("/").filter(Boolean).at(-1) ?? value;
  }

  return compactInline(value, 112);
}

function formatToolLabel(toolName: string) {
  if (toolLabelMap[toolName]) {
    return toolLabelMap[toolName];
  }

  return toolName
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isToolSearchTool(toolName: string) {
  return toolName === "tool_search" || toolName === "tool_search_tool_bm25";
}

function isAgentWorkflowTool(toolName: string) {
  return toolName === "agent" || toolName === "task_output";
}

function pickFirstString(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return null;
}

function quoteBashArgument(value: string) {
  return /^[A-Za-z0-9_./:-]+$/u.test(value) ? value : JSON.stringify(value);
}

function buildBashCommand(value: Record<string, unknown>) {
  const command = pickFirstString(value, ["command", "cmd"]);
  if (command) {
    const args = Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [];
    return [command, ...args.map(quoteBashArgument)].join(" ").trim();
  }

  const args = Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [];
  if (args.length > 0) {
    return args.map(quoteBashArgument).join(" ");
  }

  return null;
}

function buildBashIntentSummary(command: string) {
  const commandName = command.toLowerCase();

  if (commandName === "aliceloop") {
    return "运行 Aliceloop 命令";
  }

  switch (commandName) {
    case "rm":
    case "rmdir":
      return "删除文件";
    case "find":
    case "grep":
    case "rg":
      return "查找文件";
    case "ls":
    case "tree":
      return "查看目录";
    case "cat":
    case "sed":
    case "head":
    case "tail":
      return "查看文件";
    case "mkdir":
      return "创建目录";
    case "mv":
    case "cp":
      return "整理文件";
    case "curl":
      return "请求接口";
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return "运行脚本";
    case "tsx":
    case "node":
    case "python":
      return "运行脚本";
    case "git":
      return "查看版本";
    default:
      return "执行命令";
  }
}

function buildAliceloopIntentSummary(args: string[]) {
  const first = args[0]?.toLowerCase();
  const second = args[1]?.toLowerCase();

  if (!first) {
    return "运行 Aliceloop 命令";
  }

  if (first === "browser" || first === "chrome" || first === "relay") {
    switch (second) {
      case "connect":
      case "open":
      case "start":
        return "连接浏览器";
      case "disconnect":
      case "close":
      case "stop":
        return "断开浏览器";
      case "status":
        return "查看浏览器状态";
      case "navigate":
        return "打开页面";
      case "click":
        return "点击页面";
      case "type":
        return "输入内容";
      case "snapshot":
        return "查看页面";
      case "screenshot":
        return "截屏页面";
      case "back":
        return "返回上一页";
      case "forward":
        return "前进页面";
      case "read":
      case "read_dom":
        return "读取页面";
      default:
        return "浏览器操作";
    }
  }

  switch (first) {
    case "status":
      return "查看状态";
    case "memory":
      switch (second) {
        case "list":
          return "查看记忆";
        case "search":
        case "grep":
          return "搜索记忆";
        case "archive":
          return "归档记忆";
        case "add":
          return "添加记忆";
        case "delete":
          return "删除记忆";
        default:
          return "管理记忆";
      }
    case "config":
      switch (second) {
        case "list":
        case "get":
          return "查看配置";
        case "set":
          return "修改配置";
        default:
          return "管理配置";
      }
    case "providers":
      return "查看提供方";
    case "threads":
      return "查看线程";
    case "thread":
      switch (second) {
        case "info":
          return "查看线程详情";
        case "new":
          return "创建线程";
        case "search":
          return "搜索线程";
        case "delete":
          return "删除线程";
        default:
          return "管理线程";
      }
    case "tasks":
      switch (second) {
        case "list":
          return "查看任务";
        case "add":
          return "新建任务";
        case "update":
          return "更新任务";
        case "done":
          return "完成任务";
        case "show":
          return "查看任务详情";
        case "delete":
          return "删除任务";
        default:
          return "管理任务";
      }
    case "plan":
      switch (second) {
        case "list":
          return "查看计划";
        case "create":
          return "新建计划";
        case "show":
          return "查看计划详情";
        case "update":
          return "更新计划";
        case "approve":
          return "批准计划";
        case "archive":
          return "归档计划";
        default:
          return "管理计划";
      }
    case "skills":
      switch (second) {
        case "list":
          return "查看技能";
        case "show":
          return "查看技能详情";
        case "search":
          return "搜索技能";
        default:
          return "管理技能";
      }
    case "cron":
      switch (second) {
        case "list":
          return "查看定时任务";
        case "add":
          return "新建定时任务";
        case "remove":
          return "删除定时任务";
        default:
          return "管理定时任务";
      }
    case "send":
      switch (second) {
        case "file":
          return "发送文件";
        case "photo":
          return "发送图片";
        default:
          return "发送内容";
      }
    case "screenshot":
      return "截屏";
    case "reaction":
      switch (second) {
        case "list":
          return "查看表态";
        case "add":
          return "添加表态";
        case "remove":
          return "移除表态";
        default:
          return "管理表态";
      }
    case "voice":
      switch (second) {
        case "list":
          return "查看语音";
        case "speak":
          return "朗读文本";
        case "save":
          return "保存语音";
        default:
          return "处理语音";
      }
    case "image":
      if (second === "generate") {
        return "生成图片";
      }
      return "处理图片";
    case "telegram":
      switch (second) {
        case "me":
          return "查看 Telegram 身份";
        case "send":
          return "发送 Telegram 消息";
        case "file":
          return "发送 Telegram 文件";
        default:
          return "处理 Telegram";
      }
    case "discord":
      switch (second) {
        case "send":
          return "发送 Discord 消息";
        case "file":
          return "发送 Discord 文件";
        default:
          return "处理 Discord";
      }
    case "music":
      if (second === "generate") {
        return "生成音乐";
      }
      return "处理音乐";
    default:
      return "运行 Aliceloop 命令";
  }
}

function getPrimaryInputValue(entry: ToolWorkflowEntry, resolvedInput: unknown) {
  if (entry.toolName === "bash") {
    if (isRecord(resolvedInput)) {
      return buildBashCommand(resolvedInput);
    }

    if (typeof resolvedInput === "string" && resolvedInput.trim()) {
      return compactInline(resolvedInput, 128);
    }
  }

  if (entry.toolName === "web_fetch" || entry.toolName === "browser_navigate") {
    if (isRecord(resolvedInput)) {
      return pickFirstString(resolvedInput, ["url"]);
    }

    if (typeof resolvedInput === "string" && resolvedInput.trim()) {
      return compactInline(resolvedInput, 128);
    }
  }

  if (entry.toolName === "glob") {
    if (isRecord(resolvedInput)) {
      return pickFirstString(resolvedInput, ["pattern", "path", "relativePath"]);
    }
  }

  if (entry.toolName === "grep") {
    if (isRecord(resolvedInput)) {
      return pickFirstString(resolvedInput, ["pattern", "query", "q"]);
    }
  }

  if (entry.toolName === "read" || entry.toolName === "write" || entry.toolName === "edit") {
    if (isRecord(resolvedInput)) {
      return pickFirstString(resolvedInput, ["path", "filePath", "targetPath", "relativePath"]);
    }
  }

  if (entry.toolName === "browser_click") {
    if (isRecord(resolvedInput)) {
      return pickFirstString(resolvedInput, ["target", "selector", "path"]);
    }
  }

  if (entry.toolName === "browser_type") {
    if (isRecord(resolvedInput)) {
      return pickFirstString(resolvedInput, ["text", "value", "input"]);
    }
  }

  return null;
}

function normalizeStructuredValue(value: unknown) {
  if (typeof value === "string") {
    return tryParseJson(value) ?? value;
  }

  return value;
}

function resolveEntryInput(entry: ToolWorkflowEntry) {
  if (entry.input !== null && entry.input !== undefined) {
    return normalizeStructuredValue(entry.input);
  }

  return normalizeStructuredValue(entry.inputPreview);
}

function resolveEntryOutput(entry: ToolWorkflowEntry) {
  if (entry.output !== null && entry.output !== undefined) {
    return normalizeStructuredValue(entry.output);
  }

  return normalizeStructuredValue(entry.resultPreview);
}

function isCompoundBashCommand(command: string) {
  return /[|;&<>`$()\n]/u.test(command);
}

function formatBashScriptDisplay(value: string) {
  const trimmed = value.trim();
  if (trimmed.includes("\n")) {
    return trimmed;
  }

  return trimmed
    .replace(/\s*&&\s*/g, "\n&& ")
    .replace(/\s*\|\|\s*/g, "\n|| ")
    .replace(/\s*;\s*/g, ";\n")
    .replace(/\s+\|\s+/g, "\n| ");
}

function buildBashDisplay(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const isScript = isCompoundBashCommand(trimmed);
    const text = isScript ? formatBashScriptDisplay(trimmed) : trimmed;
    return {
      label: isScript ? ("脚本" as const) : ("命令" as const),
      text,
      summary: text.replace(/\s+/g, " ").trim(),
    };
  }

  if (!isRecord(value)) {
    return null;
  }

  const script = pickFirstString(value, ["script"]);
  if (script) {
    const trimmed = script.trim();
    const text = formatBashScriptDisplay(trimmed);
    return {
      label: "脚本" as const,
      text,
      summary: text.replace(/\s+/g, " ").trim(),
    };
  }

  const command = pickFirstString(value, ["command", "cmd"]);
  if (command) {
    if (isCompoundBashCommand(command)) {
      const trimmed = command.trim();
      const text = formatBashScriptDisplay(trimmed);
      return {
        label: "脚本" as const,
        text,
        summary: text.replace(/\s+/g, " ").trim(),
      };
    }

    const args = Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [];
    const text = [command, ...args.map(quoteBashArgument)].join(" ").trim();
    return {
      label: "命令" as const,
      text,
      summary: text,
    };
  }

  const args = Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [];
  if (args.length > 0) {
    const text = args.map(quoteBashArgument).join(" ");
    return {
      label: "命令" as const,
      text,
      summary: text,
    };
  }

  return null;
}

export type ToolSourceLink = SourceLink;

function dedupeToolSourceLinks(links: ToolSourceLink[]) {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) {
      return false;
    }

    seen.add(link.url);
    return true;
  });
}

function buildSourceIconUrl(url: string) {
  try {
    return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(url)}&sz=32`;
  } catch {
    return null;
  }
}

function getUrlHostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function extractHeaderValue(text: string, header: string) {
  const prefix = `${header}: `;
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      break;
    }

    if (line.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim();
      return value || null;
    }
  }

  return null;
}

function buildWebFetchFallbackLabel(url: string) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/g, "").replace(/^\/+/g, "");
    if (pathname) {
      return compactInline(pathname.split("/").at(-1) ?? pathname, 72);
    }

    return compactInline(parsed.hostname || url, 72);
  } catch {
    return compactInline(url, 72);
  }
}

function buildWebSearchSourceLinks(entry: ToolWorkflowEntry) {
  const resolvedOutput = resolveEntryOutput(entry);
  if (!isRecord(resolvedOutput)) {
    return [];
  }

  const rawSources = Array.isArray(resolvedOutput.sources)
    ? resolvedOutput.sources
    : Array.isArray(resolvedOutput.results)
      ? resolvedOutput.results
      : [];
  if (!Array.isArray(rawSources)) {
    return [];
  }

  return dedupeToolSourceLinks(
    rawSources.flatMap((source) => {
      if (!isRecord(source)) {
        return [];
      }

      const url = typeof source.url === "string" ? source.url.trim() : "";
      if (!url) {
        return [];
      }

      const title = typeof source.title === "string" && source.title.trim() ? source.title.trim() : compactInline(url, 72);
      const domain = typeof source.domain === "string" && source.domain.trim() ? source.domain.trim() : getUrlHostname(url);

      return [{
        label: title,
        url,
        iconUrl: buildSourceIconUrl(url),
        domain: domain || null,
      }];
    }),
  );
}

function buildWebFetchSourceLinks(entry: ToolWorkflowEntry) {
  const resolvedInput = resolveEntryInput(entry);
  const url = isRecord(resolvedInput)
    ? pickFirstString(resolvedInput, ["url"])
    : typeof resolvedInput === "string"
      ? resolvedInput.trim()
      : "";

  if (!url) {
    return [];
  }

  const resolvedOutput = resolveEntryOutput(entry);
  const outputText = typeof resolvedOutput === "string" ? resolvedOutput : "";
  const pageTitle = extractHeaderValue(outputText, "Page Title");

  return [{
    label: pageTitle ? compactInline(pageTitle, 72) : buildWebFetchFallbackLabel(url),
    url,
    iconUrl: buildSourceIconUrl(url),
    domain: getUrlHostname(url) || null,
  }];
}

export function buildToolSourceLinks(entry: ToolWorkflowEntry) {
  if (entry.toolName === "web_search") {
    return buildWebSearchSourceLinks(entry);
  }

  if (entry.toolName === "web_fetch") {
    return buildWebFetchSourceLinks(entry);
  }

  return [];
}

function formatInlineArgumentValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatStructuredBlock(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim();
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatArgumentsBlock(entry: ToolWorkflowEntry) {
  const resolvedInput = resolveEntryInput(entry);
  if (resolvedInput === null || resolvedInput === undefined) {
    return entry.inputPreview;
  }

  if (entry.toolName === "bash") {
    const bashDisplay = buildBashDisplay(resolvedInput);
    if (bashDisplay) {
      return bashDisplay.text;
    }
  }

  const primaryInputValue = getPrimaryInputValue(entry, resolvedInput);
  if (primaryInputValue) {
    return compactInline(primaryInputValue, 128);
  }

  if (isRecord(resolvedInput)) {
    const pairs = Object.entries(resolvedInput).filter(([, value]) => value !== undefined);
    if (pairs.length === 0) {
      return "{}";
    }

    const inline = `(${pairs.map(([key, value]) => `${key}=${formatInlineArgumentValue(value)}`).join(", ")})`;
    if (inline.length <= 180 && !inline.includes("\n")) {
      return inline;
    }
  }

  return formatStructuredBlock(resolvedInput);
}

function formatResultBlock(entry: ToolWorkflowEntry) {
  return formatStructuredBlock(resolveEntryOutput(entry)) ?? entry.resultPreview;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function getAgentStatusLabel(status: string | null, entry: ToolWorkflowEntry) {
  switch (status) {
    case "async_launched":
      return "后台运行";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "running":
    case "queued":
      return "运行中";
    default:
      if (entry.status === "output-error" || entry.status === "permission-denied" || entry.error) {
        return "失败";
      }
      if (entry.status === "done" || entry.status === "output-available") {
        return "已完成";
      }
      return "运行中";
  }
}

function getAgentStatusTone(status: string | null, entry: ToolWorkflowEntry) {
  if (status === "failed" || entry.status === "output-error" || entry.status === "permission-denied" || entry.error) {
    return "error";
  }

  if (status === "async_launched" || status === "running" || status === "queued") {
    return "waiting";
  }

  if (status === "completed" || entry.status === "done" || entry.status === "output-available") {
    return "success";
  }

  return "running";
}

function pickAgentOutputText(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (!isRecord(value)) {
    return null;
  }

  return pickFirstString(value, ["response", "result", "summary", "content", "output"]);
}

function compactAgentId(value: string) {
  const normalized = value.trim();
  if (/^[a-f0-9-]{24,}$/iu.test(normalized)) {
    return `#${normalized.slice(0, 8)}`;
  }

  return compactInline(normalized, 18);
}

function buildAgentMeta(input: Record<string, unknown> | null, output: Record<string, unknown> | null) {
  const handoff = input && isRecord(input.handoff) ? input.handoff : null;
  const mode = input?.run_in_background === true || output?.status === "async_launched" ? "后台" : "同步";
  const identity = output ? pickFirstString(output, ["subagent_type", "subagentType", "agentKey", "agentRole"]) : null;
  const inputIdentity = typeof input?.subagent_type === "string" ? input.subagent_type : null;
  const model = typeof input?.model === "string" && input.model.trim() ? input.model.trim() : null;
  const writeBack = typeof handoff?.writeBack === "string" ? handoff.writeBack : null;
  const childAgentId = output ? pickFirstString(output, ["agent_id", "childAgentId", "agentInstanceId", "agentId", "childSessionId", "sessionId"]) : null;
  const parentSessionId = output ? pickFirstString(output, ["parentSessionId"]) : null;
  const memoryScope = output ? pickFirstString(output, ["memoryScope"]) : null;

  return [
    identity || inputIdentity ? { label: "身份", value: identity ?? inputIdentity ?? "" } : null,
    childAgentId ? { label: "实例", value: compactAgentId(childAgentId) } : null,
    { label: "模式", value: mode },
    model ? { label: "模型", value: model } : null,
    writeBack ? { label: "写回", value: writeBack } : null,
    memoryScope ? { label: "记忆", value: memoryScope } : null,
    parentSessionId ? { label: "父会话", value: compactAgentId(parentSessionId) } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
}

function AgentWorkflowDetails({ entry }: { entry: ToolWorkflowEntry }) {
  const inputValue = resolveEntryInput(entry);
  const outputValue = resolveEntryOutput(entry);
  const input = isRecord(inputValue) ? inputValue : null;
  const output = isRecord(outputValue) ? outputValue : null;
  const handoff = input && isRecord(input.handoff) ? input.handoff : null;
  const outputStatus = typeof output?.status === "string" ? output.status : null;
  const statusLabel = getAgentStatusLabel(outputStatus, entry);
  const statusTone = getAgentStatusTone(outputStatus, entry);
  const description = input ? pickFirstString(input, ["description"]) : null;
  const displayName = output ? pickFirstString(output, ["displayName"]) : null;
  const title = output ? pickFirstString(output, ["title"]) : null;
  const prompt = input ? pickFirstString(input, ["prompt"]) : null;
  const goal = typeof handoff?.goal === "string" && handoff.goal.trim() ? handoff.goal.trim() : null;
  const deliverable = typeof handoff?.deliverable === "string" && handoff.deliverable.trim() ? handoff.deliverable.trim() : null;
  const criteria = stringArray(handoff?.acceptanceCriteria);
  const outputText = pickAgentOutputText(outputValue);
  const outputPath = output ? pickFirstString(output, ["outputFile", "transcriptMarkdownPath"]) : null;
  const outputError = output ? pickFirstString(output, ["error"]) : null;
  const meta = buildAgentMeta(input, output);
  const fallbackResult = !outputText && outputValue !== null && outputValue !== undefined
    ? formatStructuredBlock(outputValue)
    : null;

  return (
    <div className="tool-workflow-card__agent">
      <div className="tool-workflow-card__agent-head">
        <span className={`tool-workflow-card__agent-state tool-workflow-card__agent-state--${statusTone}`}>
          <span className="tool-workflow-card__agent-state-dot" aria-hidden="true" />
          {statusLabel}
        </span>
        <strong className="tool-workflow-card__agent-title">{displayName ?? description ?? title ?? "子代理任务"}</strong>
      </div>

      {meta.length > 0 ? (
        <div className="tool-workflow-card__agent-meta">
          {meta.map((item) => (
            <span key={`${item.label}:${item.value}`} className="tool-workflow-card__agent-chip">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>
      ) : null}

      {goal || deliverable ? (
        <div className="tool-workflow-card__agent-brief">
          {goal ? (
            <p>
              <span>目标</span>
              {goal}
            </p>
          ) : null}
          {deliverable ? (
            <p>
              <span>交付</span>
              {deliverable}
            </p>
          ) : null}
        </div>
      ) : null}

      {criteria.length > 0 ? (
        <div className="tool-workflow-card__agent-criteria">
          {criteria.slice(0, 3).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}

      {outputText ? (
        <div className="tool-workflow-card__agent-response">
          <MessageContent content={outputText} renderMarkdown />
        </div>
      ) : outputStatus === "async_launched" ? (
        <p className="tool-workflow-card__agent-note">后台子代理已启动，结果会写入子会话记录。</p>
      ) : fallbackResult ? (
        <pre className="tool-workflow-card__agent-raw">{fallbackResult}</pre>
      ) : null}

      {outputError || entry.error ? (
        <p className="tool-workflow-card__agent-error">{outputError ?? entry.error}</p>
      ) : null}

      {prompt ? (
        <details className="tool-workflow-card__agent-prompt">
          <summary>任务说明</summary>
          <p>{prompt}</p>
        </details>
      ) : null}

      {outputPath ? (
        <div className="tool-workflow-card__agent-file">
          <span>会话文件</span>
          <code title={outputPath}>{compactPathLike(outputPath)}</code>
        </div>
      ) : null}
    </div>
  );
}

function isBashLikeCommand(entry: ToolWorkflowEntry) {
  return entry.toolName === "bash";
}

export function buildSummaryTitle(entry: ToolWorkflowEntry) {
  const resolvedInput = resolveEntryInput(entry);

  if (isToolSearchTool(entry.toolName)) {
    const query = isRecord(resolvedInput)
      ? pickFirstString(resolvedInput, ["query", "q"])
      : typeof resolvedInput === "string"
        ? resolvedInput
        : entry.inputPreview;
    if (query) {
      return `ToolSearch · ${compactInline(query, 26)}`;
    }
    return "ToolSearch";
  }

  if (entry.toolName === "web_search") {
    const query = isRecord(resolvedInput)
      ? pickFirstString(resolvedInput, ["query", "q"])
      : typeof resolvedInput === "string"
        ? resolvedInput
        : entry.inputPreview;
    if (query) {
      return compactInline(query, 32);
    }
    return "搜索信息";
  }

  if (entry.toolName === "web_fetch") {
    const resolvedOutput = resolveEntryOutput(entry);
    const outputText = typeof resolvedOutput === "string" ? resolvedOutput : "";
    const pageTitle = extractHeaderValue(outputText, "Page Title");
    const resolvedInputUrl = isRecord(resolvedInput)
      ? pickFirstString(resolvedInput, ["url"])
      : typeof resolvedInput === "string"
        ? resolvedInput.trim()
        : null;

    if (pageTitle) {
      return `获取 ${compactInline(pageTitle, 32)}`;
    }

    if (resolvedInputUrl) {
      return `获取 ${buildWebFetchFallbackLabel(resolvedInputUrl)}`;
    }

    return "获取网页";
  }

  if (entry.toolName === "browser") {
    return "浏览网页";
  }

  if (entry.toolName === "browser_navigate") {
    return "打开页面";
  }

  if (entry.toolName === "browser_click") {
    return "点击页面";
  }

  if (entry.toolName === "browser_type") {
    return "输入内容";
  }

  if (entry.toolName === "browser_snapshot") {
    return "查看页面";
  }

  if (entry.toolName === "browser_screenshot") {
    return "截屏页面";
  }

  if (entry.toolName === "glob") {
    return "查找文件";
  }

  if (entry.toolName === "grep") {
    return "搜索内容";
  }

  if (entry.toolName === "read") {
    return "查看文件";
  }

  if (entry.toolName === "write") {
    return "写入文件";
  }

  if (entry.toolName === "edit") {
    return "修改文件";
  }

  if (entry.toolName === "skill") {
    return "调用技能";
  }

  if (entry.toolName === "agent") {
    const description = isRecord(resolvedInput)
      ? pickFirstString(resolvedInput, ["description"])
      : null;
    const prompt = isRecord(resolvedInput)
      ? pickFirstString(resolvedInput, ["prompt"])
      : typeof resolvedInput === "string"
        ? resolvedInput
        : null;
    const runInBackground = isRecord(resolvedInput) && resolvedInput.run_in_background === true;
    const role = isRecord(resolvedInput) ? pickFirstString(resolvedInput, ["subagent_type"]) : null;
    const prefix = role
      ? `${runInBackground ? "后台子代理" : "子代理"} ${role}`
      : runInBackground ? "后台子代理" : "子代理";
    if (description) {
      return `${prefix}: ${compactInline(description, 28)}`;
    }
    if (prompt) {
      return `${prefix}: ${compactInline(prompt, 28)}`;
    }
    return runInBackground ? "启动后台子代理" : "运行子代理";
  }

  if (entry.toolName === "task_output") {
    const resolvedOutput = resolveEntryOutput(entry);
    if (isRecord(resolvedOutput)) {
      const status = pickFirstString(resolvedOutput, ["status"]);
      if (status === "completed") {
        return "读取后台子代理结果";
      }
      if (status === "failed") {
        return "后台子代理失败";
      }
      if (status === "running" || status === "queued") {
        return "查看后台子代理状态";
      }
    }
    return "查看后台子代理";
  }

  if (entry.toolName === "bash") {
    if (typeof resolvedInput === "string") {
      const trimmed = resolvedInput.trim();
      if (trimmed) {
        if (isCompoundBashCommand(trimmed)) {
          return "运行脚本";
        }

        const [command, ...args] = trimmed.split(/\s+/);
        const bashCommand = command === "aliceloop"
          ? buildAliceloopIntentSummary(args)
          : buildBashIntentSummary(command);
        return compactInline(bashCommand, 48);
      }
    }

    if (isRecord(resolvedInput)) {
      const script = pickFirstString(resolvedInput, ["script"]);
      if (script) {
        const trimmed = script.trim();
        if (trimmed) {
          if (isCompoundBashCommand(trimmed)) {
            return "运行脚本";
          }

          const [command, ...args] = trimmed.split(/\s+/);
          const bashCommand = command === "aliceloop"
            ? buildAliceloopIntentSummary(args)
            : buildBashIntentSummary(command);
          return compactInline(bashCommand, 48);
        }
      }

      const command = pickFirstString(resolvedInput, ["command", "cmd"]);
      if (command) {
        const args = Array.isArray(resolvedInput.args) ? resolvedInput.args.filter((item): item is string => typeof item === "string") : [];
        const bashCommand = command === "aliceloop"
          ? buildAliceloopIntentSummary(args)
          : buildBashIntentSummary(command);
        return compactInline(bashCommand, 48);
      }
    }
  }

  if (isRecord(resolvedInput)) {
    const keyPriority = ["path", "filePath", "targetPath", "relativePath", "pattern", "prompt", "query", "q", "url", "task_id", "skill", "skillId", "name"];

    const direct = pickFirstString(resolvedInput, keyPriority);
    if (direct) {
      return compactPathLike(direct);
    }
  }

  return formatToolLabel(entry.toolName);
}

function getPrimaryDetailLabel(toolName: string) {
  switch (toolName) {
    case "bash":
      return "命令";
    case "web_search":
      return "参数";
    case "web_fetch":
    case "browser_navigate":
      return "地址";
    case "browser_click":
      return "目标";
    case "browser_type":
      return "输入";
    case "glob":
      return "模式";
    case "grep":
      return "查询";
    case "read":
    case "write":
    case "edit":
      return "路径";
    case "agent":
      return "任务";
    case "task_output":
      return "后台任务";
    default:
      return "参数";
  }
}

function getStatusMeta(entry: ToolWorkflowEntry) {
  if (isAgentWorkflowTool(entry.toolName)) {
    const output = resolveEntryOutput(entry);
    const outputStatus = isRecord(output) && typeof output.status === "string" ? output.status : null;

    if (outputStatus === "failed") {
      return {
        tone: "error" as const,
        label: "失败",
      };
    }

    if (outputStatus === "async_launched" || outputStatus === "running" || outputStatus === "queued") {
      return {
        tone: "waiting" as const,
        label: "后台运行",
      };
    }

    if (outputStatus === "completed") {
      return {
        tone: "success" as const,
        label: null,
      };
    }
  }

  if (entry.status === "output-error" || entry.status === "permission-denied" || entry.error) {
    return {
      tone: "error" as const,
      label: "错误",
    };
  }

  if (entry.status === "approval-requested") {
    return {
      tone: "waiting" as const,
      label: "待批准",
    };
  }

  if (entry.status === "queued") {
    return {
      tone: "waiting" as const,
      label: "排队中",
    };
  }

  if (entry.status === "done" || entry.status === "output-available") {
    return {
      tone: "success" as const,
      label: null,
    };
  }

  return {
    tone: "running" as const,
    label: "运行中",
  };
}

function formatDurationLabel(entry: ToolWorkflowEntry) {
  const measuredDuration = entry.durationMs
    ?? Math.max(0, new Date(entry.updatedAt).getTime() - new Date(entry.createdAt).getTime());

  if (!Number.isFinite(measuredDuration) || measuredDuration <= 0) {
    return null;
  }

  if (measuredDuration < 1_000) {
    return `${Math.round(measuredDuration)} ms`;
  }

  const seconds = measuredDuration / 1_000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)} s`;
  }

  return `${Math.round(seconds)} s`;
}

function ToolWorkflowGlyph({ toolName }: { toolName: string }) {
  if (toolName === "web_search") {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="8.2" cy="8.2" r="4.9" />
        <path d="m11.7 11.7 3.3 3.3" />
      </svg>
    );
  }

  if (toolName === "glob") {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h4l1.3 1.6H16A1.5 1.5 0 0 1 17.5 7v7A1.5 1.5 0 0 1 16 15.5H4A1.5 1.5 0 0 1 2.5 14z" />
        <circle cx="13.5" cy="12.5" r="2.2" />
        <path d="M15.2 14.2 17 16" />
      </svg>
    );
  }

  if (toolName === "edit" || toolName === "write") {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m13.8 3.4 2.8 2.8" />
        <path d="M4 16l2.5-.5L15.4 6.6a1.2 1.2 0 0 0 0-1.7l-.3-.3a1.2 1.2 0 0 0-1.7 0l-8.9 8.9Z" />
        <path d="M3.5 16.5h13" />
      </svg>
    );
  }

  if (toolName === "bash" || toolName === "grep") {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 5.5h14v9H3z" />
        <path d="m6 8 2 2-2 2" />
        <path d="M10.5 12.5h3.5" />
      </svg>
    );
  }

  if (toolName.startsWith("task_")) {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="4" width="13" height="12" rx="2" />
        <path d="M6.5 8.5h7" />
        <path d="M6.5 11.5h4.5" />
        <path d="m12.8 13.1 1.5 1.4 2.2-2.4" />
      </svg>
    );
  }

  if (toolName.startsWith("web_") || toolName.startsWith("browser_") || toolName === "skill") {
    return (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="10" cy="10" r="6.5" />
        <path d="M3.8 10h12.4" />
        <path d="M10 3.5c2 2 3 4.2 3 6.5s-1 4.5-3 6.5c-2-2-3-4.2-3-6.5s1-4.5 3-6.5Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 3.5h6l4 4V16a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 16V5A1.5 1.5 0 0 1 5.5 3.5Z" />
      <path d="M11 3.5V8h4" />
      <path d="M7 11h6" />
      <path d="M7 14h4" />
    </svg>
  );
}

function ToolWorkflowStatusGlyph({ tone }: { tone: "running" | "waiting" | "success" | "error" }) {
  if (tone === "success") {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m3.5 8 2.6 2.7L12.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (tone === "error") {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
        <path d="m5.6 5.6 4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (tone === "waiting") {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 4.7v3.7l2.2 1.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <path d="M8 2.2a5.8 5.8 0 1 1 0 11.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}

function ToolWorkflowDurationGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.4v3.8l2.1 1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ToolWorkflowCard({ entry }: ToolWorkflowCardProps) {
  const status = getStatusMeta(entry);
  const summaryTitle = buildSummaryTitle(entry);
  const argumentsBlock = formatArgumentsBlock(entry);
  const resultBlock = formatResultBlock(entry);
  const isAgentTool = isAgentWorkflowTool(entry.toolName);
  const isToolDiscoveryCard = isToolSearchTool(entry.toolName);
  const planDraft = entry.toolName === "write" && typeof resultBlock === "string"
    ? extractStructuredPlanDraft(resultBlock)
    : null;
  const sourceLinks = buildToolSourceLinks(entry);
  const durationLabel = formatDurationLabel(entry);
  const primaryDetailLabel = getPrimaryDetailLabel(entry.toolName);
  const bashDisplay = entry.toolName === "bash" ? buildBashDisplay(resolveEntryInput(entry)) : null;
  const hasDetails = !isToolDiscoveryCard && Boolean(isAgentTool || argumentsBlock || resultBlock || entry.error || entry.backend || sourceLinks.length > 0);
  const isNetworkTool = entry.toolName === "web_search" || entry.toolName === "web_fetch";
  const resultDetailLabel = "结果";
  const commandDetailLabel = isBashLikeCommand(entry) ? (bashDisplay?.label ?? "命令") : primaryDetailLabel;

  return (
    <details
      className={`tool-workflow-card tool-workflow-card--${status.tone}${isNetworkTool ? " tool-workflow-card--network" : ""}${isAgentTool ? " tool-workflow-card--agent" : ""}${isBashLikeCommand(entry) ? " tool-workflow-card--bash" : ""}`}
    >
      <summary className="tool-workflow-card__summary">
        <span className="tool-workflow-card__main">
          <span className="tool-workflow-card__icon">
            <ToolWorkflowGlyph toolName={entry.toolName} />
          </span>
          <strong className="tool-workflow-card__headline">{summaryTitle}</strong>
        </span>
        <span className="tool-workflow-card__side">
          <span className={`tool-workflow-card__status tool-workflow-card__status--${status.tone}`}>
            <ToolWorkflowStatusGlyph tone={status.tone} />
            {status.label ? <span>{status.label}</span> : null}
          </span>
          {durationLabel ? (
            <span className="tool-workflow-card__duration">
              <ToolWorkflowDurationGlyph />
              <span>{durationLabel}</span>
            </span>
          ) : null}
          {hasDetails ? <span className="tool-workflow-card__chevron" aria-hidden="true">⌄</span> : null}
        </span>
      </summary>
      {hasDetails ? (
        <div className="tool-workflow-card__details">
          {isAgentTool ? <AgentWorkflowDetails entry={entry} /> : null}
          {!isAgentTool && argumentsBlock ? (
            <div className="tool-workflow-card__detail">
              <span className="tool-workflow-card__detail-label">{commandDetailLabel}</span>
              <pre className="tool-workflow-card__detail-value">{argumentsBlock}</pre>
            </div>
          ) : null}
          {!isAgentTool && resultBlock ? (
            <div className="tool-workflow-card__detail">
              <span className="tool-workflow-card__detail-label">{resultDetailLabel}</span>
              {planDraft ? (
                <div className="tool-workflow-card__detail-value tool-workflow-card__detail-value--plan">
                  <div className="tool-workflow-card__plan-preview-head">
                    <span className="tool-workflow-card__plan-preview-eyebrow">计划草案</span>
                    <strong className="tool-workflow-card__plan-preview-title">{planDraft.title}</strong>
                  </div>
                  <div className="tool-workflow-card__plan-preview-body">
                    <MessageContent content={planDraft.bodyContent} renderMarkdown />
                  </div>
                </div>
              ) : (
                <pre className="tool-workflow-card__detail-value">{resultBlock}</pre>
              )}
            </div>
          ) : null}
          {entry.error ? (
            <div className="tool-workflow-card__detail">
              <span className="tool-workflow-card__detail-label">Error</span>
              <pre className="tool-workflow-card__detail-value tool-workflow-card__detail-value--error">{entry.error}</pre>
            </div>
          ) : null}
          {entry.backend ? (
            <div className="tool-workflow-card__detail">
              <span className="tool-workflow-card__detail-label">Backend</span>
              <pre className="tool-workflow-card__detail-value">{entry.backend}</pre>
            </div>
          ) : null}
          {sourceLinks.length > 0 ? (
            <SourceLinksSection
              links={sourceLinks}
              detailsClassName="tool-workflow-card__sources"
              summaryClassName="tool-workflow-card__sources-summary"
              listClassName="tool-workflow-card__sources-list"
              linkClassName="tool-workflow-card__source-link"
            />
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
