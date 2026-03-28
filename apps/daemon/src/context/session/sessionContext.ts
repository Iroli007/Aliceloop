import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { ModelMessage } from "ai";
import type { AttentionState, TaskRun } from "@aliceloop/runtime-core";
import type { SessionEvent } from "@aliceloop/runtime-core";
import type { SessionMessage } from "@aliceloop/runtime-core";
import type { SessionSnapshot } from "@aliceloop/runtime-core";
import type { SessionProjectBinding } from "@aliceloop/runtime-core";
import {
  type SkillRouteHints,
  inferStickySkillIdsFromContext,
  needsBrowserAutomation,
  needsWebFetch,
  needsWebResearch,
} from "../skills/skillRouting";
import {
  buildSessionAttachmentSandboxRoots,
  type SessionAttachmentSandboxRoots,
  getSessionSnapshot,
  listSessionEventsSince,
} from "../../repositories/sessionRepository";
import { getAttentionState } from "../../repositories/overviewRepository";
import { listPlans, type PlanRecord } from "../../repositories/planRepository";
import { listTaskRuns } from "../../repositories/taskRunRepository";
import { nowMs, roundMs } from "../../runtime/perfTrace";

const MAX_HISTORY_MESSAGES = 8;
const MAX_FOCUS_MESSAGES = 6;
const MAX_TOOL_ACTIVITY_EVENTS = 20;
const MAX_TOOL_ACTIVITY_ITEMS = 4;
const MAX_INLINE_ATTACHMENT_BYTES = 48 * 1024;
const MAX_TOTAL_INLINE_ATTACHMENT_BYTES = 96 * 1024;
const MAX_INLINE_ATTACHMENT_CHARS = 24_000;
const MAX_DIRECTORY_TREE_ENTRIES = 80;
const MAX_DIRECTORY_TREE_DEPTH = 4;
const TEXT_LIKE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".csv",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".markdown",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function isInlineTextAttachment(fileName: string, mimeType: string) {
  if (mimeType.startsWith("text/")) {
    return true;
  }

  if (
    mimeType.includes("json")
    || mimeType.includes("javascript")
    || mimeType.includes("typescript")
    || mimeType.includes("xml")
    || mimeType.includes("yaml")
    || mimeType.includes("markdown")
    || mimeType.includes("svg")
  ) {
    return true;
  }

  return TEXT_LIKE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function readInlineAttachmentPreview(path: string, fileName: string, mimeType: string, remainingBudget: number) {
  if (!isInlineTextAttachment(fileName, mimeType) || remainingBudget <= 0) {
    return null;
  }

  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_INLINE_ATTACHMENT_BYTES || stats.size > remainingBudget) {
      return null;
    }

    const content = readFileSync(path, "utf8");
    if (!content.trim()) {
      return null;
    }

    const trimmedContent = content.length > MAX_INLINE_ATTACHMENT_CHARS
      ? `${content.slice(0, MAX_INLINE_ATTACHMENT_CHARS).trimEnd()}\n... [truncated]`
      : content;

    return {
      content: trimmedContent,
      byteSize: stats.size,
    };
  } catch {
    return null;
  }
}

function buildDirectoryTreeLines(
  dirPath: string,
  depth = 0,
  lines: string[] = [],
): string[] {
  if (depth >= MAX_DIRECTORY_TREE_DEPTH || lines.length >= MAX_DIRECTORY_TREE_ENTRIES) {
    return lines;
  }

  let entries: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }))
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.name.localeCompare(right.name, "en");
      });
  } catch {
    return lines;
  }

  for (const entry of entries) {
    if (lines.length >= MAX_DIRECTORY_TREE_ENTRIES) {
      break;
    }

    const prefix = `${"  ".repeat(depth)}- `;
    lines.push(`${prefix}${entry.name}${entry.isDirectory ? "/" : ""}`);

    if (entry.isDirectory) {
      buildDirectoryTreeLines(join(dirPath, entry.name), depth + 1, lines);
    }
  }

  return lines;
}

function buildDirectoryAttachmentPreview(path: string, mimeType: string) {
  if (mimeType !== "inode/directory") {
    return null;
  }

  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) {
      return null;
    }

    const lines = buildDirectoryTreeLines(path);
    if (lines.length === 0) {
      return "[empty directory]";
    }

    const suffix = lines.length >= MAX_DIRECTORY_TREE_ENTRIES
      ? "\n... [directory tree truncated]"
      : "";

    return `${lines.join("\n")}${suffix}`;
  } catch {
    return null;
  }
}

function getLatestUserSessionMessage(messages: SessionMessage[]): SessionMessage | null {
  return [...messages].reverse().find((message) => message.role === "user") ?? null;
}

function getLatestAssistantBeforeLastUser(messages: SessionMessage[]): SessionMessage | null {
  const lastUserIndex = [...messages].map((message) => message.role).lastIndexOf("user");
  if (lastUserIndex <= 0) {
    return null;
  }

  for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return messages[index] ?? null;
    }
  }

  return null;
}

function trimInline(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

function splitLatestMessageAnchorLines(content: string) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      openingLines: [] as string[],
      closingLines: [] as string[],
    };
  }

  const openingLines = lines.slice(0, 2);
  const closingStart = Math.max(lines.length - 2, openingLines.length);
  const closingLines = lines.slice(closingStart);

  return {
    openingLines,
    closingLines,
  };
}

function isTrackedRecentToolName(toolName: string) {
  return toolName === "web_search"
    || toolName === "web_fetch"
    || toolName.startsWith("browser_");
}

function isContinuationLikeMessage(content: string) {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  return /^(?:你呢|你那边呢|你查|你搜|继续|接着|按这个|按它|照这个|这个呢|那这个呢|然后呢|查一下|搜一下|再查|再搜|现在什么情况|现在咋样|现在怎么样|最新情况|有进展吗|进展如何|怎么样了|情况怎么样|还有进展吗|按这个平台|按这个时间|按这个口径)/u.test(trimmed);
}

function needsResearchContinuation(messageText: string) {
  return /查|搜|搜索|核对|验证|确认|平台|官网|B站|微博|粉丝|播放|数据|时间|日期|几月几日|最新|当前|\d{1,2}月\d{1,2}日/u.test(messageText);
}

