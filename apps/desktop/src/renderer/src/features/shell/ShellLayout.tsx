import {
  reasoningEffortDefinitions,
  type Attachment,
  type ProviderTransportKind,
  type SessionEvent,
  type SessionMessage,
  type ReasoningEffort,
  type ToolApproval,
} from "@aliceloop/runtime-core";
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useProviderConfigs } from "../providers/useProviderConfigs";
import { settingsNav } from "./nav";
import { SourceLinksSection } from "./SourceLinks";
import { TurnMetaBadge } from "./TurnMetaBadge";
import { ToolWorkflowCard, buildToolSourceLinks, type ToolSourceLink } from "./ToolWorkflowCard";
import { type ToolWorkflowEntry, useShellConversation } from "./useShellConversation";
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
    };

function buildTimeline(
  messages: import("@aliceloop/runtime-core").SessionMessage[],
  resolvedApprovals: ToolApproval[],
  toolWorkflowEntries: ToolWorkflowEntry[],
  sessionEvents: SessionEvent[],
): TimelineBlock[] {
  const messageSeqById = new Map<string, number>();
  const approvalSeqById = new Map<string, number>();

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
  }

  const entries: TimelineEntry[] = [];

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
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [queuedAttachments, setQueuedAttachments] = useState<Attachment[]>([]);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [reasoningDropdownOpen, setReasoningDropdownOpen] = useState(false);
  const [threadNotice, setThreadNotice] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
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
  const activeToolApproval = conversation.pendingToolApprovals[0] ?? null;
  const activeDeleteApproval = activeToolApproval ? isDeleteToolApproval(activeToolApproval) : false;
  const composerHasText = composerDraft.trim().length > 0;
  const composerHasSendableContent = composerHasText || queuedAttachments.length > 0;
  const isComposerBusy = conversation.isResponding || conversation.isAwaitingToolApproval;
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
  }, [conversation.pendingToolApprovals.length]);

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
    if (!content && queuedAttachments.length === 0) {
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
    const result = await conversation.sendMessage(content, queuedAttachments.map((attachment) => attachment.id));
    if (!result.ok) {
      setComposerNotice(result.error ?? "发送失败");
      return;
    }

    setComposerDraft("");
    setQueuedAttachments([]);
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

  async function resolveToolApproval(action: "approve" | "reject") {
    if (!activeToolApproval) {
      return;
    }

    setComposerNotice(null);
    const result =
      action === "approve"
        ? await conversation.approveToolApproval(activeToolApproval.id)
        : await conversation.rejectToolApproval(activeToolApproval.id);

    if (!result.ok) {
      setComposerNotice(result.error ?? "命令审批失败");
    }
    setApprovalAttachments([]);
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
            onClick={() => void resolveToolApproval("reject")}
            disabled={conversation.resolvingToolApprovalId === activeToolApproval.id}
          >
            拒绝
          </button>
          <button
            type="button"
            className="approval-card__btn approval-card__btn--approve"
            onClick={() => void resolveToolApproval("approve")}
            disabled={conversation.resolvingToolApprovalId === activeToolApproval.id}
          >
            {conversation.resolvingToolApprovalId === activeToolApproval.id ? "处理中…" : "允许执行"}
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
                            <span className="sidebar__thread-title">{thread.title}</span>
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
                {buildTimeline(
                  conversation.messages,
                conversation.resolvedToolApprovals,
                  conversation.toolWorkflowEntries,
                  conversation.sessionEvents,
                ).map((entry) => {
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

                          return (
                            <article
                              key={`${message.id}::${itemIndex}`}
                              className={`workspace__message workspace__message--${message.role}${message.attachments.length > 0 ? " workspace__message--has-attachments" : ""}`}
                            >
                              <div className="workspace__message-body">
                                <MessageContent
                                  content={message.content}
                                  renderMarkdown={message.role === "assistant" || message.role === "system"}
                                />
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

                  if (entry.kind === "tool") {
                    return <ToolWorkflowCard key={`tool-${entry.tool.toolCallId}`} entry={entry.tool} />;
                  }

                  if (entry.kind === "approval") {
                    const approval = entry.approval;
                    return (
                      <div key={`approval-${approval.id}`} className="approval-resolved">
                        <span className="approval-resolved__tool">{approval.title}</span>
                        <span className="approval-resolved__command">{approval.commandLine}</span>
                        <span className={`approval-resolved__status approval-resolved__status--${approval.status}`}>
                          {approval.status === "approved" ? "已批准" : "已拒绝"}
                        </span>
                        <span className="approval-resolved__time">{formatApprovalTime(approval.resolvedAt)}</span>
                      </div>
                    );
                  }

                  const message = entry.message;

                  return (
                    <article
                      key={message.id}
                      className={`workspace__message workspace__message--${message.role}${message.attachments.length > 0 ? " workspace__message--has-attachments" : ""}`}
                    >
                      <div className="workspace__message-body">
                        <MessageContent
                          content={message.content}
                          renderMarkdown={message.role === "assistant" || message.role === "system"}
                        />
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
                  onClick={() => { setModelDropdownOpen((v) => !v); setReasoningDropdownOpen(false); }}
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
                  onClick={() => { setReasoningDropdownOpen((v) => !v); setModelDropdownOpen(false); }}
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

              {conversation.isAwaitingToolApproval ? (
                <span className="composer__status-chip">{activeDeleteApproval ? "等待删除回复" : "等待命令确认"}</span>
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
