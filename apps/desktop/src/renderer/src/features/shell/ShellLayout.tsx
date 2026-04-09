import {
  extractStructuredPlanDraft,
  reasoningEffortDefinitions,
  type Attachment,
  type ProviderTransportKind,
  type SessionEvent,
  type SessionFocusState,
  type SessionMessage,
  type SessionPlanModeState,
  type ReasoningEffort,
  type SessionRollingSummary,
  type TaskNotification,
  type ToolApproval,
  type ToolApprovalDecisionOption,
} from "@aliceloop/runtime-core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useProviderConfigs } from "../providers/useProviderConfigs";
import { settingsNav } from "./nav";
import { SourceLinksSection } from "./SourceLinks";
import { TurnMetaBadge } from "./TurnMetaBadge";
import { ToolWorkflowCard, buildToolSourceLinks, type ToolSourceLink } from "./ToolWorkflowCard";
import { type ShellPlanRecord, type ToolWorkflowEntry, useShellConversation } from "./useShellConversation";
import { useRuntimeCatalogs } from "./useRuntimeCatalogs";
import { useRuntimeSettings } from "./useRuntimeSettings";
import { WindowControls } from "./WindowControls";
import type { ShellState } from "./useShellData";
import { getDesktopBridge } from "../../platform/desktopBridge";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { MessageContent } from "./MessageContent";

interface ShellLayoutProps {
  state: ShellState;
}

interface ThreadGroup {
  key: string;
  label: string;
  threads: ReturnType<typeof useShellConversation>["threads"];
}

const sidebarMotionDurationMs = 240;
const bottomStickThresholdPx = 96;
const composerBottomClearancePx = 18;
const defaultSidebarWidthPx = 286;
const minSidebarWidthPx = 220;
const maxSidebarWidthPx = 420;
const sidebarWidthStorageKey = "aliceloop-shell-sidebar-width";
const reasoningEffortLabels = new Map(reasoningEffortDefinitions.map((definition) => [definition.id, definition.label] as const));

function formatReasoningEffortLabel(value: ReasoningEffort) {
  return reasoningEffortLabels.get(value) ?? value;
}

const providerMonograms: Record<string, string> = {
  minimax: "MM",
  gemini: "GM",
  moonshot: "K2",
  deepseek: "DS",
  zhipu: "GLM",
  aihubmix: "AH",
  openai: "OA",
  anthropic: "CL",
  openrouter: "OR",
};

const providerDescriptions: Record<string, string> = {
  minimax: "MiniMax 默认走 Anthropic 兼容接口，适合直接填官方 Key 开箱即用。",
  gemini: "Google Gemini 走 OpenAI 兼容接口，官方端点是 v1beta/openai。",
  moonshot: "Kimi / Moonshot 走 OpenAI 兼容接口，默认已填官方 v1 地址。",
  deepseek: "DeepSeek 走 OpenAI 兼容接口，适合用官方直连或兼容中转站。",
  zhipu: "GLM / 智谱默认走 OpenAI 兼容接口；如果你有专属套餐地址，也可以直接改 Base URL。",
  aihubmix: "AIHubMix 适合做多家模型聚合和第三方中转站入口。",
  openai: "官方 OpenAI，也可拿来填任何 OpenAI 兼容的第三方中转站地址。",
  anthropic: "Claude 官方直连入口，走 Anthropic 兼容协议。",
  openrouter: "OpenRouter 聚合多家模型，适合快速试不同模型路由。",
};

function formatProviderTransportLabel(transport: ProviderTransportKind) {
  switch (transport) {
    case "anthropic":
      return "Anthropic-compatible";
    case "openai-compatible":
      return "OpenAI-compatible";
    default:
      return "Auto";
  }
}

function ReasoningEffortIcon() {
  return (
    <svg
      className="composer__reasoning-option-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 4.5A2.5 2.5 0 0 0 6.5 7v.6a3.2 3.2 0 0 0-2 3c0 1.2.7 2.3 1.8 2.9V15A2.5 2.5 0 0 0 8.8 17.5H10" />
      <path d="M15 4.5A2.5 2.5 0 0 1 17.5 7v.6a3.2 3.2 0 0 1 2 3c0 1.2-.7 2.3-1.8 2.9V15a2.5 2.5 0 0 1-2.5 2.5H14" />
      <path d="M12 4.5v13" />
      <path d="M9.5 8.5c1 .5 1.4 1.3 1.4 2.5s-.4 2-1.4 2.5" />
      <path d="M14.5 8.5c-1 .5-1.4 1.3-1.4 2.5s.4 2 1.4 2.5" />
      <path d="M10 17.5c.3 1.1 1 1.8 2 2.1 1-.3 1.7-1 2-2.1" />
    </svg>
  );
}

function ModeIcon({ mode }: { mode: "bypassPermissions" | "auto" | "plan" }) {
  if (mode === "bypassPermissions") {
    return (
      <svg
        className="composer__plan-mode-btn-icon"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M4.5 6.2v11.6l7.4-5.8-7.4-5.8Z" />
        <path d="M12.1 6.2v11.6l7.4-5.8-7.4-5.8Z" />
      </svg>
    );
  }

  if (mode === "auto") {
    return (
      <svg
        className="composer__plan-mode-btn-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="4.5" y="4.5" width="8" height="8" rx="2.2" />
        <path d="M6.8 8.5h3.4" />
        <path d="M8.5 6.8v3.4" />
        <path d="M15.2 7.2h4.3" />
        <path d="M17.35 7.2v8.5" />
        <path d="M14.4 10.1h5.9" />
        <path d="M14.7 15.7h5.3" />
        <path d="M9 15.4 6.7 19.2" />
        <path d="M9 15.4 11.3 19.2" />
        <path d="M5.7 19.2h6.6" />
      </svg>
    );
  }

  return (
    <svg
      className="composer__plan-mode-btn-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 6.5h7" />
      <path d="M4.5 12h7" />
      <path d="M4.5 17.5h7" />
      <path d="M15.5 7.25 18 4.75" />
      <path d="M18 7.25 15.5 4.75" />
      <path d="M16.75 12h2.75" />
      <path d="M15.25 17.5 16.5 18.75l3-3" />
    </svg>
  );
}

function clampSidebarWidth(width: number) {
  return Math.max(minSidebarWidthPx, Math.min(maxSidebarWidthPx, width));
}

function formatBytes(byteSize: number) {
  if (byteSize < 1024) {
    return `${byteSize} B`;
  }

  if (byteSize < 1024 * 1024) {
    return `${(byteSize / 1024).toFixed(1)} KB`;
  }

  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function mergeAttachments(current: Attachment[], next: Attachment[]) {
  const merged = [...current];

  for (const attachment of next) {
    if (!merged.find((item) => item.id === attachment.id)) {
      merged.push(attachment);
    }
  }

  return merged;
}

function formatThreadId(threadId: string) {
  if (threadId.length <= 18) {
    return threadId;
  }

  return `${threadId.slice(0, 8)}…${threadId.slice(-4)}`;
}

function normalizeQuickReplyOption(value: string, side: "left" | "right") {
  let next = value.trim();
  next = next.replace(/^\d+[.)、]\s*/, "");
  next = next.replace(/^(平台|方案|方向|重点|范围|目标)\s*[-：:]\s*/u, "");
  if (side === "left") {
    next = next.replace(/^(主要是|主要|优先|偏向|先做|先支持|只做|只支持|仅做|仅支持)\s*/u, "");
  } else {
    next = next.replace(/^(也需要|也要|同时需要|同时支持|也支持|另外|还要|还需要|顺便)\s*/u, "");
  }
  next = next.replace(/\s*支持$/u, "");
  next = next.replace(/\s*为主$/u, "");
  next = next.replace(/\s+/g, " ");
  return next.trim();
}

function compactQuickReplyOption(value: string) {
  let next = value.trim();
  next = next.replace(/^\d+[.)、]\s*/, "");
  next = next.replace(/^(?:[-*•]\s*)/u, "");
  next = next.split(/\s*[—–-]\s*/u, 1)[0] ?? next;
  next = next.replace(/[（(].*$/u, "");
  next = next.replace(/\s+/gu, " ").trim();
  return next;
}

function extractQuickReplyOptions(content: string) {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const choiceQuestion = [...lines]
    .reverse()
    .find((line) => /[？?]/u.test(line) && line.includes("还是"));

  if (choiceQuestion) {
    const focusedLine = (choiceQuestion.split(/\s[-—–:：]\s/u).at(-1) ?? choiceQuestion)
      .replace(/[？?]+\s*$/u, "")
      .trim();
    const [leftRaw, rightRaw] = focusedLine.split(/\s*还是\s*/u, 2);
    if (leftRaw && rightRaw) {
      const left = normalizeQuickReplyOption(leftRaw, "left");
      const right = normalizeQuickReplyOption(rightRaw, "right");
      const options = /^(也|同时|另外|还)/u.test(rightRaw.trim())
        ? [left, right, left && right ? `${left} + ${right}` : right]
        : [left, right];
      return [...new Set(options.map((option) => option.trim()).filter((option) => option.length > 0 && option.length <= 32))].slice(0, 3);
    }
  }

  const optionGroups: string[][] = [];
  let currentGroup: string[] = [];
  for (const line of lines) {
    const bulletMatch = line.match(/^\s*(?:[-*•]|\d+[.)、])\s*(.+?)\s*$/u);
    if (bulletMatch) {
      const option = compactQuickReplyOption(bulletMatch[1] ?? "");
      if (option.length > 0 && option.length <= 32) {
        currentGroup.push(option);
      }
      continue;
    }

    if (currentGroup.length >= 2) {
      optionGroups.push(currentGroup);
    }
    currentGroup = [];
  }
  if (currentGroup.length >= 2) {
    optionGroups.push(currentGroup);
  }

  if (optionGroups.length > 0) {
    return [...new Set(optionGroups[0] ?? [])].slice(0, 3);
  }

  const listOptions = lines
    .map((line) => {
      const match = line.match(/^\s*(?:[-*•]|\d+[.)、])\s*(.+?)\s*$/u);
      return match ? compactQuickReplyOption(match[1] ?? "") : null;
    })
    .filter((line): line is string => Boolean(line))
    .filter((line) => line.length > 0 && line.length <= 40);

  return [...new Set(listOptions)].slice(0, 3);
}

function isQuestionApproval(approval: ToolApproval) {
  return approval.kind === "question" && approval.question;
}