function needsResearchDeepRead(messageText: string) {
  const trimmed = messageText.trim();
  return /深度研究|深入研究|深挖|深扒|别偷懒|别只看摘要|别看摘要|去读|读一下|看原文|看正文|看全文|看来源|看帖子|看词条|看页面|补完|补全|继续深挖|继续深查|继续研究|现在什么情况|现在咋样|现在怎么样|最新情况|有进展吗|进展如何|怎么样了|情况怎么样|还有进展吗/u.test(trimmed);
}

function needsImmediateTimeVerification(messageText: string) {
  const trimmed = messageText.trim();
  return /现在几点|几点了|当前时间|现在什么时间|今日日期|现在日期|现在是几月几号/u.test(trimmed)
    || /今天.*(几号|号吗|几月几号|星期几|周几|周几来着|日期)/u.test(trimmed)
    || /今天不是\d{1,2}号吗/u.test(trimmed);
}

function needsImmediateWeatherVerification(messageText: string) {
  return /天气|气温|温度|下雨|降雨|会不会下雨|会下雨吗|冷不冷|热不热|风力|空气质量/u.test(messageText.trim());
}

function needsHighPriorityWebVerification(messageText: string) {
  const trimmed = messageText.trim();
  return /粉丝|粉絲|followers?|关注者|播放|点赞|订阅|排名|多少粉|多少赞|多少播放|数据|最新|当前|现在|截至|截止|几月几日|日期|时间点|活动|动态|准确|准不准|可靠吗|可靠性|事实依据|来源|核对|验证|确认|来着/u.test(trimmed);
}

function listSubstantialUserAnchors(messages: SessionMessage[]) {
  const userMessages = messages.filter((message) => message.role === "user");
  if (userMessages.length <= 1) {
    return [];
  }

  const candidates = userMessages.slice(0, -1);
  const anchors: string[] = [];
  for (const message of candidates) {
    const content = serializeMessageContent(message).trim();
    if (!content || isContinuationLikeMessage(content)) {
      continue;
    }

    const trimmed = trimInline(content, 220);
    if (!anchors.includes(trimmed)) {
      anchors.push(trimmed);
    }
  }

  return anchors;
}

function summarizeWorksetConstraints(anchors: string[]) {
  const constraintCandidates = anchors.filter((anchor) => {
    return /B站|哔哩哔哩|bilibili|抖音|douyin|推特|twitter|x\.com|平台|微博|官网|时间|日期|几月几日|粉丝|播放|数据|口径|截至|截止|最新|当前|wiki|wikipedia|维基/u.test(anchor);
  });

  if (constraintCandidates.length === 0) {
    return null;
  }

  return trimInline(constraintCandidates.join(" / "), 260);
}

function needsStrictSourcePolicy(value: string | null) {
  if (!value) {
    return false;
  }

  return /B站|哔哩哔哩|bilibili|粉丝|播放|点赞|数据|最新|当前|截至|截止|几月几日|日期|时间|活动/u.test(value);
}

function buildResolvedCurrentRequest(input: {
  latestContent: string;
  continuationLike: boolean;
  researchContinuation: boolean;
  latestExplicitAnchor: string | null;
  originalTopicAnchor: string | null;
  carryForwardFacts: string | null;
}) {
  if (!input.latestContent) {
    return null;
  }

  if (!input.continuationLike) {
    return null;
  }

  const fragments = [
    "Interpret the latest short user follow-up as a continuation of the same still-open task from the recent turns.",
  ];

  if (input.researchContinuation) {
    fragments.push("This is still an externally sourced research/fact-checking task, so continue searching now.");
  }

  if (input.latestExplicitAnchor) {
    fragments.push(`Current concrete target: ${input.latestExplicitAnchor}`);
  } else if (input.originalTopicAnchor) {
    fragments.push(`Running topic: ${input.originalTopicAnchor}`);
  }

  if (input.carryForwardFacts) {
    fragments.push(`Carry-forward workset: ${input.carryForwardFacts}`);
  }

  fragments.push(`Latest user follow-up: ${input.latestContent}`);

  return trimInline(fragments.join(" "), 420);
}

function buildEffectiveUserQuery(input: {
  latestContent: string;
  continuationLike: boolean;
  researchContinuation: boolean;
  latestExplicitAnchor: string | null;
  originalTopicAnchor: string | null;
  carryForwardFacts: string | null;
}) {
  if (!input.latestContent) {
    return null;
  }

  if (!input.continuationLike) {
    return input.latestContent;
  }

  if (input.researchContinuation && input.carryForwardFacts) {
    return trimInline(input.carryForwardFacts, 320);
  }

  const merged = [
    input.latestExplicitAnchor,
    input.originalTopicAnchor,
    input.latestContent,
  ].filter(Boolean).join(" / ");

  return merged ? trimInline(merged, 320) : input.latestContent;
}

export interface RecentConversationFocus {
  content: string;
  latestContent: string;
  latestUserHasImageAttachment: boolean;
  latestOpeningLines: string[];
  latestClosingLines: string[];
  continuationLike: boolean;
  researchContinuation: boolean;
  originalTopicAnchor: string | null;
  latestExplicitAnchor: string | null;
  carryForwardFacts: string | null;
  worksetConstraints: string | null;
  resolvedCurrentRequest: string | null;
  effectiveUserQuery: string | null;
  routeHints: SkillRouteHints;
}

interface RecentToolTrace {
  toolCallId: string;
  toolName: string;
  backend: string | null;
  inputPreview: string | null;
  resultPreview: string | null;
  success: boolean | null;
  durationMs: number | null;
  stateStatus: string | null;
  stateInput: unknown | null;
  stateOutput: unknown | null;
  stateError: string | null;
  createdAt: string;
}

interface RecentResearchSource {
  citationIndex: number | null;
  title: string;
  url: string;
  domain: string;
  sourceType: string;
}

interface RecentResearchSearch {
  query: string;
  effectiveQuery: string | null;
  sources: RecentResearchSource[];
}

interface RecentResearchFetch {
  url: string;
  pageTitle: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  excerpt: string | null;
}

