import { SourceLinksSection, type SourceLink } from "./SourceLinks";
import type { ToolWorkflowEntry } from "./useShellConversation";

interface ToolWorkflowCardProps {
  entry: ToolWorkflowEntry;
}

const toolLabelMap: Record<string, string> = {
  bash: "Bash",
  browser_click: "Browser Click",
  browser_navigate: "Browser Navigate",
  browser_snapshot: "Browser Snapshot",
  browser_screenshot: "Browser Screenshot",
  browser_type: "Browser Type",
  coding_agent_run: "Coding Agent",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  skill: "Skill",
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

function pickFirstString(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return null;
}

function buildBashCommand(value: Record<string, unknown>) {
  const command = pickFirstString(value, ["command", "cmd"]);
  if (command) {
    return compactInline(command, 128);
  }

  const args = Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [];
  if (args.length > 0) {
    return compactInline(args.join(" "), 128);
  }

  return null;
}

function buildBashIntentSummary(command: string) {
  const commandName = command.split(/\s+/, 1)[0]?.toLowerCase();

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

export function buildSummaryTitle(entry: ToolWorkflowEntry) {
  const resolvedInput = resolveEntryInput(entry);

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
    return "读取网页";
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

  if (entry.toolName === "coding_agent_run") {
    return "分步处理";
  }

  if (entry.toolName === "bash") {
    if (isRecord(resolvedInput)) {
      const bashCommand = buildBashCommand(resolvedInput);
      if (bashCommand) {
        return buildBashIntentSummary(bashCommand);
      }
    }

    if (typeof resolvedInput === "string" && resolvedInput.trim()) {
      return buildBashIntentSummary(resolvedInput.trim());
    }
  }

  if (isRecord(resolvedInput)) {
    const keyPriority = ["path", "filePath", "targetPath", "relativePath", "pattern", "query", "q", "url", "skill", "skillId", "name"];

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
      return "Command";
    case "web_search":
      return "Arguments";
    case "web_fetch":
    case "browser_navigate":
      return "URL";
    case "browser_click":
      return "Target";
    case "browser_type":
      return "Input";
    case "glob":
      return "Pattern";
    case "grep":
      return "Query";
    case "read":
    case "write":
    case "edit":
      return "Path";
    default:
      return "Arguments";
  }
}

function getStatusMeta(entry: ToolWorkflowEntry) {
  if (entry.status === "output-error" || entry.status === "permission-denied" || entry.error) {
    return {
      tone: "error" as const,
      label: "Error",
    };
  }

  if (entry.status === "approval-requested") {
    return {
      tone: "waiting" as const,
      label: "Approval",
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
    label: "Running",
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
  const sourceLinks = buildToolSourceLinks(entry);
  const durationLabel = formatDurationLabel(entry);
  const primaryDetailLabel = getPrimaryDetailLabel(entry.toolName);
  const hasDetails = Boolean(argumentsBlock || resultBlock || entry.error || entry.backend || sourceLinks.length > 0);
  const isNetworkTool = entry.toolName === "web_search" || entry.toolName === "web_fetch";

  return (
    <details className={`tool-workflow-card tool-workflow-card--${status.tone}${isNetworkTool ? " tool-workflow-card--network" : ""}`}>
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
          {argumentsBlock ? (
            <div className="tool-workflow-card__detail">
              <span className="tool-workflow-card__detail-label">{primaryDetailLabel}</span>
              <pre className="tool-workflow-card__detail-value">{argumentsBlock}</pre>
            </div>
          ) : null}
          {resultBlock ? (
            <div className="tool-workflow-card__detail">
              <span className="tool-workflow-card__detail-label">Result</span>
              <pre className="tool-workflow-card__detail-value">{resultBlock}</pre>
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
