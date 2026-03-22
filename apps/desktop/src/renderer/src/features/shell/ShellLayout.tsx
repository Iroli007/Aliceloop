import type { Attachment, SandboxPermissionProfile, ToolApproval } from "@aliceloop/runtime-core";
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useProviderConfigs } from "../providers/useProviderConfigs";
import { settingsNav } from "./nav";
import { useShellConversation } from "./useShellConversation";
import { useRuntimeCatalogs } from "./useRuntimeCatalogs";
import { useRuntimeSettings } from "./useRuntimeSettings";
import { WindowControls } from "./WindowControls";
import type { ShellState } from "./useShellData";
import { getDesktopBridge } from "../../platform/desktopBridge";
import { ThinkingIndicator } from "../companion/ThinkingIndicator";
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

type TimelineEntry =
  | { kind: "message"; message: import("@aliceloop/runtime-core").SessionMessage }
  | { kind: "approval"; approval: ToolApproval };

function buildTimeline(
  messages: import("@aliceloop/runtime-core").SessionMessage[],
  resolvedApprovals: ToolApproval[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const message of messages) {
    entries.push({ kind: "message", message });
  }

  for (const approval of resolvedApprovals) {
    entries.push({ kind: "approval", approval });
  }

  entries.sort((a, b) => {
    const aTime = a.kind === "message" ? a.message.createdAt : (a.approval.resolvedAt ?? a.approval.requestedAt);
    const bTime = b.kind === "message" ? b.message.createdAt : (b.approval.resolvedAt ?? b.approval.requestedAt);
    return aTime.localeCompare(bTime);
  });

  return entries;
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
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
  const [sandboxProfileInput, setSandboxProfileInput] = useState<SandboxPermissionProfile>("development");
  const [sandboxNotice, setSandboxNotice] = useState<string | null>(null);
  const [mcpView, setMcpView] = useState<"marketplace" | "installed">("marketplace");
  const [mcpNotice, setMcpNotice] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState("");
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(176);
  const [composerReserveSpace, setComposerReserveSpace] = useState(192);
  const [queuedAttachments, setQueuedAttachments] = useState<Attachment[]>([]);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [permissionDropdownOpen, setPermissionDropdownOpen] = useState(false);
  const [threadNotice, setThreadNotice] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
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
  const activeProvider = providers.find((item) => item.id === activeProviderId) ?? providers[0] ?? null;
  const enabledProvider = providers.find((item) => item.enabled) ?? null;
  const activeToolApproval = conversation.pendingToolApprovals[0] ?? null;
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
    setSandboxProfileInput(runtimeSettings.settings.sandboxProfile);
  }, [runtimeSettings.settings.sandboxProfile]);

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
      shouldStickToBottomRef.current = distanceFromBottom <= bottomStickThresholdPx;
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

    setProviderApiKeyInput("");
    setProviderNotice(`${result.config?.label ?? activeProvider.label} 已保存。后续真实消息会通过当前启用的模型网关发出。`);
  }

  async function saveSandboxSettings() {
    setSandboxNotice(null);
    const result = await runtimeSettings.save({
      sandboxProfile: sandboxProfileInput,
    });

    if (!result.ok) {
      setSandboxNotice(result.error ?? "保存沙箱策略失败");
      return;
    }

    setSandboxNotice(
      sandboxProfileInput === "full-access"
        ? "完全访问权限已启用。AI Agent 现在会直接按宿主用户权限执行，不再附加路径、命令或逐条 bash 审批限制。"
        : "开发模式沙箱已启用。默认开放项目目录、数据目录和上传目录，上传的文件夹也会自动加入授权范围。",
    );
  }

  async function submitComposerDraft() {
    const content = composerDraft.trim();
    if (!content && queuedAttachments.length === 0) {
      return;
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

    input.value = "";
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
    ? conversation.stoppingResponse
      ? "正在停止等待中的命令审批"
      : "等待命令确认，点击可停止"
    : conversation.isResponding
      ? conversation.stoppingResponse
        ? "正在停止输出"
        : "停止输出"
      : "发送消息";
  const composerPrimaryActionDisabled = isComposerBusy
    ? conversation.stoppingResponse
    : conversation.pending || !composerDraft.trim();
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
                {buildTimeline(conversation.messages, conversation.resolvedToolApprovals).map((entry) => {
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
                    {message.attachments.length > 0 ? (
                      <div className="workspace__message-label">
                        {getAttachmentLabel(message.attachments)}
                      </div>
                    ) : null}
                    <div className="workspace__message-body">
                      <MessageContent
                        content={message.content}
                        renderMarkdown={message.role === "assistant" || message.role === "system"}
                      />
                    </div>
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

                {conversation.isResponding && <ThinkingIndicator thinkingSteps={conversation.thinkingSteps} />}

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
              onKeyDown={handleComposerKeyDown}
              placeholder="输入消息..."
              disabled={conversation.pending}
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
                  onClick={() => { setModelDropdownOpen((v) => !v); setPermissionDropdownOpen(false); }}
                >
                  <span className="composer__toolbar-btn-icon">⚡</span>
                  <span>{enabledProvider ? enabledProvider.label : "模型"}</span>
                  <span className="composer__toolbar-btn-caret">▾</span>
                </button>
                {modelDropdownOpen ? (
                  <div className="composer__dropdown">
                    {providers.map((provider) => (
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
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="composer__dropdown-wrapper">
                <button
                  type="button"
                  className={`composer__toolbar-btn${runtimeSettings.settings.sandboxProfile === "full-access" ? " composer__toolbar-btn--warn" : ""}`}
                  onClick={() => { setPermissionDropdownOpen((v) => !v); setModelDropdownOpen(false); }}
                >
                  <span>{runtimeSettings.settings.sandboxProfile === "full-access" ? "完全访问权限" : "开发模式"}</span>
                  <span className="composer__toolbar-btn-caret">▾</span>
                </button>
                {permissionDropdownOpen ? (
                  <div className="composer__dropdown">
                    <button
                      type="button"
                      className={`composer__dropdown-item${runtimeSettings.settings.sandboxProfile === "development" ? " composer__dropdown-item--active" : ""}`}
                      onClick={() => { void runtimeSettings.save({ sandboxProfile: "development" }); setPermissionDropdownOpen(false); }}
                    >
                      开发模式
                    </button>
                    <button
                      type="button"
                      className={`composer__dropdown-item${runtimeSettings.settings.sandboxProfile === "full-access" ? " composer__dropdown-item--active" : ""}`}
                      onClick={() => { void runtimeSettings.save({ sandboxProfile: "full-access" }); setPermissionDropdownOpen(false); }}
                    >
                      完全访问权限
                    </button>
                  </div>
                ) : null}
              </div>

              {conversation.isAwaitingToolApproval ? (
                <span className="composer__status-chip">等待命令确认</span>
              ) : null}

              <span className="composer__spacer" />
              <button
                type="submit"
                className={`composer__send${conversation.isAwaitingToolApproval ? " composer__send--waiting" : conversation.isResponding ? " composer__send--stop" : ""}`}
                disabled={composerPrimaryActionDisabled}
                aria-label={composerPrimaryActionLabel}
                title={composerPrimaryActionLabel}
              >
                {isComposerBusy ? (
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
                {/* ── 沙箱设置 ── */}
                <h3 className="settings-section-title">沙箱</h3>
                <div className="settings-panel">
                  <div className="settings-panel__heading">
                    <span>{runtimeSettings.settings.sandboxProfile === "full-access" ? "完全访问权限" : "开发模式"}</span>
                  </div>
                  <div className="provider-notice">
                    {runtimeSettings.settings.sandboxProfile === "full-access"
                      ? "完全访问权限下，AI Agent 会直接以宿主用户权限执行命令与文件操作，并保留审计日志。"
                      : "现在每一次 `bash` 指令都会先进入人工确认，再由你点击是否执行。命令会用单独的命令行底板展示，避免和普通说明混在一起。"}
                  </div>
                  {sandboxNotice ? <div className="provider-notice">{sandboxNotice}</div> : null}
                  {runtimeSettings.error ? <div className="provider-notice provider-notice--error">{runtimeSettings.error}</div> : null}
                  <div className="sandbox-profile-list">
                    <button
                      className={`sandbox-profile-card${sandboxProfileInput === "development" ? " sandbox-profile-card--active" : ""}`}
                      onClick={() => setSandboxProfileInput("development")}
                    >
                      <strong>开发模式</strong>
                      <span>默认开放项目目录、数据目录、上传目录，并限制命令白名单和路径范围，适合日常开发。</span>
                    </button>
                    <button
                      className={`sandbox-profile-card${sandboxProfileInput === "full-access" ? " sandbox-profile-card--active" : ""}`}
                      onClick={() => setSandboxProfileInput("full-access")}
                    >
                      <strong>完全访问权限</strong>
                      <span>AI Agent 直接按宿主用户完整权限执行，保留审计日志，但不再附加路径白名单、命令白名单或逐条 bash 审批。</span>
                    </button>
                  </div>
                  <div className="settings-panel__list">
                    <div className="settings-panel__item">
                      <strong>当前默认根目录</strong>
                      <span>项目目录、daemon 数据目录、uploads 目录。</span>
                    </div>
                    <div className="settings-panel__item">
                      <strong>上传目录扩展</strong>
                      <span>如果附件路径本身是一个文件夹，沙箱会自动拿到该文件夹的读写与 cwd 权限。</span>
                    </div>
                  </div>
                </div>

                {/* ── 记忆 ── */}
                <h3 className="settings-section-title">记忆</h3>
                <div className="settings-panel">
                  <div className="settings-panel__heading">
                    <span>{runtimeCatalogs.memories.length} 条</span>
                  </div>
                  {runtimeCatalogs.error && runtimeCatalogs.status === "error" ? (
                    <div className="provider-notice provider-notice--error">{runtimeCatalogs.error}</div>
                  ) : null}
                  <div className="settings-panel__list">
                    {runtimeCatalogs.memories.map((memory) => (
                      <div key={memory.id} className="settings-panel__item">
                        <strong>{memory.title}</strong>
                        <span>{memory.content}</span>
                      </div>
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
                        <span>{skill.sourcePath}</span>
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
                  onClick={saveSandboxSettings}
                  disabled={runtimeSettings.saving}
                >
                  {runtimeSettings.saving ? "保存中..." : "保存"}
                </button>
              </footer>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