interface SessionContextFragmentTimings {
  snapshotMs: number;
  latestUserMs: number;
  projectBindingMs: number;
  attachmentRootsMs: number;
  recentToolTraceMs: number;
  recentConversationFocusMs: number;
  recentResearchMemoryMs: number;
  activeTurnMs: number;
  recentToolActivityMs: number;
  taskWorkingMemoryMs: number;
  messagesMs: number;
  totalMs: number;
  snapshotReads: number;
}

export interface SessionContextFragments {
  latestUserQuery: string | null;
  projectBinding: SessionProjectBinding | null;
  attachmentRoots: SessionAttachmentSandboxRoots;
  recentConversationFocus: RecentConversationFocus;
  recentResearchMemory: string;
  recentToolActivity: string;
  activeTurn: string;
  taskWorkingMemory: string;
  messages: ModelMessage[];
  timings: SessionContextFragmentTimings;
}

function buildSkillRouteHints(input: {
  latestContent: string;
  continuationLike: boolean;
  researchContinuation: boolean;
  carryForwardFacts: string | null;
  worksetConstraints: string | null;
  recentToolNames: string[];
}): SkillRouteHints {
  const stickySkillIds = new Set<string>();
  const reasons = new Set<string>();
  const currentQuery = input.latestContent;

  const sawRecentWebTool = input.recentToolNames.some((toolName) => {
    return toolName === "web_search" || toolName === "web_fetch";
  });
  const sawRecentWebFetchTool = input.recentToolNames.some((toolName) => {
    return toolName === "web_fetch";
  });
  const needsDeepResearchFollowup = sawRecentWebTool && needsResearchDeepRead(currentQuery);
  const sawRecentBrowserTool = input.recentToolNames.some((toolName) => {
    return toolName.startsWith("browser_");
  });
  const loginOrQrContinuation = looksLikeLoginOrQrContinuationContext(input.carryForwardFacts)
    || looksLikeLoginOrQrContinuationContext(input.worksetConstraints);

  for (const skillId of inferStickySkillIdsFromContext(currentQuery)) {
    stickySkillIds.add(skillId);
  }

  if (
    input.researchContinuation
    || (input.continuationLike && sawRecentWebTool)
    || needsWebResearch(currentQuery)
    || needsDeepResearchFollowup
  ) {
    stickySkillIds.add("web-search");
    reasons.add("carry forward live research/fact-check tools");
  }

  if (
    (input.continuationLike && sawRecentWebFetchTool)
    || needsWebFetch(currentQuery)
    || needsDeepResearchFollowup
  ) {
    stickySkillIds.add("web-fetch");
    reasons.add("carry forward recent page reading");
  }

  if (
    (input.continuationLike && sawRecentBrowserTool)
    || (input.continuationLike && needsBrowserAutomation(currentQuery))
    || (input.continuationLike && loginOrQrContinuation)
  ) {
    stickySkillIds.add("browser");
    reasons.add("carry forward recent browser context");
  }

  return {
    stickySkillIds: [...stickySkillIds],
    reasons: [...reasons],
  };
}

function looksLikeLoginOrQrContinuationContext(value: string | null | undefined) {
  if (!value) {
    return false;
  }

  return /二维码|扫码|扫码登录|登录页|验证码|验证页|登录|login|signin|sign-in|auth|b站.*(登录|上网|逛|刷)|深入.*b站/u.test(value);
}

function sessionMessageToCore(message: SessionMessage): ModelMessage {
  const content = serializeMessageContent(message);

  if (message.role === "user") {
    return { role: "user", content };
  }

  if (message.role === "assistant") {
    return { role: "assistant", content };
  }

  return { role: "system", content };
}

function serializeMessageContent(message: SessionMessage): string {
  if (message.attachments.length === 0) {
    return message.content;
  }

  let remainingInlineBudget = MAX_TOTAL_INLINE_ATTACHMENT_BYTES;
  const attachmentSummary = message.attachments
    .map((attachment) => {
      const binaryNote = attachment.mimeType.startsWith("image/")
        ? ", binary image attachment"
        : "";
      const path = attachment.originalPath || attachment.storagePath;
      return `${attachment.fileName} (${attachment.mimeType}, path: ${path}${binaryNote})`;
    })
    .join(", ");
  const inlineAttachmentBlocks = message.attachments
    .map((attachment) => {
      const path = attachment.originalPath || attachment.storagePath;
      const directoryPreview = buildDirectoryAttachmentPreview(path, attachment.mimeType);
      if (directoryPreview) {
        return [
          `[Attached directory tree: ${attachment.fileName}]`,
          directoryPreview,
        ].join("\n");
      }

      const preview = readInlineAttachmentPreview(path, attachment.fileName, attachment.mimeType, remainingInlineBudget);
      if (!preview) {
        return null;
      }

      remainingInlineBudget -= preview.byteSize;
      return [
        `[Attached file content: ${attachment.fileName}]`,
        preview.content,
      ].join("\n");
    })
    .filter((block): block is string => Boolean(block));

  const parts: string[] = [];

  if (message.content.trim()) {
    parts.push(message.content);
  }

  parts.push(`[Attached files: ${attachmentSummary}]`);

  if (inlineAttachmentBlocks.length > 0) {
    parts.push(...inlineAttachmentBlocks);
  }

  return parts.join("\n\n");
}

function buildSessionMessagesFromSnapshot(snapshot: SessionSnapshot): ModelMessage[] {
  const messages = snapshot.messages
    .filter((m) => m.role !== "system")
    .slice(-MAX_HISTORY_MESSAGES);

  return messages.map(sessionMessageToCore);
}