function formatApprovalTime(isoString: string | null) {
  if (!isoString) {
    return "";
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

interface PlanMessageMeta {
  title: string;
  planId: string | null;
  status: string | null;
  bodyContent: string;
  previewContent: string;
  isExpandable: boolean;
}

function buildPlanPreviewContent(bodyContent: string) {
  const lines = bodyContent
    .split(/\r?\n/u)
    .map((line) => line.trimEnd());
  const preview = lines.slice(0, 8).join("\n").trim();
  if (!preview) {
    return bodyContent;
  }
  return preview.length < bodyContent.trim().length ? `${preview}\n\n…` : preview;
}

function ChevronToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d={expanded ? "M4.5 10L8 6.5L11.5 10" : "M4.5 6L8 9.5L11.5 6"}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function extractPlanMessageMeta(content: string): PlanMessageMeta | null {
  const planDraft = extractStructuredPlanDraft(content);
  if (!planDraft) {
    return null;
  }
  const bodyContent = planDraft.bodyContent;
  const lineCount = bodyContent.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;

  return {
    title: planDraft.title,
    planId: planDraft.planId,
    status: planDraft.status,
    bodyContent,
    previewContent: buildPlanPreviewContent(bodyContent),
    isExpandable: bodyContent.length > 560 || lineCount > 10,
  };
}

function buildActivePlanBody(plan: ShellPlanRecord) {
  const sections: string[] = [];

  if (plan.goal.trim()) {
    sections.push(`## Summary\n\n${plan.goal.trim()}`);
  }

  if (plan.steps.length > 0) {
    sections.push(`## Implementation Steps\n\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`);
  }

  if (sections.length === 0) {
    sections.push("## Summary\n\n正在整理需求与实施步骤…");
  }

  return sections.join("\n\n");
}

function hasRenderablePlanContent(plan: ShellPlanRecord | null) {
  if (!plan) {
    return false;
  }

  return plan.goal.trim().length > 0 && plan.steps.length > 0;
}

function shouldRenderActivePlanArtifact(
  plan: ShellPlanRecord | null,
  isPlanning: boolean,
  messages: import("@aliceloop/runtime-core").SessionMessage[],
  enteredAt: string | null,
) {
  if (!plan || !hasRenderablePlanContent(plan)) {
    return false;
  }

  if (!isPlanning) {
    return plan.status === "approved";
  }

  if (!enteredAt) {
    return false;
  }

  const userMessagesSinceEntered = messages.filter((message) => {
    return message.role === "user" && message.createdAt >= enteredAt && message.content.trim().length > 0;
  }).length;

  return userMessagesSinceEntered >= 3;
}

function buildActivePlanMeta(
  plan: ShellPlanRecord | null,
  isPlanning: boolean,
  messages: import("@aliceloop/runtime-core").SessionMessage[],
  enteredAt: string | null,
): PlanMessageMeta | null {
  if (!shouldRenderActivePlanArtifact(plan, isPlanning, messages, enteredAt)) {
    return null;
  }

  if (!plan) {
    return null;
  }

  const bodyContent = buildActivePlanBody(plan);
  const lineCount = bodyContent.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;

  return {
    title: plan.title,
    planId: plan.id,
    status: isPlanning ? "计划进行中" : plan.status,
    bodyContent,
    previewContent: buildPlanPreviewContent(bodyContent),
    isExpandable: bodyContent.length > 560 || lineCount > 10,
  };
}

function isDeleteToolApproval(approval: ToolApproval) {
  return approval.toolName === "delete"
    || approval.command === "rm"
    || approval.command === "rmdir"
    || approval.title.includes("删除");
}

function normalizeDeleteApprovalReply(content: string) {
  return content.trim().toLowerCase().replace(/[\s，。！？、,.!?:;'"`~·]/g, "");
}

function interpretDeleteApprovalReply(content: string): "approve" | "reject" | null {
  const normalized = normalizeDeleteApprovalReply(content);
  if (!normalized) {
    return null;
  }

  if (/(不行|不要|别删|别|取消|拒绝|不可以|不删|先别|no|n)/i.test(normalized)) {
    return "reject";
  }

  if (/^(可以|行|好|同意|确认|允许|批准|继续|删吧|删掉吧|删除吧|可以删|可以删除|ok|okay|yes|y)$/i.test(normalized)) {
    return "approve";
  }

  if (/(可以|行|好|同意|确认|允许|批准|继续|ok|okay|yes|y)/i.test(normalized)
    && /(删|删除|rm|rmdir)/i.test(normalized)
    && !/(不行|不要|别|取消|拒绝|不可以|不删|先别|no|n)/i.test(normalized)) {
    return "approve";
  }

  return null;
}

function formatResolvedApprovalStatus(approval: ToolApproval) {
  if (approval.status === "approved") {
    return approval.decisionOption === "allow_always" ? "已永久允许" : "已允许";
  }

  return approval.decisionOption === "deny_always" ? "已永久拒绝" : "已拒绝";
}

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

function buildAssistantMessageChunks(sessionEvents: SessionEvent[], toolWorkflowEntries: ToolWorkflowEntry[]): TimelineEntry[] {
  const chunks: TimelineEntry[] = [];
  const currentTurnChunks: TimelineEntry[] = [];
  const currentTurnSourceLinks: ToolSourceLink[] = [];
  const currentTurnTools = new Set<string>();
  const currentTurnSkills = new Set<string>();
  const sourceLinksByToolCallId = new Map<string, ToolSourceLink[]>(
    toolWorkflowEntries.map((entry) => [entry.toolCallId, buildToolSourceLinks(entry)] as const),
  );
  const seenSourceToolCallIds = new Set<string>();
  let activeMessage: SessionMessage | null = null;
  let currentContent = "";
  let lastEmittedContent = "";
  let chunkIndex = 0;

  function flush(sortSeq: number, sortTime: string) {
    if (!activeMessage) {
      return;
    }

    if (!currentContent || currentContent === lastEmittedContent) {
      return;
    }

    const emittedContent = currentContent.startsWith(lastEmittedContent)
      ? currentContent.slice(lastEmittedContent.length)
      : currentContent;

    currentTurnChunks.push({
      kind: "message",
      message: {
        ...activeMessage,
        id: `${activeMessage.id}::chunk-${chunkIndex++}`,
        content: emittedContent,
      },
      sortSeq,
      sortTime,
      sourceLinks: [],
      turnMeta: null,
    });

    lastEmittedContent = currentContent;
  }

  function finalizeTurn() {
    if (currentTurnChunks.length === 0) {
      currentTurnSourceLinks.length = 0;
      return;
    }

    const sourceLinks = dedupeToolSourceLinks(currentTurnSourceLinks);
    if (sourceLinks.length > 0) {
      const lastChunk = currentTurnChunks.at(-1);
      if (lastChunk?.kind === "message") {
        lastChunk.sourceLinks = sourceLinks;
      }
    }
    const turnMeta = {
      tools: [...currentTurnTools],
      skills: [...currentTurnSkills],
    };
    for (const chunk of currentTurnChunks) {
      if (chunk.kind === "message") {
        chunk.turnMeta = turnMeta;
      }
    }
    chunks.push(...currentTurnChunks);
    currentTurnChunks.length = 0;
    currentTurnSourceLinks.length = 0;
    currentTurnTools.clear();
    currentTurnSkills.clear();
  }

  for (const event of sessionEvents) {
    if (event.type === "message.created" || event.type === "message.acked" || event.type === "message.updated") {
      const payload = event.payload as { message?: SessionMessage; skills?: unknown; tools?: unknown };
      const message = payload.message;
      if (!message) {
        continue;
      }

      if (message.role === "assistant" && Array.isArray(payload.skills)) {
        for (const skill of payload.skills) {
          if (typeof skill === "string" && skill.trim()) {
            currentTurnSkills.add(skill.trim());
          }
        }
      }

      if (message.role === "assistant" && Array.isArray(payload.tools)) {
        for (const tool of payload.tools) {
          if (typeof tool === "string" && tool.trim()) {
            currentTurnTools.add(tool.trim());
          }
        }
      }

      if (message.role !== "assistant") {
        flush(event.seq - 0.5, event.createdAt);
        finalizeTurn();
        activeMessage = null;
        currentContent = "";
        lastEmittedContent = "";
        continue;
      }

      activeMessage = message;
      currentContent = message.content;
      continue;
    }

    if (event.type.startsWith("tool.")) {
      flush(event.seq, event.createdAt);
      const payload = event.payload as { toolCallId?: unknown; toolName?: unknown };
      if (typeof payload.toolName === "string" && payload.toolName.trim()) {
        currentTurnTools.add(payload.toolName.trim());
      }
      if (typeof payload.toolCallId === "string" && !seenSourceToolCallIds.has(payload.toolCallId)) {
        seenSourceToolCallIds.add(payload.toolCallId);
        const sourceLinks = sourceLinksByToolCallId.get(payload.toolCallId);
        if (sourceLinks?.length) {
          currentTurnSourceLinks.push(...sourceLinks);
        }
      }
    }

    if (event.type === "task.notification") {
      flush(event.seq - 0.5, event.createdAt);
      finalizeTurn();
      activeMessage = null;
      currentContent = "";
      lastEmittedContent = "";
    }
  }

  const lastEvent = sessionEvents.at(-1);
  if (activeMessage) {
    flush((lastEvent?.seq ?? 0) + 1, lastEvent?.createdAt ?? activeMessage.createdAt);
  }

  finalizeTurn();
  return chunks;
}

type TimelineEntry =
  | {
      kind: "message";
      message: import("@aliceloop/runtime-core").SessionMessage;
      sortSeq: number | null;
      sortTime: string;
      sourceLinks: ToolSourceLink[];
      turnMeta: {
        tools: string[];
        skills: string[];
      } | null;
    }
  | {
      kind: "active-plan";
      planMeta: PlanMessageMeta;
      sortSeq: null;
      sortTime: string;
    }
  | {
      kind: "plan-transition";
      transition: "entered" | "exited";
      planMode: SessionPlanModeState;
      taskId: string | null;
      sortSeq: number | null;
      sortTime: string;
    }
  | {
      kind: "approval";
      approval: ToolApproval;
      sortSeq: number | null;
      sortTime: string;
    }
  | {
      kind: "tool";
      tool: ToolWorkflowEntry;
      sortSeq: number | null;
      sortTime: string;
    }
  | {
      kind: "task-notification";
      notification: TaskNotification;
      sortSeq: number | null;
      sortTime: string;
    };

type TimelineBlock =
  | {
      kind: "message";
      message: import("@aliceloop/runtime-core").SessionMessage;
      sourceLinks: ToolSourceLink[];
      turnMeta: {
        tools: string[];
        skills: string[];
      } | null;
    }
  | {
      kind: "assistant-turn";
      turnMeta: {
        tools: string[];
        skills: string[];
      };
      items: Array<
        | {
            kind: "message";
            message: import("@aliceloop/runtime-core").SessionMessage;
            sourceLinks: ToolSourceLink[];
          }
        | {
            kind: "tool";
            tool: ToolWorkflowEntry;
          }
      >;
    }
  | { kind: "approval"; approval: ToolApproval }
  | { kind: "tool"; tool: ToolWorkflowEntry }
  | {
      kind: "tool-group";
      groupKey: string;
      groupLabel: string;
      tools: ToolWorkflowEntry[];
    }
  | {
      kind: "task-notification";
      notification: TaskNotification;
    }
  | {
      kind: "active-plan";
      planMeta: PlanMessageMeta;
    }
  | {
      kind: "plan-transition";
      transition: "entered" | "exited";
      planMode: SessionPlanModeState;
      taskId: string | null;
    };

function buildTimeline(
  messages: import("@aliceloop/runtime-core").SessionMessage[],
  resolvedApprovals: ToolApproval[],
  toolWorkflowEntries: ToolWorkflowEntry[],
  sessionEvents: SessionEvent[],
  activePlanMeta: PlanMessageMeta | null,
  activePlanUpdatedAt: string | null,
): TimelineBlock[] {
  const messageSeqById = new Map<string, number>();
  const approvalSeqById = new Map<string, number>();
  const entries: TimelineEntry[] = [];

  for (const event of sessionEvents) {
    if (event.type === "message.created" || event.type === "message.acked" || event.type === "message.updated") {
      const payload = event.payload as { message?: { id?: unknown } };
      if (typeof payload.message?.id === "string") {
        messageSeqById.set(payload.message.id, event.seq);
      }
    }

    if (event.type === "tool.approval.resolved") {
      const payload = event.payload as { approval?: { id?: unknown } };
      if (typeof payload.approval?.id === "string") {
        approvalSeqById.set(payload.approval.id, event.seq);
      }
    }

    if (event.type === "plan_mode.updated") {
      const payload = event.payload as {
        planMode?: SessionPlanModeState;
        transition?: unknown;
        taskId?: unknown;
      };
      if (
        payload.planMode
        && (payload.transition === "entered" || payload.transition === "exited")
      ) {
        entries.push({
          kind: "plan-transition",
          transition: payload.transition,
          planMode: payload.planMode,
          taskId: typeof payload.taskId === "string" ? payload.taskId : null,
          sortSeq: event.seq,
          sortTime: event.createdAt,
        });
      }
    }

    if (event.type === "task.notification") {
      const payload = event.payload as { notification?: TaskNotification };
      if (payload.notification) {
        entries.push({
          kind: "task-notification",
          notification: payload.notification,
          sortSeq: event.seq,
          sortTime: event.createdAt,
        });
      }
    }
  }

  for (const message of messages) {
    if (message.role === "assistant") {
      continue;
    }

    entries.push({
      kind: "message",
      message,
      sortSeq: messageSeqById.get(message.id) ?? null,
      sortTime: message.createdAt,
      sourceLinks: [],
      turnMeta: null,
    });
  }

  for (const approval of resolvedApprovals) {
    if (isQuestionApproval(approval)) {
      continue;
    }
    entries.push({
      kind: "approval",
      approval,
      sortSeq: approvalSeqById.get(approval.id) ?? null,
      sortTime: approval.resolvedAt ?? approval.requestedAt,
    });
  }

  for (const tool of toolWorkflowEntries) {
    entries.push({
      kind: "tool",
      tool,
      sortSeq: tool.createdSeq,
      sortTime: tool.createdAt,
    });
  }

  if (activePlanMeta && activePlanUpdatedAt) {
    entries.push({
      kind: "active-plan",
      planMeta: activePlanMeta,
      sortSeq: null,
      sortTime: activePlanUpdatedAt,
    });
  }

  entries.push(...buildAssistantMessageChunks(sessionEvents, toolWorkflowEntries));

  entries.sort((a, b) => {
    if (a.sortSeq !== null || b.sortSeq !== null) {
      if (a.sortSeq !== null && b.sortSeq !== null && a.sortSeq !== b.sortSeq) {
        return a.sortSeq - b.sortSeq;
      }

      if (a.sortSeq !== null && b.sortSeq === null) {
        return -1;
      }

      if (a.sortSeq === null && b.sortSeq !== null) {
        return 1;
      }
    }

    const timeCompare = a.sortTime.localeCompare(b.sortTime);
    if (timeCompare !== 0) {
      return timeCompare;
    }

    const kindOrder: Record<TimelineEntry["kind"], number> = {
      message: 0,
      approval: 1,
      tool: 2,
      "task-notification": 3,
      "plan-transition": 4,
      "active-plan": 5,
    };

    return kindOrder[a.kind] - kindOrder[b.kind];
  });

  const blocks: TimelineBlock[] = [];
  let pendingAssistantTurn: {
    turnMeta: {
      tools: string[];
      skills: string[];
    } | null;
    items: Array<
      | {
          kind: "message";
          message: import("@aliceloop/runtime-core").SessionMessage;
          sourceLinks: ToolSourceLink[];
        }
      | {
          kind: "tool";
          tool: ToolWorkflowEntry;
        }
    >;
  } | null = null;

  function flushAssistantTurn() {
    if (!pendingAssistantTurn) {
      return;
    }

    if (pendingAssistantTurn.items.length > 0) {
      blocks.push({
        kind: "assistant-turn",
        turnMeta: pendingAssistantTurn.turnMeta ?? { tools: [], skills: [] },
        items: pendingAssistantTurn.items,
      });
    }

    pendingAssistantTurn = null;
  }

  for (const entry of entries) {
    if (entry.kind === "tool") {
      if (!pendingAssistantTurn) {
        pendingAssistantTurn = {
          turnMeta: null,
          items: [],
        };
      }

      pendingAssistantTurn.items.push({
        kind: "tool",
        tool: entry.tool,
      });
      continue;
    }

    if (entry.kind === "message" && entry.message.role === "assistant") {
      if (!pendingAssistantTurn) {
        pendingAssistantTurn = {
          turnMeta: entry.turnMeta,
          items: [],
        };
      } else if (!pendingAssistantTurn.turnMeta) {
        pendingAssistantTurn.turnMeta = entry.turnMeta;
      }

      pendingAssistantTurn.items.push({
        kind: "message",
        message: entry.message,
        sourceLinks: entry.sourceLinks,
      });
      continue;
    }

    if (entry.kind === "active-plan") {
      flushAssistantTurn();
      blocks.push({
        kind: "active-plan",
        planMeta: entry.planMeta,
      });
      continue;
    }

    if (entry.kind === "task-notification") {
      flushAssistantTurn();
      blocks.push({
        kind: "task-notification",
        notification: entry.notification,
      });
      continue;
    }

    flushAssistantTurn();
    blocks.push(entry);
  }

  flushAssistantTurn();
  return blocks;
}

function getAssistantTurnRenderKey(
  sessionId: string,
  entry: Extract<TimelineBlock, { kind: "assistant-turn" }>,
) {
  const firstItem = entry.items[0];
  if (!firstItem) {
    return `assistant-turn-${sessionId}-empty`;
  }

  if (firstItem.kind === "message") {
    return `assistant-turn-${sessionId}-message-${firstItem.message.id}`;
  }

  return `assistant-turn-${sessionId}-tool-${firstItem.tool.toolCallId}`;
}

function getThreadDateParts(value: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return {
    key: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
    label: new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date),
  };
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function getAttachmentLabel(attachments: Attachment[]): string | null {
  if (attachments.length === 0) {
    return null;
  }

  const images = attachments.filter((a) => isImageMimeType(a.mimeType));
  const files = attachments.filter((a) => !isImageMimeType(a.mimeType));

  const parts: string[] = [];

  if (images.length > 0) {
    if (images.length === 1) {
      parts.push("Image #1");
    } else {
      for (let i = 1; i <= images.length; i++) {
        parts.push(`Image #${i}`);
      }
    }
  }

  if (files.length > 0) {
    for (let i = 1; i <= files.length; i++) {
      parts.push(`code #${i}`);
    }
  }

  return parts.join(" · ");
}

function getAttachmentContentUrl(baseUrl: string | null, sessionId: string, attachment: Attachment): string | null {
  if (!baseUrl) {
    return null;
  }

  return `${baseUrl}/api/session/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachment.id)}/content`;
}

function groupThreadsByDate(threads: ReturnType<typeof useShellConversation>["threads"]): ThreadGroup[] {
  const groups: ThreadGroup[] = [];

  for (const thread of threads) {
    const sourceDate = thread.latestMessageAt ?? thread.updatedAt ?? thread.createdAt;
    const parts = getThreadDateParts(sourceDate) ?? {
      key: "unknown",
      label: "更早",
    };

    const currentGroup = groups.at(-1);
    if (currentGroup?.key === parts.key) {
      currentGroup.threads.push(thread);
      continue;
    }

    groups.push({
      key: parts.key,
      label: parts.label,
      threads: [thread],
    });
  }

  return groups;
}

export function ShellLayout({ state }: ShellLayoutProps) {
  const { data } = state;
  const providerState = useProviderConfigs();
  const runtimeCatalogs = useRuntimeCatalogs();
  const runtimeSettings = useRuntimeSettings();
  const conversation = useShellConversation();
  const desktopBridge = getDesktopBridge();
  const threadGroups = groupThreadsByDate(conversation.threads);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [sidebarMotion, setSidebarMotion] = useState<"opening" | "closing" | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") {
      return defaultSidebarWidthPx;
    }

    const storedWidth = Number(window.localStorage.getItem(sidebarWidthStorageKey));
    if (!Number.isFinite(storedWidth) || storedWidth <= 0) {
      return defaultSidebarWidthPx;
    }

    return clampSidebarWidth(storedWidth);
  });
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState("general");
  const [activeProviderId, setActiveProviderId] = useState("");
  const [providerApiKeyInput, setProviderApiKeyInput] = useState("");
  const [providerBaseUrlInput, setProviderBaseUrlInput] = useState("");
  const [providerModelInput, setProviderModelInput] = useState("");
  const [providerEnabled, setProviderEnabled] = useState(false);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);
  const [reasoningEffortInput, setReasoningEffortInput] = useState<ReasoningEffort>("medium");
  const [reasoningNotice, setReasoningNotice] = useState<string | null>(null);
  const [mcpView, setMcpView] = useState<"marketplace" | "installed">("marketplace");
  const [mcpNotice, setMcpNotice] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState("");
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(176);
  const [composerReserveSpace, setComposerReserveSpace] = useState(192);
  const [expandedPlanMessageIds, setExpandedPlanMessageIds] = useState<Set<string>>(() => new Set());
  const [isActivePlanExpanded, setIsActivePlanExpanded] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [queuedAttachments, setQueuedAttachments] = useState<Attachment[]>([]);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [reasoningDropdownOpen, setReasoningDropdownOpen] = useState(false);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const [threadNotice, setThreadNotice] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [selectedQuestionOptions, setSelectedQuestionOptions] = useState<string[]>([]);
  const approvalDockRef = useRef<HTMLDivElement | null>(null);
  const [approvalAttachments, setApprovalAttachments] = useState<Attachment[]>([]);
  const motionTimerRef = useRef<number | null>(null);
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const composerAddFileButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousSessionIdRef = useRef<string | null>(null);
  const previousViewportHeightRef = useRef<number | null>(null);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const scrollSyncTimeoutRef = useRef<number | null>(null);
  const sidebarResizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const providers = providerState.providers;
  const configuredProviders = providers.filter((provider) => provider.hasApiKey);
  const activeProvider = providers.find((item) => item.id === activeProviderId) ?? providers[0] ?? null;
  const enabledProvider = configuredProviders.find((item) => item.enabled)
    ?? providers.find((item) => item.enabled) ?? null;
  const currentModeLabel = conversation.planMode.active
    ? (conversation.exitingPlanMode ? "计划中…" : "计划模式")
    : (runtimeSettings.settings.autoApproveToolRequests ? "完全访问" : "auto模式");
  const currentModeIcon = conversation.planMode.active
    ? "plan" as const
    : (runtimeSettings.settings.autoApproveToolRequests ? "bypassPermissions" as const : "auto" as const);
  const currentModeButtonClassName = `composer__plan-mode-btn${
    currentModeIcon === "plan"
      ? " composer__plan-mode-btn--plan"
      : currentModeIcon === "auto"
        ? " composer__plan-mode-btn--auto"
        : " composer__plan-mode-btn--bypass"
  }`;
  const modeSwitchDisabled = conversation.enteringPlanMode || conversation.exitingPlanMode || runtimeSettings.saving;
  const activeToolApproval = useMemo(() => {
    if (conversation.pendingCommandApprovals.length === 0) {
      return null;
    }

    const pendingApprovalsByToolCallId = new Map(
      conversation.pendingCommandApprovals.flatMap((approval) => (
        typeof approval.toolCallId === "string" && approval.toolCallId.length > 0
          ? [[approval.toolCallId, approval] as const]
          : []
      )),
    );

    for (let index = conversation.toolWorkflowEntries.length - 1; index >= 0; index -= 1) {
      const entry = conversation.toolWorkflowEntries[index];
      if (entry.status !== "approval-requested") {
        continue;
      }

      const matchingApproval = pendingApprovalsByToolCallId.get(entry.toolCallId);
      if (matchingApproval) {
        return matchingApproval;
      }
    }

    return conversation.pendingCommandApprovals[0] ?? null;
  }, [conversation.pendingCommandApprovals, conversation.toolWorkflowEntries]);
  const activePlanMeta = useMemo(
    () => buildActivePlanMeta(
      conversation.activePlan,
      conversation.planMode.active,
      conversation.messages,
      conversation.planMode.enteredAt,
    ),
    [conversation.activePlan, conversation.planMode.active, conversation.messages, conversation.planMode.enteredAt],
  );
  const timelineBlocks = useMemo(
    () => buildTimeline(
      conversation.messages,
      conversation.resolvedToolApprovals,
      conversation.toolWorkflowEntries,
      conversation.sessionEvents,
      activePlanMeta,
      conversation.activePlan?.updatedAt ?? null,
    ),
    [
      conversation.messages,
      conversation.resolvedToolApprovals,
      conversation.toolWorkflowEntries,
      conversation.sessionEvents,
      activePlanMeta,
      conversation.activePlan?.updatedAt,
    ],
  );
  const planMetaByMessageId = useMemo(() => {
    if (activePlanMeta) {
      return new Map<string, PlanMessageMeta>();
    }

    const next = new Map<string, PlanMessageMeta>();
    for (const message of conversation.messages) {
      if (message.role !== "assistant") {
        continue;
      }
      const planMeta = extractPlanMessageMeta(message.content);
      if (planMeta) {
        next.set(message.id, planMeta);
      }
    }
    return next;
  }, [conversation.messages, activePlanMeta]);
  const activeQuestionApproval = useMemo(() => {
    return conversation.pendingQuestionApprovals[0] ?? null;
  }, [conversation.pendingQuestionApprovals]);
  const activeQuestionPrompt = activeQuestionApproval?.question ?? null;
  const activeDeleteApproval = activeToolApproval ? isDeleteToolApproval(activeToolApproval) : false;
  const composerHasText = composerDraft.trim().length > 0;
  const composerHasStructuredSelection = Boolean(activeQuestionPrompt?.multiSelect && selectedQuestionOptions.length > 0);
  const composerHasSendableContent = composerHasText || queuedAttachments.length > 0 || composerHasStructuredSelection;
  const isComposerBusy = conversation.isResponding || conversation.isAwaitingToolApproval;
  const latestVisibleMessage = useMemo(() => {
    return [...conversation.messages]
      .reverse()
      .find((message) => message.role !== "system" && message.content.trim().length > 0) ?? null;
  }, [conversation.messages]);

  useEffect(() => {
    setIsActivePlanExpanded(false);
  }, [activePlanMeta?.planId, conversation.activePlan?.updatedAt]);
  const composerQuickReplies = useMemo(() => {
    if (
      activeQuestionPrompt
      || conversation.pending
      || conversation.pendingUpload
      || isComposerBusy
      || composerHasText
      || queuedAttachments.length > 0
    ) {
      return [];
    }

    if (!latestVisibleMessage || latestVisibleMessage.role !== "assistant") {
      return [];
    }

    return extractQuickReplyOptions(latestVisibleMessage.content);
  }, [
    composerHasText,
    activeQuestionPrompt,
    conversation.pending,
    conversation.pendingUpload,
    isComposerBusy,
    latestVisibleMessage,
    queuedAttachments.length,
  ]);
  const installedMcpServers = runtimeCatalogs.mcpServers.filter((server) => server.installStatus === "installed");
  const visibleMcpServers = (mcpView === "installed" ? installedMcpServers : runtimeCatalogs.mcpServers)
    .slice()
    .sort((left, right) => Number(right.featured) - Number(left.featured) || left.label.localeCompare(right.label, "zh-CN"));
  const shellStyle = {
    "--shell-sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties;
  const shellMainStyle = {
    "--composer-height": `${composerHeight}px`,
    "--composer-reserve-space": `${composerReserveSpace}px`,
  } as CSSProperties;

  useEffect(() => {
    return () => {
      if (motionTimerRef.current) {
        window.clearTimeout(motionTimerRef.current);
      }

      if (scrollSyncFrameRef.current) {
        window.cancelAnimationFrame(scrollSyncFrameRef.current);
      }

      if (scrollSyncTimeoutRef.current) {
        window.clearTimeout(scrollSyncTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!previewImage) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPreviewImage(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewImage]);

  useEffect(() => {
    setSelectedQuestionOptions([]);
  }, [activeQuestionApproval?.id]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(sidebarWidthStorageKey, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isSidebarResizing) {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = sidebarResizeStateRef.current;
      if (!dragState) {
        return;
      }

      const nextWidth = clampSidebarWidth(dragState.startWidth + event.clientX - dragState.startX);
      setSidebarWidth(nextWidth);
    };

    const stopResize = () => {
      sidebarResizeStateRef.current = null;
      setIsSidebarResizing(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);

    return () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
  }, [isSidebarResizing]);

  const syncViewportToBottom = (force = false) => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }

    if (!force && !shouldStickToBottomRef.current) {
      return;
    }

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: "auto",
    });
    shouldStickToBottomRef.current = true;
    setIsAtBottom(true);
  };

  const scheduleViewportBottomSync = (force = false) => {
    if (!force && !shouldStickToBottomRef.current) {
      return;
    }

    if (scrollSyncFrameRef.current) {
      window.cancelAnimationFrame(scrollSyncFrameRef.current);
    }

    if (scrollSyncTimeoutRef.current) {
      window.clearTimeout(scrollSyncTimeoutRef.current);
    }

    scrollSyncFrameRef.current = window.requestAnimationFrame(() => {
      syncViewportToBottom(force);
      scrollSyncFrameRef.current = window.requestAnimationFrame(() => {
        syncViewportToBottom(force);
      });
    });

    scrollSyncTimeoutRef.current = window.setTimeout(() => {
      syncViewportToBottom(force);
      scrollSyncTimeoutRef.current = null;
    }, 140);
  };

  useEffect(() => {
    if (!activeProvider) {
      return;
    }

    setProviderBaseUrlInput(activeProvider.baseUrl);
    setProviderModelInput(activeProvider.model);
    setProviderEnabled(activeProvider.enabled);
  }, [activeProvider]);

  useEffect(() => {
    setReasoningEffortInput(runtimeSettings.settings.reasoningEffort);
  }, [runtimeSettings.settings.reasoningEffort]);

  useEffect(() => {
    if (providers.length === 0) {
      return;
    }

    if (!providers.some((provider) => provider.id === activeProviderId)) {
      setActiveProviderId(providers[0].id);
    }
  }, [activeProviderId, providers]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }

    const updateStickiness = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const nextIsAtBottom = distanceFromBottom <= bottomStickThresholdPx;
      shouldStickToBottomRef.current = nextIsAtBottom;
      setIsAtBottom((current) => (current === nextIsAtBottom ? current : nextIsAtBottom));
    };

    updateStickiness();
    viewport.addEventListener("scroll", updateStickiness, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", updateStickiness);
    };
  }, []);

  useLayoutEffect(() => {
    const sessionChanged = previousSessionIdRef.current !== conversation.sessionId;
    previousSessionIdRef.current = conversation.sessionId;

    if (!sessionChanged && !shouldStickToBottomRef.current) {
      return;
    }

    scheduleViewportBottomSync(sessionChanged);
  }, [composerHeight, composerReserveSpace, conversation.sessionId, conversation.messages, conversation.latestJob?.updatedAt, conversation.pendingToolApprovals]);

  // Scroll approval card into view when it appears
  useEffect(() => {
    if (!activeToolApproval) {
      return;
    }
    // Clear attachments from previous approval
    setApprovalAttachments([]);
    // Wait for DOM render then scroll
    const frame = requestAnimationFrame(() => {
      const viewport = messagesViewportRef.current;
      if (!viewport) {
        return;
      }
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversation.pendingCommandApprovals.length]);

  // Handle paste (image drop) on approval dock
  useEffect(() => {
    const dock = approvalDockRef.current;
    if (!dock) {
      return;
    }

    function handlePaste(event: ClipboardEvent) {
      const items = Array.from(event.clipboardData?.items ?? []);
      const imageItems = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"));
      if (imageItems.length === 0) {
        return;
      }

      event.preventDefault();

      for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) {
          continue;
        }

        void (async () => {
          const result = await conversation.uploadAttachment(file);
          if (result.ok && result.attachment) {
            setApprovalAttachments((current) => {
              if (current.find((a) => a.id === result.attachment!.id)) {
                return current;
              }
              return [...current, result.attachment!];
            });
          }
        })();
      }
    }

    dock.addEventListener("paste", handlePaste);
    return () => dock.removeEventListener("paste", handlePaste);
  }, [conversation]);

  useEffect(() => {
    const content = messagesContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      if (!shouldStickToBottomRef.current) {
        return;
      }

      scheduleViewportBottomSync();
    });

    resizeObserver.observe(content);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const composer = composerRef.current;
    const viewport = messagesViewportRef.current;
    if (!composer || !viewport) {
      return;
    }

    const updateComposerLayout = () => {
      const viewportRect = viewport.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const nextViewportHeight = Math.ceil(viewportRect.height);
      const nextHeight = Math.ceil(composer.getBoundingClientRect().height);
      const nextReserveSpace =
        Math.max(nextHeight, Math.ceil(viewportRect.bottom - composerRect.top)) + composerBottomClearancePx;
      const viewportShrunk =
        previousViewportHeightRef.current !== null && nextViewportHeight < previousViewportHeightRef.current;

      previousViewportHeightRef.current = nextViewportHeight;
      setComposerHeight((current) => (current === nextHeight ? current : nextHeight));
      setComposerReserveSpace((current) => (current === nextReserveSpace ? current : nextReserveSpace));

      if (viewportShrunk && shouldStickToBottomRef.current) {
        scheduleViewportBottomSync(true);
      }
    };

    updateComposerLayout();

    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateComposerLayout) : null;
    resizeObserver?.observe(composer);
    resizeObserver?.observe(viewport);
    window.addEventListener("resize", updateComposerLayout);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateComposerLayout);
    };
  }, []);

  function toggleSidebar() {
    const nextCollapsed = !isSidebarCollapsed;
    setSidebarMotion(nextCollapsed ? "closing" : "opening");
    setIsSidebarCollapsed(nextCollapsed);

    if (motionTimerRef.current) {
      window.clearTimeout(motionTimerRef.current);
    }

    motionTimerRef.current = window.setTimeout(() => {
      setSidebarMotion(null);
    }, sidebarMotionDurationMs);
  }

  function handleSidebarResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (isSidebarCollapsed) {
      return;
    }

    event.preventDefault();
    sidebarResizeStateRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    setIsSidebarResizing(true);
  }

  async function saveActiveProvider() {
    if (!activeProvider) {
      setProviderNotice("当前还没有可编辑的模型网关配置。");
      return;
    }

    setProviderNotice(null);
    const result = await providerState.save({
      providerId: activeProvider.id,
      baseUrl: providerBaseUrlInput,
      model: providerModelInput,
      apiKey: providerApiKeyInput.trim() ? providerApiKeyInput.trim() : undefined,
      enabled: providerEnabled,
    });

    if (!result.ok) {
      setProviderNotice(result.error ?? `保存 ${activeProvider.label} 配置失败`);
      return;
    }

    if (providerEnabled) {
      const otherEnabledProviders = providers.filter((provider) => provider.id !== activeProvider.id && provider.enabled);
      const disableResults = await Promise.all(otherEnabledProviders.map((provider) => providerState.save({
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        model: provider.model,
        enabled: false,
      })));
      if (disableResults.some((item) => !item.ok)) {
        setProviderApiKeyInput("");
        setProviderNotice(`${result.config?.label ?? activeProvider.label} 已保存，但其他已启用模型没有全部关闭。`);
        return;
      }
    }

    setProviderApiKeyInput("");
    setProviderNotice(`${result.config?.label ?? activeProvider.label} 已保存。后续真实消息会通过当前启用的模型网关发出。`);
  }

  async function saveRuntimePreferences() {
    setReasoningNotice(null);
    const result = await runtimeSettings.save({
      reasoningEffort: reasoningEffortInput,
    });

    if (!result.ok) {
      const message = result.error ?? "保存运行时设置失败";
      setReasoningNotice(message);
      return;
    }

    setReasoningNotice(`推理强度已切换为「${formatReasoningEffortLabel(reasoningEffortInput)}」。`);
  }

  async function submitComposerDraft() {
    const content = composerDraft.trim();
    if (!content && queuedAttachments.length === 0 && !composerHasStructuredSelection) {
      return;
    }

    if (activeDeleteApproval && activeToolApproval && queuedAttachments.length === 0) {
      const approvalReply = interpretDeleteApprovalReply(content);
      if (approvalReply) {
        setComposerNotice(null);
        const result =
          approvalReply === "approve"
            ? await conversation.approveToolApproval(activeToolApproval.id)
            : await conversation.rejectToolApproval(activeToolApproval.id);

        if (!result.ok) {
          setComposerNotice(result.error ?? "命令审批失败");
          return;
        }

        setComposerDraft("");
        setQueuedAttachments([]);
        setApprovalAttachments([]);
        return;
      }
    }

    setComposerNotice(null);
    const outboundContent = content || (composerHasStructuredSelection ? selectedQuestionOptions.join("、") : "");
    const result = await conversation.sendMessage(outboundContent, queuedAttachments.map((attachment) => attachment.id));
    if (!result.ok) {
      setComposerNotice(result.error ?? "发送失败");
      return;
    }

    setComposerDraft("");
    setQueuedAttachments([]);
    setSelectedQuestionOptions([]);
  }

  async function handleQuickReply(option: string) {
    if (conversation.pending || conversation.pendingUpload || isComposerBusy) {
      return;
    }

    setComposerNotice(null);
    const result = await conversation.sendMessage(option);
    if (!result.ok) {
      setComposerDraft(option);
      setComposerNotice(result.error ?? "发送失败");
    }
  }

  async function handleQuestionOptionClick(option: string) {
    if (!activeQuestionPrompt) {
      return;
    }

    if (activeQuestionPrompt.multiSelect) {
      setSelectedQuestionOptions((current) => (
        current.includes(option)
          ? current.filter((item) => item !== option)
          : [...current, option]
      ));
      return;
    }

    setComposerNotice(null);
    const result = await conversation.sendMessage(option);
    if (!result.ok) {
      setComposerDraft(option);
      setComposerNotice(result.error ?? "发送失败");
      return;
    }

    setSelectedQuestionOptions([]);
  }

  async function handleComposerPrimaryAction() {
    if (conversation.pending) {
      return;
    }

    if (conversation.isAwaitingToolApproval && activeDeleteApproval) {
      if (composerHasText) {
        await submitComposerDraft();
      } else {
        setComposerNotice("直接回复“可以删除”继续，或者回复“取消”拒绝。");
      }
      return;
    }

    if (isComposerBusy) {
      setComposerNotice(null);
      const result = await conversation.stopResponse();
      if (!result.ok) {
        setComposerNotice(result.error ?? "停止失败");
      }
      return;
    }

    await submitComposerDraft();
  }

  function handleScrollToBottom() {
    syncViewportToBottom(true);
  }

  async function submitComposer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await handleComposerPrimaryAction();
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    void handleComposerPrimaryAction();
  }

  async function createThread() {
    setThreadNotice(null);
    setQueuedAttachments([]);
    const result = await conversation.createSession();
    if (!result.ok) {
      setThreadNotice(result.error ?? "新建线程失败");
    }
  }

  async function installMcpServer(serverId: string) {
    setMcpNotice(null);
    const result = await runtimeCatalogs.installMcpServer(serverId);
    if (!result.ok) {
      setMcpNotice(result.error ?? "安装 MCP 服务器失败");
      return;
    }

    setMcpNotice(`${result.server?.label ?? serverId} 已加入 Aliceloop 的 MCP 已安装列表。`);
  }

  async function uninstallMcpServer(serverId: string) {
    setMcpNotice(null);
    const result = await runtimeCatalogs.uninstallMcpServer(serverId);
    if (!result.ok) {
      setMcpNotice(result.error ?? "移除 MCP 服务器失败");
      return;
    }

    setMcpNotice(`${result.server?.label ?? serverId} 已从 Aliceloop 的 MCP 已安装列表移除。`);
  }

  async function resolveToolApproval(
    action: "approve" | "reject",
    decisionOption?: ToolApprovalDecisionOption,
  ) {
    if (!activeToolApproval) {
      return;
    }

    setComposerNotice(null);
    const result =
      action === "approve"
        ? await conversation.approveToolApproval(activeToolApproval.id, decisionOption)
        : await conversation.rejectToolApproval(activeToolApproval.id, decisionOption);

    if (!result.ok) {
      setComposerNotice(result.error ?? "命令审批失败");
    }
    setApprovalAttachments([]);
  }

  async function handleExitPlanMode() {
    setComposerNotice(null);
    if (conversation.isResponding) {
      const stopResult = await conversation.stopResponse();
      if (!stopResult.ok && stopResult.error !== "当前没有正在输出的 agent。") {
        setComposerNotice(stopResult.error ?? "停止失败");
        return false;
      }
    }
    const result = await conversation.exitPlanMode();
    if (!result.ok) {
      setComposerNotice(result.error ?? "退出计划模式失败");
      return false;
    }

    return true;
  }

  async function handleEnterPlanMode() {
    setComposerNotice(null);
    if (conversation.isResponding) {
      const stopResult = await conversation.stopResponse();
      if (!stopResult.ok && stopResult.error !== "当前没有正在输出的 agent。") {
        setComposerNotice(stopResult.error ?? "停止失败");
        return false;
      }
    }
    const result = await conversation.enterPlanMode();
    if (!result.ok) {
      setComposerNotice(result.error ?? "进入计划模式失败");
      return false;
    }

    return true;
  }

  async function handleSelectMode(mode: "bypassPermissions" | "auto" | "plan") {
    setModeDropdownOpen(false);

    if (mode === "plan") {
      if (conversation.planMode.active) {
        return;
      }

      await handleEnterPlanMode();
      return;
    }

    if (conversation.planMode.active) {
      const exited = await handleExitPlanMode();
      if (!exited) {
        return;
      }
    }

    setComposerNotice(null);
    const result = await runtimeSettings.save({
      sandboxProfile: "full-access",
      autoApproveToolRequests: mode === "bypassPermissions",
    });

    if (!result.ok) {
      setComposerNotice(result.error ?? "保存权限模式失败");
    }
  }

  function togglePlanExpansion(messageId: string) {
    setExpandedPlanMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  async function handleCopyMessage(messageId: string, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 1800);
    } catch {
      // silent fail
    }
  }

  async function handleComposerFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    await uploadComposerFiles(files);
    input.value = "";
  }

  async function uploadComposerFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    setComposerNotice(null);
    const uploaded: Attachment[] = [];

    for (const file of files) {
      const result = await conversation.uploadAttachment(file);
      if (!result.ok) {
        setComposerNotice(result.error ?? "上传失败");
        continue;
      }

      if (result.attachment) {
        uploaded.push(result.attachment);
      }
    }

    if (uploaded.length > 0) {
      setQueuedAttachments((current) => mergeAttachments(current, uploaded));
    }
  }

  async function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageFiles = items
      .filter((item) => item.kind === "file" && isImageMimeType(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    await uploadComposerFiles(imageFiles);
  }

  async function openComposerFilePicker() {
    if (conversation.pendingUpload || conversation.pending) {
      return;
    }

    composerAddFileButtonRef.current?.blur();
    if (desktopBridge.mode !== "electron") {
      composerFileInputRef.current?.click();
      return;
    }

    setComposerNotice(null);
    const selection = await desktopBridge.openFileOrFolder();
    if (selection.canceled || selection.entries.length === 0) {
      return;
    }

    const uploaded: Attachment[] = [];
    for (const entry of selection.entries) {
      const result = entry.kind === "file"
        ? await conversation.uploadPreparedAttachment({
            fileName: entry.name,
            mimeType: entry.mimeType,
            contentBase64: entry.contentBase64,
          })
        : await conversation.uploadPreparedFolder({
            folderName: entry.name,
            files: entry.files.map((file) => ({
              relativePath: file.relativePath,
              mimeType: file.mimeType,
              contentBase64: file.contentBase64,
            })),
          });

      if (!result.ok) {
        setComposerNotice(result.error ?? `${entry.kind === "file" ? "文件" : "文件夹"}上传失败`);
        continue;
      }

      if (result.attachment) {
        uploaded.push(result.attachment);
      }
    }

    if (uploaded.length > 0) {
      setQueuedAttachments((current) => mergeAttachments(current, uploaded));
    }
  }

  const composerPrimaryActionLabel = conversation.isAwaitingToolApproval
    ? activeDeleteApproval
      ? composerHasText
        ? "回复删除确认"
        : "等待删除回复"
      : conversation.stoppingResponse
        ? "正在停止等待中的命令审批"
        : "等待命令确认，点击可停止"
    : conversation.isAwaitingUserQuestion && activeQuestionPrompt?.multiSelect
      ? composerHasStructuredSelection || composerHasText
        ? "发送回答"
        : "选择或输入回答"
    : conversation.pending
      ? "发送消息"
    : conversation.isResponding
      ? conversation.stoppingResponse
        ? "正在停止输出"
        : "停止输出"
      : "发送消息";
  const composerPrimaryActionDisabled = isComposerBusy
    ? conversation.stoppingResponse
    : conversation.pending || !composerHasSendableContent;
  const approvalCard = activeToolApproval ? (
    <div className="approval-card">
      <div className="approval-card__body">
        <div className="approval-card__head">
          <span className="approval-card__title">{activeToolApproval.title}</span>
        </div>
        <div className="approval-card__command-wrap">
          <pre className="approval-card__command"><code>{activeToolApproval.toolName === "bash" ? <><span className="approval-card__prompt">$</span> {activeToolApproval.commandLine}</> : activeToolApproval.commandLine}</code></pre>
          <span className="approval-card__cwd">{activeToolApproval.cwd}</span>
        </div>
        <div className="approval-card__detail">{activeToolApproval.detail}</div>
        <div className="approval-card__actions">
          <button
            type="button"
            className="approval-card__btn approval-card__btn--reject"
            onClick={() => void resolveToolApproval("reject", "deny_once")}
            disabled={conversation.resolvingToolApprovalId === activeToolApproval.id}
          >
            拒绝一次
          </button>
          <button
            type="button"
            className="approval-card__btn approval-card__btn--reject"
            onClick={() => void resolveToolApproval("reject", "deny_always")}
            disabled={conversation.resolvingToolApprovalId === activeToolApproval.id}
          >
            总是拒绝
          </button>
          <button
            type="button"
            className="approval-card__btn approval-card__btn--approve"
            onClick={() => void resolveToolApproval("approve", "allow_once")}
            disabled={conversation.resolvingToolApprovalId === activeToolApproval.id}
          >
            允许一次
          </button>
          <button
            type="button"
            className="approval-card__btn approval-card__btn--approve"
            onClick={() => void resolveToolApproval("approve", "allow_always")}
            disabled={conversation.resolvingToolApprovalId === activeToolApproval.id}
          >
            {conversation.resolvingToolApprovalId === activeToolApproval.id ? "处理中…" : "总是允许"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <div
        style={shellStyle}
        className={[
          "shell",
          isSidebarCollapsed ? "shell--sidebar-collapsed" : "",
          isSidebarResizing ? "shell--sidebar-resizing" : "",
          sidebarMotion ? `shell--sidebar-${sidebarMotion}` : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <aside className={`shell__sidebar${isSidebarCollapsed ? " shell__sidebar--collapsed" : ""}`}>
          <header className="sidebar__header">
            <WindowControls
              sidebarToggle={{
                label: "收起侧边栏",
                onClick: toggleSidebar,
              }}
              showThreadSearch
            />
          </header>

          <section className="sidebar__threads">
            <button className="sidebar__thread-button sidebar__new-chat" type="button" onClick={createThread}>
              {isSidebarCollapsed ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  {" "}New Chat
                </>
              )}
            </button>

            {!isSidebarCollapsed ? (
              <div className="sidebar__thread-groups">
                {threadGroups.map((group) => (
                  <section key={group.key} className="sidebar__thread-section">
                    <div className="sidebar__thread-section-label">{group.label}</div>
                    <div className="sidebar__thread-list">
                      {group.threads.map((thread) => (
                        <button
                          key={thread.id}
                          type="button"
                          className={`sidebar__thread-item${
                            thread.id === conversation.sessionId ? " sidebar__thread-item--active" : ""
                          }`}
                          onClick={() => {
                            setThreadNotice(null);
                            setQueuedAttachments([]);
                            conversation.selectSession(thread.id);
                          }}
                          >
                          <div className="sidebar__thread-row">
                            <span className="sidebar__thread-title">
                              {thread.title}
                              {thread.planMode?.active ? <span className="sidebar__thread-plan-marker">计划中</span> : null}
                            </span>
                            <span className="sidebar__thread-id">{formatThreadId(thread.id)}</span>
                          </div>
                          <div className="sidebar__thread-preview">
                            {thread.latestMessagePreview ?? "还没有消息，先开始一段新对话。"}
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : null}

            {threadNotice && !isSidebarCollapsed ? <div className="sidebar__thread-notice">{threadNotice}</div> : null}
          </section>

          <footer className="sidebar__footer">
            <button
              type="button"
              className="sidebar__settings-btn"
              onClick={() => void desktopBridge.openSettings()}
              aria-label="设置"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </footer>

          <div
            className="shell__sidebar-resize-handle"
            role="presentation"
            aria-hidden="true"
            onPointerDown={handleSidebarResizeStart}
          />
        </aside>

        <main className="shell__main" style={shellMainStyle}>
          <header className="main__header">
            <div className="main__header-left">
              {isSidebarCollapsed ? (
                <WindowControls
                  sidebarToggle={{
                    label: "展开侧边栏",
                    onClick: toggleSidebar,
                  }}
                  showThreadSearch
                />
              ) : null}
              <div className="main__title">
                <strong>{conversation.sessionTitle}</strong>
                <span>·</span>
                <span>{conversation.messages.length} 条消息</span>
              </div>
            </div>
            <div className="main__header-actions" />
          </header>

          <section ref={messagesViewportRef} className="workspace">
            <div className={`workspace__thread${activeToolApproval ? " workspace__thread--approval-active" : ""}`}>
              <div ref={messagesContentRef} className="workspace__messages">
                {timelineBlocks.map((entry) => {
                  if (entry.kind === "assistant-turn") {
                    return (
                      <section
                        key={getAssistantTurnRenderKey(conversation.sessionId, entry)}
                        className="workspace__assistant-turn"
                      >
                        <TurnMetaBadge tools={entry.turnMeta.tools} skills={entry.turnMeta.skills} />
                        {entry.items.map((item, itemIndex) => {
                          if (item.kind === "tool") {
                            return <ToolWorkflowCard key={`tool-${item.tool.toolCallId}`} entry={item.tool} />;
                          }

                          const message = item.message;
                          const assistantSources = message.role === "assistant" && item.sourceLinks.length > 0 ? item.sourceLinks : null;
                          const planMeta = message.role === "assistant" ? (planMetaByMessageId.get(message.id) ?? null) : null;
                          const isPlanExpanded = planMeta ? expandedPlanMessageIds.has(message.id) : false;

                          return (
                            <article
                              key={`${message.id}::${itemIndex}`}
                              className={`workspace__message workspace__message--${message.role}${message.attachments.length > 0 ? " workspace__message--has-attachments" : ""}${planMeta ? " workspace__message--plan" : ""}`}
                            >
                              <div className={`workspace__message-body${planMeta ? " workspace__message-body--plan" : ""}`}>
                                {planMeta ? (
                                  <div className="workspace__plan-card-head">
                                    <div className="workspace__plan-card-copy">
                                      <span className="workspace__plan-card-eyebrow">
                                        {planMeta.planId ? `计划草案 · #${planMeta.planId.slice(0, 8)}` : "计划草案"}
                                      </span>
                                      <strong className="workspace__plan-card-title">{planMeta.title}</strong>
                                    </div>
                                    <div className="workspace__plan-card-meta">
                                      {planMeta.isExpandable ? (
                                        <button
                                          type="button"
                                          className="workspace__plan-chip workspace__plan-chip--icon"
                                          onClick={() => togglePlanExpansion(message.id)}
                                          aria-label={isPlanExpanded ? "收起计划" : "展开计划"}
                                        >
                                          <ChevronToggleIcon expanded={isPlanExpanded} />
                                        </button>
                                      ) : null}
                                      <button
                                        type="button"
                                        className={`workspace__plan-chip workspace__plan-chip--copy${copiedMessageId === message.id ? " workspace__plan-chip--copied" : ""}`}
                                        onClick={() => void handleCopyMessage(message.id, planMeta.bodyContent)}
                                        aria-label="复制计划"
                                      >
                                        {copiedMessageId === message.id ? "已复制" : "复制"}
                                      </button>
                                    </div>
                                  </div>
                                ) : null}
                                <div className={planMeta ? `workspace__plan-card-content${planMeta.isExpandable && !isPlanExpanded ? " workspace__plan-card-content--collapsed" : ""}` : undefined}>
                                  <MessageContent
                                    content={planMeta ? (isPlanExpanded ? planMeta.bodyContent : planMeta.previewContent) : message.content}
                                    renderMarkdown={message.role === "assistant" || message.role === "system"}
                                  />
                                </div>
                              </div>
                              {message.attachments.length > 0 ? (
                                <>
                                  {message.attachments.some((attachment) => isImageMimeType(attachment.mimeType)) ? (
                                    <div className="workspace__message-images">
                                      {message.attachments
                                        .filter((attachment) => isImageMimeType(attachment.mimeType))
                                        .map((attachment) => {
                                          const imageUrl = getAttachmentContentUrl(conversation.daemonBaseUrl, conversation.sessionId, attachment);
                                          if (!imageUrl) {
                                            return null;
                                          }

                                          return (
                                            <button
                                              key={attachment.id}
                                              type="button"
                                              className="workspace__message-image-button"
                                              onClick={() => setPreviewImage({ src: imageUrl, alt: attachment.fileName })}
                                              aria-label={`查看大图：${attachment.fileName}`}
                                            >
                                              <img
                                                className="workspace__message-image"
                                                src={imageUrl}
                                                alt={attachment.fileName}
                                                loading="lazy"
                                              />
                                            </button>
                                          );
                                        })}
                                    </div>
                                  ) : null}
                                  {message.attachments.some((attachment) => !isImageMimeType(attachment.mimeType)) ? (
                                    <div className="workspace__message-attachments">
                                      {message.attachments
                                        .filter((attachment) => !isImageMimeType(attachment.mimeType))
                                        .map((attachment) => (
                                          <span key={attachment.id} className="workspace__attachment-chip">
                                            {attachment.fileName}
                                          </span>
                                        ))}
                                    </div>
                                  ) : null}
                                </>
                              ) : null}
                              {planMeta ? null : (
                                <button
                                  type="button"
                                  className={`workspace__message-copy${copiedMessageId === message.id ? " workspace__message-copy--copied" : ""}`}
                                  onClick={() => void handleCopyMessage(message.id, message.content)}
                                  aria-label="复制"
                                >
                                  {copiedMessageId === message.id ? (
                                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                      <path d="M2 7l3.5 3.5L12 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  ) : (
                                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                      <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                                      <path d="M3.5 9.5H3a1.5 1.5 0 01-1.5-1.5V3a1.5 1.5 0 011.5-1.5h5a1.5 1.5 0 011.5 1.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                                    </svg>
                                  )}
                                </button>
                              )}
                              {assistantSources ? (
                                <SourceLinksSection
                                  links={assistantSources}
                                  detailsClassName="workspace__message-sources"
                                  summaryClassName="tool-workflow-card__sources-summary workspace__message-sources-summary"
                                  listClassName="tool-workflow-card__sources-list workspace__message-sources-list"
                                  linkClassName="tool-workflow-card__source-link workspace__message-source-link"
                                />
                              ) : null}
                            </article>
                          );
                        })}
                      </section>
                    );
                  }

                  if (entry.kind === "tool-group") {
                    return (
                      <section
                        key={`tool-group-${entry.groupKey}-${entry.tools[0]?.toolCallId ?? "empty"}`}
                        className="workspace__tool-group"
                        aria-label={entry.groupLabel}
                      >
                        <div className="workspace__tool-group-header">
                          <strong className="workspace__tool-group-title">{entry.groupLabel}</strong>
                          <span className="workspace__tool-group-count">{entry.tools.length} 步</span>
                        </div>
                        <div className="workspace__tool-group-items">
                          {entry.tools.map((tool) => (
                            <ToolWorkflowCard key={`tool-${tool.toolCallId}`} entry={tool} />
                          ))}
                        </div>
                      </section>
                    );
                  }

                  if (entry.kind === "task-notification") {
                    const notification = entry.notification;
                    const modeLabel = notification.mode === "fork" ? "分叉代理" : "子代理";
                    const statusLabel = notification.status === "completed" ? "已完成" : "已失败";
                    return (
                      <article
                        key={`task-notification-${notification.id}`}
                        className="workspace__message workspace__message--assistant workspace__message--plan"
                      >
                        <div className="workspace__message-body workspace__message-body--plan">
                          <div className="workspace__plan-card-head">
                            <div className="workspace__plan-card-copy">
                              <span className="workspace__plan-card-eyebrow">后台任务通知</span>
                              <strong className="workspace__plan-card-title">{`${modeLabel}${statusLabel}`}</strong>
                            </div>
                            <div className="workspace__plan-card-meta">
                              <span className="workspace__plan-chip workspace__plan-chip--status">
                                {notification.status}
                              </span>
                              {notification.role ? (
                                <span className="workspace__plan-chip">{notification.role}</span>
                              ) : null}
                            </div>
                          </div>
                          <div className="workspace__plan-card-content">
                            <MessageContent
                              content={[
                                `任务：${notification.objective}`,
                                `结果文件：${notification.outputPath}`,
                                notification.preview ? `摘要：${notification.preview}` : null,
                                "需要完整内容时，直接用 read 读取结果文件。",
                              ].filter(Boolean).join("\n")}
                              renderMarkdown
                            />
                          </div>
                        </div>
                      </article>
                    );
                  }

                  if (entry.kind === "tool") {
                    return <ToolWorkflowCard key={`tool-${entry.tool.toolCallId}`} entry={entry.tool} />;
                  }

                  if (entry.kind === "plan-transition") {
                    const isEntering = entry.transition === "entered";
                    return (
                      <article
                        key={`plan-transition-${entry.transition}-${entry.planMode.updatedAt ?? entry.planMode.enteredAt ?? entry.taskId ?? "current"}`}
                        className="workspace__message workspace__message--assistant workspace__message--plan"
                      >
                        <div className="workspace__message-body workspace__message-body--plan">
                          <div className="workspace__plan-card-head">
                            <div className="workspace__plan-card-copy">
                              <span className="workspace__plan-card-eyebrow">
                                {isEntering ? "已进入计划模式" : "已退出计划模式"}
                              </span>
                              <strong className="workspace__plan-card-title">
                                {isEntering ? "继续只做规划" : "开始执行计划"}
                              </strong>
                            </div>
                            <div className="workspace__plan-card-meta">
                              <span className="workspace__plan-chip workspace__plan-chip--status">
                                {isEntering ? "仅更新草案" : "回到执行流"}
                              </span>
                              {entry.planMode.activePlanId ? (
                                <span className="workspace__plan-chip">
                                  {`#${entry.planMode.activePlanId.slice(0, 8)}`}
                                </span>
                              ) : null}
                              {!isEntering && entry.taskId ? (
                                <span className="workspace__plan-chip">任务已同步</span>
                              ) : null}
                            </div>
                          </div>
                          <div className="workspace__plan-card-content">
                            <MessageContent
                              content={isEntering
                                ? "计划模式已经打开，接下来只更新计划草案和说明，不进入写入执行。"
                                : "计划模式已经退出，当前计划已转为执行计划。接下来会按这份计划进入实现。"}
                              renderMarkdown
                            />
                          </div>
                        </div>
                      </article>
                    );
                  }

                  if (entry.kind === "active-plan") {
                    return (
                      <article
                        key={`plan-artifact-${entry.planMeta.planId ?? "draft"}`}
                        className="workspace__message workspace__message--assistant workspace__message--plan"
                      >
                        <div className="workspace__message-body workspace__message-body--plan">
                          <div className="workspace__plan-card-head">
                            <div className="workspace__plan-card-copy">
                              <span className="workspace__plan-card-eyebrow">
                                {(conversation.planMode.active ? "当前计划" : "执行计划")
                                  + (entry.planMeta.planId ? ` · #${entry.planMeta.planId.slice(0, 8)}` : "")}
                              </span>
                              <strong className="workspace__plan-card-title">{entry.planMeta.title}</strong>
                            </div>
                            <div className="workspace__plan-card-meta">
                              {entry.planMeta.isExpandable ? (
                                <button
                                  type="button"
                                  className="workspace__plan-chip workspace__plan-chip--icon"
                                  onClick={() => setIsActivePlanExpanded((current) => !current)}
                                  aria-label={isActivePlanExpanded ? "收起计划" : "展开计划"}
                                >
                                  <ChevronToggleIcon expanded={isActivePlanExpanded} />
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className={`workspace__plan-chip workspace__plan-chip--copy${copiedMessageId === entry.planMeta.planId ? " workspace__plan-chip--copied" : ""}`}
                                onClick={() => void handleCopyMessage(entry.planMeta.planId ?? "active-plan", entry.planMeta.bodyContent)}
                                aria-label="复制计划"
                              >
                                {copiedMessageId === entry.planMeta.planId ? "已复制" : "复制"}
                              </button>
                            </div>
                          </div>
                          <div className={`workspace__plan-card-content${entry.planMeta.isExpandable && !isActivePlanExpanded ? " workspace__plan-card-content--collapsed" : ""}`}>
                            <MessageContent
                              content={isActivePlanExpanded ? entry.planMeta.bodyContent : entry.planMeta.previewContent}
                              renderMarkdown
                            />
                          </div>
                        </div>
                      </article>
                    );
                  }

                  if (entry.kind === "approval") {
                    const approval = entry.approval;
                    return (
                      <div key={`approval-${approval.id}`} className="approval-resolved">
                        <span className="approval-resolved__tool">{approval.title}</span>
                        <span className="approval-resolved__command">{approval.commandLine}</span>
                        <span className={`approval-resolved__status approval-resolved__status--${approval.status}`}>
                          {formatResolvedApprovalStatus(approval)}
                        </span>
                        <span className="approval-resolved__time">{formatApprovalTime(approval.resolvedAt)}</span>
                      </div>
                    );
                  }

                  const message = entry.message;
                  const planMeta = message.role === "assistant" ? (planMetaByMessageId.get(message.id) ?? null) : null;
                  const isPlanExpanded = planMeta ? expandedPlanMessageIds.has(message.id) : false;

                  return (
                    <article
                      key={message.id}
                      className={`workspace__message workspace__message--${message.role}${message.attachments.length > 0 ? " workspace__message--has-attachments" : ""}${planMeta ? " workspace__message--plan" : ""}`}
                    >
                      <div className={`workspace__message-body${planMeta ? " workspace__message-body--plan" : ""}`}>
                        {planMeta ? (
                          <div className="workspace__plan-card-head">
                            <div className="workspace__plan-card-copy">
                              <span className="workspace__plan-card-eyebrow">
                                {planMeta.planId ? `计划草案 · #${planMeta.planId.slice(0, 8)}` : "计划草案"}
                              </span>
                              <strong className="workspace__plan-card-title">{planMeta.title}</strong>
                            </div>
                            <div className="workspace__plan-card-meta">
                              {planMeta.isExpandable ? (
                                <button
                                  type="button"
                                  className="workspace__plan-chip workspace__plan-chip--icon"
                                  onClick={() => togglePlanExpansion(message.id)}
                                  aria-label={isPlanExpanded ? "收起计划" : "展开计划"}
                                >
                                  <ChevronToggleIcon expanded={isPlanExpanded} />
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className={`workspace__plan-chip workspace__plan-chip--copy${copiedMessageId === message.id ? " workspace__plan-chip--copied" : ""}`}
                                onClick={() => void handleCopyMessage(message.id, planMeta.bodyContent)}
                                aria-label="复制计划"
                              >
                                {copiedMessageId === message.id ? "已复制" : "复制"}
                              </button>
                            </div>
                          </div>
                        ) : null}
                        <div className={planMeta ? `workspace__plan-card-content${planMeta.isExpandable && !isPlanExpanded ? " workspace__plan-card-content--collapsed" : ""}` : undefined}>
                          <MessageContent
                            content={planMeta ? (isPlanExpanded ? planMeta.bodyContent : planMeta.previewContent) : message.content}
                            renderMarkdown={message.role === "assistant" || message.role === "system"}
                          />
                        </div>
                      </div>
                      {message.attachments.length > 0 ? (
                        <>
                          {message.attachments.some((attachment) => isImageMimeType(attachment.mimeType)) ? (
                            <div className="workspace__message-images">
                              {message.attachments
                                .filter((attachment) => isImageMimeType(attachment.mimeType))
                                .map((attachment) => {
                                  const imageUrl = getAttachmentContentUrl(conversation.daemonBaseUrl, conversation.sessionId, attachment);
                                  if (!imageUrl) {
                                    return null;
                                  }

                                  return (
                                    <button
                                      key={attachment.id}
                                      type="button"
                                      className="workspace__message-image-button"
                                      onClick={() => setPreviewImage({ src: imageUrl, alt: attachment.fileName })}
                                      aria-label={`查看大图：${attachment.fileName}`}
                                    >
                                      <img
                                        className="workspace__message-image"
                                        src={imageUrl}
                                        alt={attachment.fileName}
                                        loading="lazy"
                                      />
                                    </button>
                                  );
                                })}
                            </div>
                          ) : null}
                          {message.attachments.some((attachment) => !isImageMimeType(attachment.mimeType)) ? (
                            <div className="workspace__message-attachments">
                              {message.attachments
                                .filter((attachment) => !isImageMimeType(attachment.mimeType))
                                .map((attachment) => (
                                  <span key={attachment.id} className="workspace__attachment-chip">
                                    {attachment.fileName}
                                  </span>
                                ))}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                      {planMeta ? null : (
                        <button
                          type="button"
                          className={`workspace__message-copy${copiedMessageId === message.id ? " workspace__message-copy--copied" : ""}`}
                          onClick={() => void handleCopyMessage(message.id, message.content)}
                          aria-label="复制"
                        >
                          {copiedMessageId === message.id ? (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                              <path d="M2 7l3.5 3.5L12 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                              <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                              <path d="M3.5 9.5H3a1.5 1.5 0 01-1.5-1.5V3a1.5 1.5 0 011.5-1.5h5a1.5 1.5 0 011.5 1.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                            </svg>
                          )}
                        </button>
                      )}
                    </article>
                  );
                })}

                {conversation.isResponding && (
                  <ThinkingIndicator
                    thinkingSteps={conversation.thinkingSteps}
                    currentToolName={conversation.currentToolName}
                  />
                )}

                <div ref={messagesEndRef} className="workspace__end-anchor" aria-hidden="true" />
              </div>
            </div>
          </section>

          {approvalCard ? (
            <div ref={approvalDockRef} className="composer__approval-dock" role="region" aria-label="命令审批">
              {approvalCard}
              {approvalAttachments.length > 0 ? (
                <div className="composer__attachment-queue" style={{ marginTop: 8 }}>
                  {approvalAttachments.map((attachment) => (
                    <div key={attachment.id} className="composer__attachment-pill">
                      <div className="composer__attachment-copy">
                        <strong>{attachment.fileName}</strong>
                        <span>{formatBytes(attachment.byteSize)}</span>
                      </div>
                      <button
                        type="button"
                        className="composer__attachment-remove"
                        aria-label={`移除 ${attachment.fileName}`}
                        onClick={() => {
                          setApprovalAttachments((current) => current.filter((item) => item.id !== attachment.id));
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <form ref={composerRef} className="composer" onSubmit={submitComposer}>
            {!isAtBottom ? (
              <button
                type="button"
                className="composer__jump-to-bottom"
                onClick={handleScrollToBottom}
                aria-label="回到底部"
                title="回到底部"
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 5.5v11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="m7.5 12.5 4.5 4.5 4.5-4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : null}
            {queuedAttachments.length > 0 ? (
              <div className="composer__attachment-queue">
                {queuedAttachments.map((attachment) => (
                  <div key={attachment.id} className="composer__attachment-pill">
                    <div className="composer__attachment-copy">
                      <strong>{attachment.fileName}</strong>
                      <span>{formatBytes(attachment.byteSize)}</span>
                    </div>
                    <button
                      type="button"
                      className="composer__attachment-remove"
                      aria-label={`移除 ${attachment.fileName}`}
                      onClick={() => {
                        setQueuedAttachments((current) => current.filter((item) => item.id !== attachment.id));
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {activeQuestionPrompt ? (
              <div className="composer__question-card" role="group" aria-label={activeQuestionPrompt.header}>
                <div className="composer__question-copy">
                  <span className="composer__question-header">{activeQuestionPrompt.header}</span>
                  <div className="composer__question-text">{activeQuestionPrompt.question}</div>
                </div>
                <div className="composer__quick-replies" role="list" aria-label={activeQuestionPrompt.question}>
                  {activeQuestionPrompt.options.map((option) => {
                    const selected = selectedQuestionOptions.includes(option.label);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        className={`composer__quick-reply${selected ? " composer__quick-reply--selected" : ""}`}
                        onClick={() => { void handleQuestionOptionClick(option.label); }}
                        disabled={conversation.pending || conversation.pendingUpload || conversation.isAwaitingToolApproval}
                        title={option.description ?? option.label}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                {activeQuestionPrompt.multiSelect ? (
                  <div className="composer__question-hint">
                    <span>可多选，也可以直接输入自己的答案。</span>
                    {selectedQuestionOptions.length > 0 ? (
                      <button
                        type="button"
                        className="composer__question-submit"
                        onClick={() => { void submitComposerDraft(); }}
                        disabled={conversation.pending || conversation.pendingUpload}
                      >
                        发送已选 {selectedQuestionOptions.length}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="composer__question-hint">也可以忽略选项，直接输入自己的答案。</div>
                )}
              </div>
            ) : null}
            {composerQuickReplies.length > 0 ? (
              <div className="composer__quick-replies" role="list" aria-label="建议回复">
                {composerQuickReplies.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="composer__quick-reply"
                    onClick={() => { void handleQuickReply(option); }}
                    disabled={conversation.pending || conversation.pendingUpload || isComposerBusy}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              className="composer__input composer__input--field"
              value={composerDraft}
              onChange={(event) => setComposerDraft(event.target.value)}
              onPaste={(event) => { void handleComposerPaste(event); }}
              onKeyDown={handleComposerKeyDown}
              placeholder="输入消息，或直接粘贴图片..."
              disabled={conversation.pending || conversation.pendingUpload}
            />
            <div className="composer__toolbar">
              <div className="composer__add-file">
                <button
                  ref={composerAddFileButtonRef}
                  type="button"
                  className="composer__add-file-button"
                  aria-label={conversation.pendingUpload ? "上传中" : "添加文件等"}
                  onClick={() => { void openComposerFilePicker(); }}
                  disabled={conversation.pendingUpload || conversation.pending}
                >
                  <span className="composer__add-file-button-icon" aria-hidden="true">+</span>
                </button>
                <span className="composer__add-file-tooltip">
                  {conversation.pendingUpload ? "上传中..." : "打开文件或文件夹"}
                </span>
                <input
                  ref={composerFileInputRef}
                  className="composer__file-input"
                  type="file"
                  multiple
                  onChange={handleComposerFileChange}
                  disabled={conversation.pendingUpload || conversation.pending}
                />
              </div>

              <div className="composer__dropdown-wrapper">
                <button
                  type="button"
                  className="composer__toolbar-btn"
                  onClick={() => { setModelDropdownOpen((v) => !v); setReasoningDropdownOpen(false); setModeDropdownOpen(false); }}
                >
                  <span className="composer__toolbar-btn-icon">⚡</span>
                  <span>{enabledProvider ? enabledProvider.label : "模型"}</span>
                  <span className="composer__toolbar-btn-caret">▾</span>
                </button>
                {modelDropdownOpen ? (
                  <div className="composer__dropdown">
                    {(configuredProviders.length > 0 ? configuredProviders : providers.filter((provider) => provider.enabled)).length > 0 ? (
                      (configuredProviders.length > 0 ? configuredProviders : providers.filter((provider) => provider.enabled)).map((provider) => (
                        <button
                          key={provider.id}
                          type="button"
                          className={`composer__dropdown-item${provider.enabled ? " composer__dropdown-item--active" : ""}`}
                          onClick={() => {
                            void providerState.save({ providerId: provider.id, baseUrl: provider.baseUrl, model: provider.model, enabled: true });
                            providers.filter((p) => p.id !== provider.id && p.enabled).forEach((p) => {
                              void providerState.save({ providerId: p.id, baseUrl: p.baseUrl, model: p.model, enabled: false });
                            });
                            setModelDropdownOpen(false);
                          }}
                        >
                          {provider.label} · {provider.model}
                        </button>
                      ))
                    ) : (
                      <div className="composer__dropdown-item composer__dropdown-item--empty">
                        先去设置里配置 Chat API
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              <div className="composer__dropdown-wrapper">
                <button
                  type="button"
                  className="composer__toolbar-btn"
                  onClick={() => { setReasoningDropdownOpen((v) => !v); setModelDropdownOpen(false); setModeDropdownOpen(false); }}
                >
                  <span>{`推理 · ${formatReasoningEffortLabel(runtimeSettings.settings.reasoningEffort)}`}</span>
                  <span className="composer__toolbar-btn-caret">▾</span>
                </button>
                {reasoningDropdownOpen ? (
                  <div className="composer__dropdown composer__reasoning-dropdown">
                    {reasoningEffortDefinitions.map((definition) => (
                      <button
                        key={definition.id}
                        type="button"
                        className={`composer__reasoning-option${runtimeSettings.settings.reasoningEffort === definition.id ? " composer__reasoning-option--active" : ""}`}
                        onClick={() => {
                          void runtimeSettings.save({ reasoningEffort: definition.id });
                          setReasoningDropdownOpen(false);
                        }}
                      >
                        <span className="composer__reasoning-option-main">
                          <ReasoningEffortIcon />
                          <strong className="composer__reasoning-option-title">{definition.label}</strong>
                        </span>
                        {runtimeSettings.settings.reasoningEffort === definition.id ? (
                          <span className="composer__reasoning-option-check" aria-hidden="true">✓</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {conversation.planModeAvailable ? (
                <div className="composer__dropdown-wrapper">
                  <button
                    type="button"
                    className={currentModeButtonClassName}
                    onClick={() => {
                      setModeDropdownOpen((value) => !value);
                      setModelDropdownOpen(false);
                      setReasoningDropdownOpen(false);
                    }}
                    disabled={modeSwitchDisabled}
                    aria-label={`切换到${currentModeLabel}`}
                    title={`切换到${currentModeLabel}`}
                  >
                    <ModeIcon mode={currentModeIcon} />
                    <span>{currentModeLabel}</span>
                  </button>
                  {modeDropdownOpen ? (
                    <div className="composer__dropdown">
                      <button
                        type="button"
                        className={`composer__dropdown-item${!conversation.planMode.active && runtimeSettings.settings.autoApproveToolRequests ? " composer__dropdown-item--active" : ""}`}
                        onClick={() => {
                          void handleSelectMode("bypassPermissions");
                        }}
                      >
                        <span className="composer__dropdown-item-main">
                          <ModeIcon mode="bypassPermissions" />
                          <span>完全访问</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`composer__dropdown-item${!conversation.planMode.active && !runtimeSettings.settings.autoApproveToolRequests ? " composer__dropdown-item--active" : ""}`}
                        onClick={() => {
                          void handleSelectMode("auto");
                        }}
                      >
                        <span className="composer__dropdown-item-main">
                          <ModeIcon mode="auto" />
                          <span>auto模式</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`composer__dropdown-item${conversation.planMode.active ? " composer__dropdown-item--active" : ""}`}
                        onClick={() => {
                          void handleSelectMode("plan");
                        }}
                      >
                        <span className="composer__dropdown-item-main">
                          <ModeIcon mode="plan" />
                          <span>计划模式</span>
                        </span>
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {conversation.isAwaitingToolApproval ? (
                <span className="composer__status-chip">{activeDeleteApproval ? "等待删除回复" : "等待命令确认"}</span>
              ) : conversation.isAwaitingUserQuestion ? (
                <span className="composer__status-chip">等待你的选择</span>
              ) : null}

              <span className="composer__spacer" />
              <button
                type="submit"
                className={`composer__send${conversation.isAwaitingToolApproval && !activeDeleteApproval ? " composer__send--waiting" : conversation.isResponding ? " composer__send--stop" : ""}`}
                disabled={composerPrimaryActionDisabled}
                aria-label={composerPrimaryActionLabel}
                title={composerPrimaryActionLabel}
              >
                {conversation.isResponding || (conversation.isAwaitingToolApproval && !activeDeleteApproval) ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="7.5" y="7.5" width="9" height="9" rx="2.4" fill="currentColor" stroke="none" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 12.2 18.1 5.6 14.4 18.4 11.3 13.6 5 12.2Z" fill="currentColor" stroke="none" />
                  </svg>
                )}
              </button>
            </div>

            {composerNotice ? <div className="status-banner">{composerNotice}</div> : null}
            {conversation.error ? <div className="status-banner">会话流回退到预览数据。 {conversation.error}</div> : null}
          </form>

          {state.status === "error" ? (
            <div className="status-banner">
              Daemon 未连接，当前使用预览数据。
              {" "}
              {state.error}
            </div>
          ) : null}
        </main>
      </div>

      {isSettingsOpen ? (
        <div className="settings-overlay" onClick={() => setIsSettingsOpen(false)}>
          <section className="settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-content">
              <header className="settings-content__header" style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                <WindowControls onClose={() => setIsSettingsOpen(false)} />
                <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>全局设置</h2>
              </header>

              <div className="settings-content__body">
                <h3 className="settings-section-title">模型提供商</h3>
                <div className="settings-providers">
                  <div className="provider-notice">
                    Kimi、DeepSeek、GLM、MiniMax 这类官方接口都能直接在这里配置。
                    {" "}
                    OpenAI、AIHubMix、OpenRouter 这些入口也能拿来接第三方中转站，只要填兼容的 Base URL 即可。
                    {" "}
                    ACP provider 目前还没有接进 Aliceloop runtime，这一块现在不是漏 UI，而是底层还没实现。
                  </div>
                  {providerState.error ? <div className="provider-notice provider-notice--error">{providerState.error}</div> : null}
                  <div className="settings-providers__body">
                    <div className="provider-list">
                      {providers.map((provider) => (
                        <button
                          key={provider.id}
                          type="button"
                          className={`provider-list__item${provider.id === activeProvider?.id ? " provider-list__item--active" : ""}`}
                          onClick={() => {
                            setActiveProviderId(provider.id);
                            setProviderNotice(null);
                          }}
                        >
                          <div className="provider-list__identity">
                            <span className="provider-list__logo" aria-hidden="true">
                              {providerMonograms[provider.id] ?? provider.label.slice(0, 2).toUpperCase()}
                            </span>
                            <div>
                              <div className="provider-list__name">{provider.label}</div>
                              <div className="provider-list__subtitle">{formatProviderTransportLabel(provider.transport)}</div>
                            </div>
                          </div>
                          <span className={`provider-list__status${provider.enabled ? " provider-list__status--active" : ""}`} />
                        </button>
                      ))}
                    </div>

                    {activeProvider ? (
                      <div className="provider-detail">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "18px" }}>
                          <div style={{ display: "grid", gap: "8px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                              <div className="provider-detail__icon" aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>
                                {providerMonograms[activeProvider.id] ?? activeProvider.label.slice(0, 2).toUpperCase()}
                              </div>
                              <div>
                                <h3 style={{ margin: 0 }}>{activeProvider.label}</h3>
                                <p style={{ margin: "6px 0 0" }}>{providerDescriptions[activeProvider.id] ?? "支持自定义 Base URL、模型和 API Key。"} </p>
                              </div>
                            </div>
                            <div className="provider-field">
                              <label>当前协议</label>
                              <div className="provider-field__box provider-field__box--input">{formatProviderTransportLabel(activeProvider.transport)}</div>
                            </div>
                          </div>

                          <button
                            type="button"
                            className={`provider-detail__toggle${providerEnabled ? " provider-detail__toggle--on" : ""}`}
                            aria-label={providerEnabled ? "停用当前 provider" : "启用当前 provider"}
                            title={providerEnabled ? "停用当前 provider" : "启用当前 provider"}
                            onClick={() => setProviderEnabled((current) => !current)}
                          />
                        </div>

                        <div className="provider-notice">
                          API Key 留空表示继续沿用已保存的 key，不会把旧 key 清掉。
                          {" "}
                          如果你用的是第三方中转站，通常只需要把 Base URL 改成中转地址，模型名填它支持的名字。
                        </div>
                        {providerNotice ? <div className="provider-notice">{providerNotice}</div> : null}

                        <div className="provider-field">
                          <label>API Key</label>
                          <input
                            className="provider-field__input"
                            type="password"
                            value={providerApiKeyInput}
                            placeholder={activeProvider.apiKeyMasked ? `已保存：${activeProvider.apiKeyMasked}` : `输入 ${activeProvider.label} API Key`}
                            onChange={(event) => setProviderApiKeyInput(event.target.value)}
                          />
                        </div>

                        <div className="provider-field">
                          <label>Base URL</label>
                          <input
                            className="provider-field__input"
                            type="text"
                            value={providerBaseUrlInput}
                            onChange={(event) => setProviderBaseUrlInput(event.target.value)}
                          />
                        </div>

                        <div className="provider-field">
                          <label>默认模型</label>
                          <input
                            className="provider-field__input"
                            type="text"
                            value={providerModelInput}
                            onChange={(event) => setProviderModelInput(event.target.value)}
                          />
                        </div>

                        <div className="provider-actions">
                          <button
                            type="button"
                            className="settings-actions__button settings-actions__button--primary"
                            onClick={() => void saveActiveProvider()}
                            disabled={providerState.savingProviderId !== null}
                          >
                            {providerState.savingProviderId === activeProvider.id ? "保存中..." : "保存 Provider"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="provider-detail">
                        <div className="provider-notice">当前还没有可编辑的 provider。</div>
                      </div>
                    )}
                  </div>
                </div>

                <h3 className="settings-section-title">推理</h3>
                <div className="settings-panel">
                  <div className="settings-panel__heading">
                    <span>{formatReasoningEffortLabel(runtimeSettings.settings.reasoningEffort)}</span>
                  </div>
                  <div className="provider-notice">
                    这会把推理强度传给支持该参数的 OpenAI 兼容 reasoning 模型；普通模型会继续按默认方式回复。
                  </div>
                  {reasoningNotice ? <div className="provider-notice">{reasoningNotice}</div> : null}
                  {runtimeSettings.error ? <div className="provider-notice provider-notice--error">{runtimeSettings.error}</div> : null}
                  <div className="sandbox-profile-list sandbox-profile-list--compact">
                    {reasoningEffortDefinitions.map((definition) => (
                      <button
                        key={definition.id}
                        className={`sandbox-profile-card sandbox-profile-card--compact${reasoningEffortInput === definition.id ? " sandbox-profile-card--active" : ""}`}
                        onClick={() => setReasoningEffortInput(definition.id)}
                      >
                        <strong>{definition.label}</strong>
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── MCP ── */}
                <h3 className="settings-section-title">MCP 服务</h3>
                <div className="settings-panel">
                  <div className="settings-panel__heading">
                    <span>{runtimeCatalogs.mcpServers.length} 个条目 / 已安装 {installedMcpServers.length}</span>
                  </div>
                  <div className="provider-notice">
                    Aliceloop 只做 MCP client。这里的"安装"是在 Aliceloop 内登记已安装状态，真正的 MCP 服务仍由用户从应用市场自行下载和配置。
                  </div>
                  {runtimeCatalogs.error && runtimeCatalogs.status === "error" ? (
                    <div className="provider-notice provider-notice--error">{runtimeCatalogs.error}</div>
                  ) : null}
                  {mcpNotice ? <div className="provider-notice">{mcpNotice}</div> : null}
                  <div className="mcp-toggle">
                    <button
                      className={`mcp-toggle__button${mcpView === "marketplace" ? " mcp-toggle__button--active" : ""}`}
                      onClick={() => setMcpView("marketplace")}
                    >
                      应用市场
                    </button>
                    <button
                      className={`mcp-toggle__button${mcpView === "installed" ? " mcp-toggle__button--active" : ""}`}
                      onClick={() => setMcpView("installed")}
                    >
                      已安装
                    </button>
                  </div>
                  <div className="settings-panel__list">
                    {visibleMcpServers.length > 0 ? (
                      visibleMcpServers.map((server) => (
                        <div key={server.id} className="settings-panel__item">
                          <div className="mcp-card__header">
                            <div className="mcp-card__title">
                              <strong>{server.label}</strong>
                              <span>{server.author}</span>
                            </div>
                            <div className="mcp-card__badges">
                              {server.verified ? <span className="mcp-card__badge">已验证</span> : null}
                              {server.featured ? <span className="mcp-card__badge mcp-card__badge--featured">精选</span> : null}
                              <span className="mcp-card__badge">{server.transport}</span>
                            </div>
                          </div>
                          <span>{server.description}</span>
                          <span>
                            {server.capabilities.join(" / ")}
                            {" · "}
                            {server.status === "available" ? "可接入" : "规划中"}
                            {" · "}
                            {server.installStatus === "installed" ? "已安装" : "未安装"}
                          </span>
                          <div className="mcp-card__tags">
                            {server.tags.map((tag) => (
                              <span key={`${server.id}-${tag}`} className="mcp-card__tag">
                                {tag}
                              </span>
                            ))}
                          </div>
                          <div className="mcp-card__actions">
                            {server.homepageUrl ? (
                              <a href={server.homepageUrl} target="_blank" rel="noreferrer">
                                查看项目
                              </a>
                            ) : (
                              <span className="mcp-card__hint">暂无外部页面</span>
                            )}
                            <button
                              className="settings-actions__button settings-actions__button--primary"
                              onClick={() => {
                                if (server.installStatus === "installed") {
                                  void uninstallMcpServer(server.id);
                                  return;
                                }

                                void installMcpServer(server.id);
                              }}
                              disabled={runtimeCatalogs.mutatingMcpServerId === server.id || server.status !== "available"}
                            >
                              {runtimeCatalogs.mutatingMcpServerId === server.id
                                ? "处理中..."
                                : server.status !== "available"
                                  ? "规划中"
                                  : server.installStatus === "installed"
                                    ? "移除"
                                    : "安装"}
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="settings-panel__item">
                        <strong>还没有已安装的 MCP 服务器</strong>
                        <span>先从应用市场挑一个加入 Aliceloop，后面再继续补真实连接参数。</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Skills ── */}
                <h3 className="settings-section-title">Skills</h3>
                <div className="settings-panel">
                  <div className="settings-panel__heading">
                    <span>{runtimeCatalogs.skills.length} 个条目</span>
                  </div>
                  {runtimeCatalogs.error && runtimeCatalogs.status === "error" ? (
                    <div className="provider-notice provider-notice--error">{runtimeCatalogs.error}</div>
                  ) : null}
                  <div className="settings-panel__list">
                    {runtimeCatalogs.skills.map((skill) => (
                      <div key={skill.id} className="settings-panel__item">
                        <strong>{skill.label}</strong>
                        <span>{skill.description}</span>
                        <span>
                          {skill.status}
                          {" · "}
                          {skill.mode}
                          {" · "}
                          {skill.allowedTools.length > 0 ? skill.allowedTools.join(" / ") : "no tools listed"}
                        </span>
                        {skill.sourceUrl ? (
                          <a href={skill.sourceUrl} target="_blank" rel="noreferrer">
                            source
                          </a>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <footer className="settings-actions">
                <button className="settings-actions__button" onClick={() => setIsSettingsOpen(false)}>
                  关闭
                </button>
                <button
                  className="settings-actions__button settings-actions__button--primary"
                  onClick={saveRuntimePreferences}
                  disabled={runtimeSettings.saving}
                >
                  {runtimeSettings.saving ? "保存中..." : "保存"}
                </button>
              </footer>
            </div>
          </section>
        </div>
      ) : null}

      {previewImage ? (
        <div className="image-preview-overlay" onClick={() => setPreviewImage(null)}>
          <div className="image-preview-modal" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="image-preview-close"
              onClick={() => setPreviewImage(null)}
              aria-label="关闭图片预览"
            >
              ×
            </button>
            <img className="image-preview-image" src={previewImage.src} alt={previewImage.alt} />
            <div className="image-preview-caption">{previewImage.alt}</div>
          </div>
        </div>
      ) : null}
    </>
  );
}