function buildActiveTurnBlockFromFocus(recentConversationFocus: RecentConversationFocus): string {
  const latestContent = recentConversationFocus.latestContent;
  if (!latestContent) {
    return "";
  }

  return [
    "## Active Turn",
    "- The final user message in the conversation history is the only current request for this turn.",
    "- Never treat text from any earlier user turn as if it appeared in the latest user message.",
    "- Treat older conversation as background context. Do not claim the user just said, repeated, or confirmed something unless it appears in the latest user message below.",
    "- When counting how many times the user said, confirmed, or requested something, count only explicit user turns from the conversation history. Do not count summaries, carry-forward notes, anchors, or repeated context blocks as extra mentions.",
    "- If a nickname, preference, or instruction appears only in older history, treat it as past context rather than a fresh instruction in this reply.",
    "- When the latest user message conflicts with, narrows, or replaces an older framing, follow the latest user message.",
    "- If the latest user message is brief, elliptical, or continuation-like, resolve what it refers to from the immediately preceding turns instead of pretending the context is missing.",
    ...(recentConversationFocus.latestOpeningLines.length > 0
      ? [
          "- Anchor on the opening lines of the latest user message before interpreting older context.",
          "",
          "<latest_user_message_opening_lines>",
          ...recentConversationFocus.latestOpeningLines,
          "</latest_user_message_opening_lines>",
        ]
      : []),
    ...(recentConversationFocus.latestClosingLines.length > 0
      ? [
          "- Also anchor on the closing lines of the latest user message so the final ask is not overwritten by older context.",
          "",
          "<latest_user_message_closing_lines>",
          ...recentConversationFocus.latestClosingLines,
          "</latest_user_message_closing_lines>",
        ]
      : []),
    ...(needsImmediateTimeVerification(latestContent)
      ? [
          "- The latest user message asks for the current local time or date.",
          "- Required action for this turn: verify it before replying. Use the routed `system-info` skill first; it can call `bash` with an exact local time command such as `date` instead of guessing the current time or date from memory.",
          "- After verifying the local time/date, answer directly from the verified output. Do not add unrelated comparisons, extra anecdotes, or invented corrections.",
        ]
      : []),
    ...(needsImmediateWeatherVerification(latestContent)
      ? [
          "- The latest user message asks for current or date-specific weather information.",
          "- Required action for this turn: verify it before replying. Use `web_search` to find a fresh weather source, then `web_fetch` if needed. Use the user's named location directly, and do not guess weather, temperatures, or dates from memory.",
          "- After verifying the weather, answer directly from the fetched source. Do not add unrelated city comparisons, remembered weather, or off-topic commentary.",
        ]
      : []),
    ...(needsHighPriorityWebVerification(latestContent)
        ? [
          "- The latest user message needs externally verifiable current facts or source-backed correction.",
          "- Required action for this turn: start with `web_search` before replying. If the snippets and source links are enough, answer from them; otherwise call `web_fetch` on the strongest candidate source that still needs reading before giving any concrete number, date, timeline, ranking, follower count, platform metric, or factual correction.",
          "- Treat the routed `web_search` / `web_fetch` research pair as the highest-priority path for this turn only when a specific page needs to be read. Do not answer from memory, snippets alone, or stale overview pages when fresher platform or dated sources exist.",
          "- For creator/platform metrics, prioritize primary platform pages such as Bilibili, Douyin, and X/Twitter first, then clearly dated reporting or reputable analytics. Use wiki or encyclopedia pages only as secondary background context.",
          "- Baidu Baike has extremely low priority for this kind of question. Only cite it after you fail to find a usable primary platform page, official page, dated report, or reputable analytics source, and if you use it you must explicitly label it as `百度百科` background information rather than a live metric source.",
        ]
      : []),
    ...(recentConversationFocus.resolvedCurrentRequest
      ? [
          "- When the latest user message is a short continuation, execute the resolved request below as the concrete work item for this turn.",
          "",
          "<resolved_current_request>",
          recentConversationFocus.resolvedCurrentRequest,
          "</resolved_current_request>",
        ]
      : []),
    "",
    "<latest_user_message>",
    latestContent,
    "</latest_user_message>",
  ].join("\n");
}

function buildRecentConversationFocusFromSnapshot(
  snapshot: SessionSnapshot,
  recentToolTraces: RecentToolTrace[],
): RecentConversationFocus {
  const recentMessages = snapshot.messages
    .filter((message) => message.role !== "system")
    .slice(-MAX_FOCUS_MESSAGES);
  const latestUserMessage = getLatestUserSessionMessage(recentMessages);
  const latestContent = latestUserMessage ? serializeMessageContent(latestUserMessage).trim() : "";
  const latestMessageAnchorLines = splitLatestMessageAnchorLines(latestContent);
  const latestUserHasImageAttachment = latestUserMessage?.attachments.some((attachment) => {
    return attachment.mimeType.startsWith("image/");
  }) ?? false;

  if (recentMessages.length < 2) {
    return {
      content: "",
      latestContent,
      latestUserHasImageAttachment,
      latestOpeningLines: latestMessageAnchorLines.openingLines,
      latestClosingLines: latestMessageAnchorLines.closingLines,
      continuationLike: false,
      researchContinuation: false,
      originalTopicAnchor: null,
      latestExplicitAnchor: null,
      carryForwardFacts: null,
      worksetConstraints: null,
      resolvedCurrentRequest: null,
      effectiveUserQuery: null,
      routeHints: {
        stickySkillIds: [],
        reasons: [],
      },
    };
  }

  const continuationLike = isContinuationLikeMessage(latestContent);
  const anchors = listSubstantialUserAnchors(recentMessages);
  const latestExplicitAnchor = anchors.at(-1) ?? null;
  const originalTopicAnchor = anchors[0] && anchors[0] !== latestExplicitAnchor ? anchors[0] : null;
  const carryForwardFacts = anchors.length > 0 ? anchors.join(" / ") : null;
  const researchContinuation = Boolean(
    continuationLike && carryForwardFacts && needsResearchContinuation(carryForwardFacts),
  );
  const worksetConstraints = summarizeWorksetConstraints(anchors);
  const recentToolNames = recentToolTraces.map((trace) => trace.toolName);
  const sawRecentWebTool = recentToolNames.some((toolName) => {
    return toolName === "web_search" || toolName === "web_fetch";
  });
  const needsDeepResearchFollowup = sawRecentWebTool && needsResearchDeepRead(latestContent);
  const resolvedCurrentRequest = buildResolvedCurrentRequest({
    latestContent,
    continuationLike,
    researchContinuation,
    latestExplicitAnchor,
    originalTopicAnchor,
    carryForwardFacts,
  });
  const effectiveUserQuery = buildEffectiveUserQuery({
    latestContent,
    continuationLike,
    researchContinuation,
    latestExplicitAnchor,
    originalTopicAnchor,
    carryForwardFacts,
  });
  const routeHints = buildSkillRouteHints({
    latestContent,
    continuationLike,
    researchContinuation,
    carryForwardFacts,
    worksetConstraints,
    recentToolNames,
  });

  const lines = [
    "## Recent Conversation Focus",
    "- Use the recent exchange below to resolve pronouns, omissions, and short follow-up requests.",
  ];

  if (continuationLike) {
    lines.push("- The latest user message is a continuation-style follow-up. Carry forward the still-open subject from the immediately preceding turns.");
    lines.push("- If the running topic is current or externally sourced information, execute the relevant search/fetch tools now instead of only saying you will check.");
    if (carryForwardFacts) {
      lines.push(`- Current unresolved research task: ${carryForwardFacts}`);
    }
    if (worksetConstraints) {
      lines.push(`- Current carried-forward constraints: ${worksetConstraints}`);
    }
    if (needsStrictSourcePolicy(carryForwardFacts) || needsStrictSourcePolicy(worksetConstraints)) {
      lines.push("- Source policy for this turn: prioritize the primary platform pages for Bilibili, Douyin, and X/Twitter when relevant, then clearly dated reporting or reputable analytics. Treat wiki or encyclopedia pages only as background context for biography, not as the authoritative source for current metrics, latest activity, or date-specific facts.");
      lines.push("- Baidu Baike priority is extremely low for this thread. Use it only if primary platform pages, official pages, dated reporting, and reputable analytics all fail to establish the fact, and explicitly label it as `百度百科` if you end up citing it.");
      lines.push("- If the target account, creator page, or source domain is still ambiguous, ask the user for the exact profile URL or trusted site list so you can verify against the right pages.");
    }
    if (resolvedCurrentRequest) {
      lines.push(`- Resolved current request for this turn: ${resolvedCurrentRequest}`);
    }
    if (researchContinuation) {
      lines.push("- Required action for this turn: use the routed web_search / web_fetch research pair only if a specific page still needs to be read; otherwise stay with web_search and the returned source links before replying. Do not ask for clarification unless the recent anchors truly fail to identify any subject, platform, or time target.");
      lines.push("- Do not stop at a verbal promise. After the tool round finishes, check whether the task is actually complete before replying or asking for the next step.");
      lines.push("- The research memory block below is the running evidence ledger for this investigation. Do not restart from scratch when the user only asks to continue; reuse the searched sources, fetched pages, and remaining evidence gaps to decide the next step.");
      lines.push("- Before drafting a report, identify the strongest unfetched candidate URL in the ledger. If one exists, fetch that page before starting a fresh broad search.");
    }
    if (needsDeepResearchFollowup) {
      lines.push("- The latest follow-up is asking for a deeper read, not another shallow search.");
      lines.push("- Required action for this turn: inspect the research memory ledger, take the strongest unfetched candidate URL, and call `web_fetch` on that page before replying.");
      lines.push("- Do not answer from snippets alone when the user is explicitly asking for deeper evidence or full-page reading.");
    }
  }

  if (latestUserHasImageAttachment) {
    lines.push("- The latest user message includes one or more image attachments. If the user is asking what is shown in the image, use the routed `view_image` tool on the attachment path instead of guessing.");
  }

  if (routeHints.stickySkillIds.length > 0) {
    lines.push(`- Sticky skill routing for this turn: ${routeHints.stickySkillIds.join(", ")}`);
  }

  if (originalTopicAnchor) {
    lines.push(`- Original topic anchor from recent turns: ${originalTopicAnchor}`);
  }

  if (latestExplicitAnchor) {
    lines.push(`- Latest explicit anchor from recent turns: ${latestExplicitAnchor}`);
  }

  lines.push("", "<recent_exchange>");
  for (const message of recentMessages.slice(-6)) {
    const label = message.role === "assistant" ? "Assistant" : "User";
    lines.push(`${label}: ${trimInline(serializeMessageContent(message), 220)}`);
  }
  lines.push("</recent_exchange>");

  return {
    content: lines.join("\n"),
    latestContent,
    latestUserHasImageAttachment,
    latestOpeningLines: latestMessageAnchorLines.openingLines,
    latestClosingLines: latestMessageAnchorLines.closingLines,
    continuationLike,
    researchContinuation: Boolean(researchContinuation),
    originalTopicAnchor,
    latestExplicitAnchor,
    carryForwardFacts,
    worksetConstraints,
    resolvedCurrentRequest,
    effectiveUserQuery,
    routeHints,
  };
}

function extractRecentToolTracesFromSnapshot(sessionId: string, snapshot: SessionSnapshot): RecentToolTrace[] {
  const sinceSeq = Math.max(0, snapshot.lastEventSeq - MAX_TOOL_ACTIVITY_EVENTS);
  const events = listSessionEventsSince(sessionId, sinceSeq);
  const traces = new Map<string, RecentToolTrace>();

  for (const event of events) {
    if (event.type !== "tool.call.started" && event.type !== "tool.call.completed" && event.type !== "tool.state.change") {
      continue;
    }

    const payload = event.payload as {
      toolCallId?: unknown;
      toolName?: unknown;
      inputPreview?: unknown;
      resultPreview?: unknown;
      success?: unknown;
      durationMs?: unknown;
      backend?: unknown;
      status?: unknown;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    };
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
    if (!toolCallId || !toolName || !isTrackedRecentToolName(toolName)) {
      continue;
    }

    const existing = traces.get(toolCallId) ?? {
      toolCallId,
      toolName,
      backend: null,
      inputPreview: null,
      resultPreview: null,
      success: null,
      durationMs: null,
      stateStatus: null,
      stateInput: null,
      stateOutput: null,
      stateError: null,
      createdAt: event.createdAt,
    };

    if (typeof payload.backend === "string") {
      existing.backend = payload.backend;
    }
    if (typeof payload.inputPreview === "string") {
      existing.inputPreview = trimInline(payload.inputPreview, 220);
    }
    if (typeof payload.resultPreview === "string") {
      existing.resultPreview = trimInline(payload.resultPreview, 240);
    }
    if (typeof payload.success === "boolean") {
      existing.success = payload.success;
    }
    if (typeof payload.durationMs === "number") {
      existing.durationMs = payload.durationMs;
    }
    if (event.type === "tool.state.change") {
      if (typeof payload.status === "string") {
        existing.stateStatus = payload.status;
      }
      if (payload.input !== undefined) {
        existing.stateInput = payload.input;
      }
      if (payload.output !== undefined) {
        existing.stateOutput = payload.output;
      }
      if (payload.error !== undefined) {
        existing.stateError = typeof payload.error === "string" ? payload.error : trimInline(String(payload.error), 240);
      }
    }
    existing.createdAt = event.createdAt;
    traces.set(toolCallId, existing);
  }

  return [...traces.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-MAX_TOOL_ACTIVITY_ITEMS);
}

function buildRecentToolActivityBlockFromTraces(traces: RecentToolTrace[]) {
  if (traces.length === 0) {
    return "";
  }

  const lines = [
    "## Recent Tool Activity",
    "- Treat the verified tool activity below as working memory for the still-open task.",
    "- If the latest user message is short or continuation-like, continue from these traces instead of restarting from scratch or only promising to search later.",
    "",
    "<recent_tool_activity>",
  ];

  for (const trace of traces) {
    const fragments = [`- ${trace.toolName}`];
    if (trace.backend) {
      fragments.push(`via ${trace.backend}`);
    }
    if (trace.success === true) {
      fragments.push("completed");
    } else if (trace.success === false) {
      fragments.push("failed");
    } else {
      fragments.push("started");
    }
    if (typeof trace.durationMs === "number") {
      fragments.push(`${Math.round(trace.durationMs)}ms`);
    }

    const details = [fragments.join(" · ")];
    if (trace.inputPreview) {
      details.push(`input: ${trace.inputPreview}`);
    }
    if (trace.resultPreview) {
      details.push(`result: ${trace.resultPreview}`);
    }

    lines.push(details.join(" | "));
  }

  lines.push("</recent_tool_activity>");
  return lines.join("\n");
}

function buildWorkspaceBoundarySection(projectBinding: SessionProjectBinding | null) {
  if (!projectBinding) {
    return "";
  }

  const lines = ["### Workspace Boundary"];
  if (projectBinding.projectName) {
    lines.push(`- Project: ${projectBinding.projectName}`);
  }
  if (projectBinding.projectPath) {
    lines.push(`- Path: ${projectBinding.projectPath}`);
  }
  return lines.join("\n");
}

function buildAttentionSection(attention: AttentionState) {
  if (!attention.currentLibraryTitle && !attention.focusSummary && attention.concepts.length === 0) {
    return "";
  }

  const lines = ["### Current Attention"];
  if (attention.currentLibraryTitle) {
    lines.push(`- Focused on: ${attention.currentLibraryTitle}`);
  }
  if (attention.currentSectionLabel) {
    lines.push(`- Current section: ${attention.currentSectionLabel}`);
  }
  if (attention.focusSummary) {
    lines.push(`- Summary: ${attention.focusSummary}`);
  }
  if (attention.concepts.length > 0) {
    lines.push(`- Key concepts: ${attention.concepts.join(", ")}`);
  }
  return lines.join("\n");
}

function buildPlanStateSection(plans: PlanRecord[]) {
  if (plans.length === 0) {
    return "";
  }

  const lines = ["### Plan State"];
  for (const plan of plans.slice(0, 2)) {
    lines.push(`- ${plan.title} · ${plan.status}`);
    if (plan.goal) {
      lines.push(`  goal: ${trimInline(plan.goal, 180)}`);
    }
    if (plan.steps.length > 0) {
      lines.push("  steps:");
      for (const step of plan.steps.slice(0, 4)) {
        lines.push(`    - ${trimInline(step, 120)}`);
      }
    }
  }

  return lines.join("\n");
}

function buildTaskRunSection(taskRuns: TaskRun[]) {
  if (taskRuns.length === 0) {
    return "";
  }

  const lines = ["### Session Tasks"];
  for (const taskRun of taskRuns.slice(0, 4)) {
    lines.push(`- ${taskRun.status} · ${taskRun.title}`);
    if (taskRun.detail.trim()) {
      lines.push(`  detail: ${trimInline(taskRun.detail, 180)}`);
    }
  }

  return lines.join("\n");
}

function buildTaskWorkingMemoryBlock(input: {
  sessionId: string;
  projectBinding: SessionProjectBinding | null;
  recentConversationFocus: RecentConversationFocus;
  activeTurn: string;
  recentResearchMemory: string;
  recentToolActivity: string;
}) {
  const sections: string[] = [];

  const workspaceBoundary = buildWorkspaceBoundarySection(input.projectBinding);
  if (workspaceBoundary) {
    sections.push(workspaceBoundary);
  }

  const attention = buildAttentionSection(getAttentionState());
  if (attention) {
    sections.push(attention);
  }

  const requestLines = ["### Current Request"];
  requestLines.push(`- Goal: ${trimInline(input.recentConversationFocus.resolvedCurrentRequest ?? input.recentConversationFocus.latestContent, 240)}`);
  if (input.recentConversationFocus.latestOpeningLines.length > 0) {
    requestLines.push(`- Latest opening lines: ${trimInline(input.recentConversationFocus.latestOpeningLines.join(" / "), 240)}`);
  }
  if (input.recentConversationFocus.latestClosingLines.length > 0) {
    requestLines.push(`- Latest closing lines: ${trimInline(input.recentConversationFocus.latestClosingLines.join(" / "), 240)}`);
  }
  if (input.recentConversationFocus.effectiveUserQuery && input.recentConversationFocus.effectiveUserQuery !== input.recentConversationFocus.latestContent) {
    requestLines.push(`- Effective query: ${trimInline(input.recentConversationFocus.effectiveUserQuery, 240)}`);
  }
  if (input.recentConversationFocus.carryForwardFacts) {
    requestLines.push(`- Carry-forward facts: ${trimInline(input.recentConversationFocus.carryForwardFacts, 240)}`);
  }
  if (input.recentConversationFocus.worksetConstraints) {
    requestLines.push(`- Temporary constraints: ${trimInline(input.recentConversationFocus.worksetConstraints, 240)}`);
  }
  if (input.recentConversationFocus.routeHints.reasons.length > 0) {
    requestLines.push(`- Routing hints: ${input.recentConversationFocus.routeHints.reasons.join("; ")}`);
  }
  sections.push(requestLines.join("\n"));

  if (input.activeTurn) {
    sections.push([
      "### Turn Directive",
      input.activeTurn,
    ].join("\n"));
  }

  if (input.recentToolActivity) {
    sections.push(input.recentToolActivity);
  }

  if (input.recentResearchMemory) {
    sections.push(input.recentResearchMemory);
  }

  const plans = listPlans({ sessionId: input.sessionId, limit: 2 });
  const planSection = buildPlanStateSection(plans);
  if (planSection) {
    sections.push(planSection);
  }

  const taskRuns = listTaskRuns({ sessionId: input.sessionId, limit: 4 });
  const taskSection = buildTaskRunSection(taskRuns);
  if (taskSection) {
    sections.push(taskSection);
  }

  if (sections.length === 0) {
    return "";
  }

  return [
    "## Task Working Memory",
    "- Treat this as the current task brain, not as long-term memory.",
    "",
    ...sections,
  ].join("\n\n");
}

function parseRecord(value: unknown) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function readRecordString(record: Record<string, unknown> | null, key: string) {
  if (!record) {
    return null;
  }

  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecordNumber(record: Record<string, unknown> | null, key: string) {
  if (!record) {
    return null;
  }

  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractHostname(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function parseResearchSource(value: unknown): RecentResearchSource | null {
  const record = parseRecord(value);
  if (!record) {
    return null;
  }

  const title = readRecordString(record, "title");
  const url = readRecordString(record, "url");
  if (!title || !url) {
    return null;
  }

  return {
    citationIndex: readRecordNumber(record, "citationIndex"),
    title,
    url,
    domain: readRecordString(record, "domain") ?? extractHostname(url),
    sourceType: readRecordString(record, "sourceType") ?? "unknown",
  };
}

function parseWebSearchResearchSummary(trace: RecentToolTrace): RecentResearchSearch | null {
  const inputRecord = parseRecord(trace.stateInput) ?? parseRecord(trace.inputPreview);
  const outputRecord = parseRecord(trace.stateOutput) ?? parseRecord(trace.resultPreview);
  if (!outputRecord) {
    return null;
  }

  const sources = [
    ...(Array.isArray(outputRecord.sources) ? outputRecord.sources : []),
    ...(Array.isArray(outputRecord.results) ? outputRecord.results : []),
  ]
    .map((value) => parseResearchSource(value))
    .filter((value): value is RecentResearchSource => Boolean(value))
    .slice(0, 5);

  if (sources.length === 0) {
    return null;
  }

  const query = readRecordString(inputRecord, "query")
    ?? readRecordString(outputRecord, "query")
    ?? readRecordString(outputRecord, "effectiveQuery");
  if (!query) {
    return null;
  }

  return {
    query: trimInline(query, 180),
    effectiveQuery: readRecordString(outputRecord, "effectiveQuery"),
    sources,
  };
}

function parseWebFetchResearchSummary(trace: RecentToolTrace): RecentResearchFetch | null {
  const inputRecord = parseRecord(trace.stateInput) ?? parseRecord(trace.inputPreview);
  const outputText = typeof trace.stateOutput === "string"
    ? trace.stateOutput
    : typeof trace.resultPreview === "string"
      ? trace.resultPreview
      : null;
  if (!outputText) {
    return null;
  }

  const lines = outputText.split(/\r?\n/);
  const header: Record<string, string> = {};
  let bodyStart = lines.findIndex((line) => line.trim() === "---");
  if (bodyStart < 0 && outputText.trim().startsWith("{") && outputText.includes("\"error\"")) {
    return null;
  }
  if (bodyStart >= 0) {
    for (const line of lines.slice(0, bodyStart)) {
      const match = line.match(/^([A-Za-z ][A-Za-z ]*):\s*(.*)$/);
      if (match) {
        header[match[1].trim()] = match[2].trim();
      }
    }
    bodyStart += 1;
    while (bodyStart < lines.length && !lines[bodyStart]?.trim()) {
      bodyStart += 1;
    }
  } else {
    bodyStart = 0;
  }

  const bodyExcerpt = lines
    .slice(bodyStart)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .slice(0, 2)
    .join(" / ");

  const url = header["Source URL"] || readRecordString(inputRecord, "url");
  if (!url) {
    return null;
  }

  return {
    url,
    pageTitle: header["Page Title"] ?? null,
    publishedAt: header["Published At"] ?? null,
    modifiedAt: header["Modified At"] ?? null,
    excerpt: bodyExcerpt ? trimInline(bodyExcerpt, 180) : null,
  };
}

function buildRecentResearchMemoryBlockFromTraces(traces: RecentToolTrace[]) {
  const recentSearches = traces
    .filter((trace) => trace.toolName === "web_search" && trace.success !== false)
    .map(parseWebSearchResearchSummary)
    .filter((value): value is RecentResearchSearch => Boolean(value));

  const recentFetches = traces
    .filter((trace) => trace.toolName === "web_fetch" && trace.success !== false)
    .map(parseWebFetchResearchSummary)
    .filter((value): value is RecentResearchFetch => Boolean(value));

  if (recentSearches.length === 0 && recentFetches.length === 0) {
    return "";
  }

  const searchEntries = recentSearches.slice(-2);
  const fetchEntries = recentFetches.slice(-3);
  const fetchedUrls = new Set(fetchEntries.map((entry) => entry.url));

  const lines = [
    "## Research Memory",
    "- Treat the items below as the running evidence ledger for the current investigation or report.",
    "- Search results are discovery only. Do not generate the final report until the ledger shows the remaining evidence gaps have been closed.",
    "- On follow-up turns, reuse the existing candidate URLs and fetched pages instead of starting a brand-new search from zero.",
    "- If the ledger already has an unfetched candidate URL, fetch that page next before searching again.",
    "",
    "<research_memory>",
  ];

  for (const [index, search] of searchEntries.entries()) {
    lines.push(`- Search ${index + 1}: ${search.query}`);
    if (search.effectiveQuery && search.effectiveQuery !== search.query) {
      lines.push(`  - Effective query: ${search.effectiveQuery}`);
    }
    if (search.sources.length > 0) {
      lines.push("  - Candidate sources:");
      for (const source of search.sources.slice(0, 3)) {
        const status = fetchedUrls.has(source.url) ? "fetched" : "unfetched";
        const citation = source.citationIndex !== null ? `#${source.citationIndex} ` : "";
        lines.push(`    - ${citation}${source.title} (${source.domain}) — ${status} — ${source.url}`);
      }
      const nextTarget = search.sources.find((source) => !fetchedUrls.has(source.url));
      if (nextTarget) {
        lines.push(`  - Next fetch target: ${nextTarget.url}`);
      } else {
        lines.push("  - Next fetch target: none obvious; the listed candidate pages are already fetched.");
      }
    }
  }

  if (fetchEntries.length > 0) {
    lines.push("- Fetched evidence:");
    for (const fetch of fetchEntries) {
      const details = [`${fetch.pageTitle ?? fetch.url}`, fetch.url];
      if (fetch.excerpt) {
        details.push(fetch.excerpt);
      }
      lines.push(`  - ${details.join(" | ")}`);
    }
  }

  lines.push("</research_memory>");
  return lines.join("\n");
}

function getLatestUserMessageFromSnapshot(snapshot: SessionSnapshot): string | null {
  const userMessage = getLatestUserSessionMessage(snapshot.messages);

  return userMessage?.content ?? null;
}

export function buildSessionContextFragments(sessionId: string): SessionContextFragments {
  const startedAt = nowMs();

  const snapshotStartedAt = nowMs();
  const snapshot = getSessionSnapshot(sessionId);
  const snapshotMs = roundMs(nowMs() - snapshotStartedAt);

  const latestUserStartedAt = nowMs();
  const latestUserQuery = getLatestUserMessageFromSnapshot(snapshot);
  const latestUserMs = roundMs(nowMs() - latestUserStartedAt);

  const projectBindingStartedAt = nowMs();
  const projectBinding = snapshot.project;
  const projectBindingMs = roundMs(nowMs() - projectBindingStartedAt);

  const attachmentRootsStartedAt = nowMs();
  const attachmentRoots = buildSessionAttachmentSandboxRoots(snapshot.project, snapshot.attachments);
  const attachmentRootsMs = roundMs(nowMs() - attachmentRootsStartedAt);

  const recentToolTraceStartedAt = nowMs();
  const recentToolTraces = extractRecentToolTracesFromSnapshot(sessionId, snapshot);
  const recentToolTraceMs = roundMs(nowMs() - recentToolTraceStartedAt);

  const recentConversationFocusStartedAt = nowMs();
  const recentConversationFocus = buildRecentConversationFocusFromSnapshot(snapshot, recentToolTraces);
  const recentConversationFocusMs = roundMs(nowMs() - recentConversationFocusStartedAt);

  const activeTurnStartedAt = nowMs();
  const activeTurn = buildActiveTurnBlockFromFocus(recentConversationFocus);
  const activeTurnMs = roundMs(nowMs() - activeTurnStartedAt);

  const recentToolActivityStartedAt = nowMs();
  const recentToolActivity = buildRecentToolActivityBlockFromTraces(recentToolTraces);
  const recentToolActivityMs = roundMs(nowMs() - recentToolActivityStartedAt);

  const recentResearchMemoryStartedAt = nowMs();
  const recentResearchMemory = buildRecentResearchMemoryBlockFromTraces(recentToolTraces);
  const recentResearchMemoryMs = roundMs(nowMs() - recentResearchMemoryStartedAt);

  const taskWorkingMemoryStartedAt = nowMs();
  const taskWorkingMemory = buildTaskWorkingMemoryBlock({
    sessionId,
    projectBinding,
    recentConversationFocus,
    activeTurn,
    recentResearchMemory,
    recentToolActivity,
  });
  const taskWorkingMemoryMs = roundMs(nowMs() - taskWorkingMemoryStartedAt);

  const messagesStartedAt = nowMs();
  const messages = buildSessionMessagesFromSnapshot(snapshot);
  const messagesMs = roundMs(nowMs() - messagesStartedAt);

  return {
    latestUserQuery,
    projectBinding,
    attachmentRoots,
    recentConversationFocus,
    recentResearchMemory,
    recentToolActivity,
    activeTurn,
    taskWorkingMemory,
    messages,
    timings: {
      snapshotMs,
      latestUserMs,
      projectBindingMs,
      attachmentRootsMs,
      recentToolTraceMs,
      recentConversationFocusMs,
      recentResearchMemoryMs,
      activeTurnMs,
      recentToolActivityMs,
      taskWorkingMemoryMs,
      messagesMs,
      totalMs: roundMs(nowMs() - startedAt),
      snapshotReads: 1,
    },
  };
}

export function buildSessionMessages(sessionId: string): ModelMessage[] {
  return buildSessionMessagesFromSnapshot(getSessionSnapshot(sessionId));
}

export function buildActiveTurnBlock(sessionId: string): string {
  const snapshot = getSessionSnapshot(sessionId);
  const recentToolTraces = extractRecentToolTracesFromSnapshot(sessionId, snapshot);
  const recentConversationFocus = buildRecentConversationFocusFromSnapshot(snapshot, recentToolTraces);
  return buildActiveTurnBlockFromFocus(recentConversationFocus);
}

export function buildRecentConversationFocus(sessionId: string): RecentConversationFocus {
  const snapshot = getSessionSnapshot(sessionId);
  const recentToolTraces = extractRecentToolTracesFromSnapshot(sessionId, snapshot);
  return buildRecentConversationFocusFromSnapshot(snapshot, recentToolTraces);
}

export function buildRecentConversationFocusBlock(sessionId: string): string {
  return buildRecentConversationFocus(sessionId).content;
}

export function buildRecentToolActivityBlock(sessionId: string) {
  const snapshot = getSessionSnapshot(sessionId);
  return buildRecentToolActivityBlockFromTraces(extractRecentToolTracesFromSnapshot(sessionId, snapshot));
}

export function getLatestUserMessage(sessionId: string): string | null {
  return getLatestUserMessageFromSnapshot(getSessionSnapshot(sessionId));
}
