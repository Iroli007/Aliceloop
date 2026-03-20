import type { Attachment, SandboxPermissionProfile } from "@aliceloop/runtime-core";
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useProviderConfigs } from "../providers/useProviderConfigs";
import { settingsNav } from "./nav";
import { useShellConversation } from "./useShellConversation";
import { useRuntimeCatalogs } from "./useRuntimeCatalogs";
import { useRuntimeSettings } from "./useRuntimeSettings";
import type { ShellState } from "./useShellData";
import { getDesktopBridge } from "../../platform/desktopBridge";

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
  const isMacDesktop = desktopBridge.mode === "electron" && navigator.platform.toLowerCase().includes("mac");
  const threadGroups = groupThreadsByDate(conversation.threads);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarMotion, setSidebarMotion] = useState<"opening" | "closing" | null>(null);
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
  const [languageToastVisible, setLanguageToastVisible] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const approvalDockRef = useRef<HTMLDivElement | null>(null);
  const [approvalAttachments, setApprovalAttachments] = useState<Attachment[]>([]);
  const motionTimerRef = useRef<number | null>(null);
  const languageToastTimerRef = useRef<number | null>(null);
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const composerAddFileButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerFolderInputRef = useRef<HTMLInputElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousSessionIdRef = useRef<string | null>(null);
  const previousViewportHeightRef = useRef<number | null>(null);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const scrollSyncTimeoutRef = useRef<number | null>(null);
  const providers = providerState.providers;
  const activeProvider = providers.find((item) => item.id === activeProviderId) ?? providers[0] ?? null;
  const enabledProvider = providers.find((item) => item.enabled) ?? null;
  const activeToolApproval = conversation.pendingToolApprovals[0] ?? null;
  const isComposerBusy = conversation.isResponding || conversation.isAwaitingToolApproval;
  const installedMcpServers = runtimeCatalogs.mcpServers.filter((server) => server.installStatus === "installed");
  const visibleMcpServers = (mcpView === "installed" ? installedMcpServers : runtimeCatalogs.mcpServers)
    .slice()
    .sort((left, right) => Number(right.featured) - Number(left.featured) || left.label.localeCompare(right.label, "zh-CN"));
  const shellMainStyle = {
    "--composer-height": `${composerHeight}px`,
    "--composer-reserve-space": `${composerReserveSpace}px`,
  } as CSSProperties;

  useEffect(() => {
    return () => {
      if (motionTimerRef.current) {
        window.clearTimeout(motionTimerRef.current);
      }

      if (languageToastTimerRef.current) {
        window.clearTimeout(languageToastTimerRef.current);
      }

      if (scrollSyncFrameRef.current) {
        window.cancelAnimationFrame(scrollSyncFrameRef.current);
      }

      if (scrollSyncTimeoutRef.current) {
        window.clearTimeout(scrollSyncTimeoutRef.current);
      }
    };
  }, []);

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

  function showLanguageToast() {
    setLanguageToastVisible(true);

    if (languageToastTimerRef.current) {
      window.clearTimeout(languageToastTimerRef.current);
    }

    languageToastTimerRef.current = window.setTimeout(() => {
      setLanguageToastVisible(false);
      languageToastTimerRef.current = null;
    }, 1600);
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

  async function minimizeWindow() {
    await desktopBridge.minimizeWindow();
  }

  async function toggleMaximizeWindow() {
    await desktopBridge.toggleMaximizeWindow();
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

  async function handleComposerFolderChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) {
      return;
    }

    setComposerNotice(null);
    const result = await conversation.uploadFolder(files);
    if (!result.ok) {
      setComposerNotice(result.error ?? "文件夹上传失败");
      input.value = "";
      return;
    }

    const attachment = result.attachment;
    if (attachment) {
      setQueuedAttachments((current) => mergeAttachments(current, [attachment]));
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
    : conversation.pending || (!composerDraft.trim() && queuedAttachments.length === 0);
  const approvalCard = activeToolApproval ? (
    <div className="approval-card">
      <div className="approval-card__accent" />
      <div className="approval-card__body">
        <div className="approval-card__head">
          <div className="approval-card__title-row">
            <svg className="approval-card__icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="2" width="14" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="3.8" cy="4.6" r="0.8" fill="#ef6b5e" />
              <circle cx="5.8" cy="4.6" r="0.8" fill="#f5bf4f" />
              <circle cx="7.8" cy="4.6" r="0.8" fill="#61c554" />
              <path d="M4 8h3M4 10.5h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
            <strong>{activeToolApproval.title}</strong>
            <span className="approval-card__chip">需人工确认</span>
          </div>
          {activeToolApproval.detail ? (
            <p className="approval-card__detail">{activeToolApproval.detail}</p>
          ) : null}
        </div>
        <div className="approval-card__command-wrap">
          <pre className="approval-card__command"><code>{activeToolApproval.toolName === "sandbox_bash" ? <><span className="approval-card__prompt">$</span> {activeToolApproval.commandLine}</> : activeToolApproval.commandLine}</code></pre>
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
        className={[
          "shell",
          isSidebarCollapsed ? "shell--sidebar-collapsed" : "",
          sidebarMotion ? `shell--sidebar-${sidebarMotion}` : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {/* Floating toolbar icons – animate between sidebar header and traffic-light row */}
        <div className={`shell__toolbar-icons${isSidebarCollapsed ? " shell__toolbar-icons--collapsed" : ""}`}>
          <button
            className="sidebar__icon-button sidebar__icon-button--neutral shell__sidebar-pin"
            type="button"
            aria-label={isSidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={toggleSidebar}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3.5" y="4.5" width="17" height="15" rx="4.5" />
              <path d="M8.25 7.5V16.5" />
            </svg>
            <span className="sidebar__icon-tooltip">{isSidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}</span>
          </button>
          <button className="sidebar__icon-button" aria-label="线程搜索" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10.2 18.2c4.42 0 8-3.13 8-6.98s-3.58-6.97-8-6.97s-8 3.12-8 6.97c0 1.92.89 3.66 2.34 4.92l-.73 3.3l3.27-1.44c.96.14 1.69.2 3.12.2Z" />
            </svg>
            <span className="sidebar__icon-tooltip">线程搜索</span>
          </button>
        </div>

        <aside className={`shell__sidebar${isSidebarCollapsed ? " shell__sidebar--collapsed" : ""}`}>
          <header className="sidebar__header">
            <div className="sidebar__titlebar-spacer" />
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
            <div className="sidebar__settings-anchor">
              <button className="sidebar__settings-button" type="button">
                <span className="sidebar__settings-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path
                      d="M12 8.75a3.25 3.25 0 1 0 0 6.5a3.25 3.25 0 0 0 0-6.5Z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    />
                    <path
                      d="M19.4 13.5a7.8 7.8 0 0 0 .08-1.5a7.8 7.8 0 0 0-.08-1.5l1.66-1.3a.78.78 0 0 0 .19-.99l-1.57-2.72a.78.78 0 0 0-.94-.34l-1.96.79a7.7 7.7 0 0 0-2.58-1.5l-.3-2.08a.77.77 0 0 0-.77-.66h-3.14a.77.77 0 0 0-.77.66l-.3 2.08a7.7 7.7 0 0 0-2.58 1.5l-1.96-.79a.78.78 0 0 0-.94.34L2.75 8.21a.78.78 0 0 0 .19.99l1.66 1.3a7.8 7.8 0 0 0-.08 1.5a7.8 7.8 0 0 0 .08 1.5l-1.66 1.3a.78.78 0 0 0-.19.99l1.57 2.72c.2.35.62.49.94.34l1.96-.79c.76.62 1.63 1.13 2.58 1.5l.3 2.08c.07.38.39.66.77.66h3.14c.38 0 .7-.28.77-.66l.3-2.08a7.7 7.7 0 0 0 2.58-1.5l1.96.79c.32.15.74.01.94-.34l1.57-2.72a.78.78 0 0 0-.19-.99l-1.66-1.3Z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className="sidebar__settings-label">{isSidebarCollapsed ? "" : "设置"}</span>
              </button>

              {languageToastVisible && !isSidebarCollapsed ? (
                <div className="sidebar__settings-toast" role="status" aria-live="polite">
                  工时赶还没做！！！
                </div>
              ) : null}

              {!isSidebarCollapsed ? (
                <div className="sidebar__settings-popout">
                  <button
                    className="sidebar__settings-popout-item"
                    type="button"
                    onClick={() => setIsSettingsOpen(true)}
                  >
                    设置
                  </button>
                  <button className="sidebar__settings-popout-item" type="button" onClick={showLanguageToast}>
                    语言
                  </button>
                </div>
              ) : null}
            </div>
          </footer>
        </aside>

        <main className="shell__main" style={shellMainStyle}>
          <header className="main__header">
            <div className="main__header-left">
              <div className="main__window-controls-space" aria-hidden="true" />
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
                {conversation.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`workspace__message workspace__message--${message.role}${message.attachments.length > 0 ? " workspace__message--has-attachments" : ""}`}
                  >
                    {message.attachments.length > 0 ? (
                      <div className="workspace__message-label">
                        {getAttachmentLabel(message.attachments)}
                      </div>
                    ) : null}
                    <div className="workspace__message-body">{message.content}</div>
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
                ))}

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
                  {conversation.pendingUpload
                    ? "上传中..."
                    : desktopBridge.mode === "electron"
                      ? "打开文件或文件夹"
                      : "打开文件"}
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

              {desktopBridge.mode !== "electron" ? (
                <div className="composer__add-file">
                  <button
                    type="button"
                    className="composer__add-file-button"
                    aria-label={conversation.pendingUpload ? "上传中" : "添加文件夹"}
                    onClick={() => {
                      composerFolderInputRef.current?.click();
                    }}
                    disabled={conversation.pendingUpload || conversation.pending}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l1.8 2H18.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-8.5Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <span className="composer__add-file-tooltip">打开文件夹</span>
                  <input
                    ref={composerFolderInputRef}
                    className="composer__file-input"
                    type="file"
                    multiple
                    directory=""
                    webkitdirectory=""
                    onChange={handleComposerFolderChange}
                    disabled={conversation.pendingUpload || conversation.pending}
                  />
                </div>
              ) : null}

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
            <aside className="settings-sidebar">
              <div className="settings-sidebar__header">
                {isMacDesktop ? (
                  <div className="settings-window-controls" aria-label="窗口控制">
                    <button
                      type="button"
                      className="settings-window-controls__button settings-window-controls__button--close"
                      aria-label="关闭设置"
                      onClick={() => setIsSettingsOpen(false)}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                    <button
                      type="button"
                      className="settings-window-controls__button settings-window-controls__button--minimize"
                      aria-label="最小化窗口"
                      onClick={() => { void minimizeWindow(); }}
                    >
                      <span aria-hidden="true">−</span>
                    </button>
                    <button
                      type="button"
                      className="settings-window-controls__button settings-window-controls__button--zoom"
                      aria-label="缩放窗口"
                      onClick={() => { void toggleMaximizeWindow(); }}
                    >
                      <span aria-hidden="true">+</span>
                    </button>
                  </div>
                ) : (
                  <div className="settings-sidebar__titlebar-spacer" />
                )}
              </div>
              <div className="settings-sidebar__list">
                {settingsNav.map((item) => (
                  <button
                    key={item.id}
                    className={`settings-nav__item${activeSettingsTab === item.id ? " settings-nav__item--active" : ""}`}
                    onClick={() => setActiveSettingsTab(item.id)}
                  >
                    <span className="settings-nav__icon" aria-hidden="true">
                      {item.id === "general" ? (
                        <svg viewBox="0 0 24 24" fill="none">
                          <path
                            d="M12 8.9a3.1 3.1 0 1 0 0 6.2a3.1 3.1 0 0 0 0-6.2Z"
                            stroke="currentColor"
                            strokeWidth="1.8"
                          />
                          <path
                            d="M19.06 13.44a7.3 7.3 0 0 0 .08-1.44a7.3 7.3 0 0 0-.08-1.44l1.46-1.15a.69.69 0 0 0 .17-.94l-1.38-2.38a.7.7 0 0 0-.84-.31l-1.72.7a7.4 7.4 0 0 0-2.47-1.42l-.27-1.83a.7.7 0 0 0-.69-.6h-2.76a.7.7 0 0 0-.69.6l-.27 1.83a7.4 7.4 0 0 0-2.47 1.42l-1.72-.7a.7.7 0 0 0-.84.31L3.31 8.47a.69.69 0 0 0 .17.94l1.46 1.15A7.3 7.3 0 0 0 4.86 12c0 .49.03.97.08 1.44l-1.46 1.15a.69.69 0 0 0-.17.94l1.38 2.38c.18.31.55.43.84.31l1.72-.7c.73.59 1.56 1.06 2.47 1.42l.27 1.83c.06.35.35.6.69.6h2.76c.34 0 .63-.25.69-.6l.27-1.83a7.4 7.4 0 0 0 2.47-1.42l1.72.7c.29.12.66 0 .84-.31l1.38-2.38a.69.69 0 0 0-.17-.94l-1.46-1.15Z"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : item.id === "providers" ? (
                        <svg viewBox="0 0 24 24" fill="none">
                          <rect
                            x="5.1"
                            y="7.2"
                            width="13.8"
                            height="9.6"
                            rx="2.2"
                            stroke="currentColor"
                            strokeWidth="1.8"
                          />
                          <path
                            d="M9.4 11.95h5.2"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                          <path
                            d="M3.8 10.4v3.2M20.2 10.4v3.2"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                          <path
                            d="M8.15 5.2v2M15.85 5.2v2M8.15 16.8v2M15.85 16.8v2"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        </svg>
                      ) : item.id === "memory" ? (
                        <svg viewBox="0 0 24 24" fill="none">
                          <path
                            d="M9.15 5.2c-2.31 0-4.15 1.84-4.15 4.12c0 .73.19 1.43.56 2.05a3.8 3.8 0 0 0-1.56 3.08c0 2.16 1.78 3.92 3.97 3.92c.48 0 .95-.08 1.39-.24c.74 1.19 2.07 1.97 3.58 1.97s2.84-.78 3.58-1.97c.44.16.91.24 1.39.24c2.19 0 3.97-1.76 3.97-3.92a3.8 3.8 0 0 0-1.56-3.08c.37-.62.56-1.32.56-2.05c0-2.28-1.84-4.12-4.15-4.12c-1.15 0-2.2.46-2.96 1.21A4.23 4.23 0 0 0 12 4c-1.18 0-2.26.48-3.05 1.25A4.19 4.19 0 0 0 9.15 5.2Z"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M12 7.35v9.3M9.35 9.3c.85.38 1.58 1.1 1.95 1.95M14.65 9.3c-.85.38-1.58 1.1-1.95 1.95M9.35 14.7c.85-.38 1.58-1.1 1.95-1.95M14.65 14.7c-.85-.38-1.58-1.1-1.95-1.95"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                          />
                        </svg>
                      ) : item.id === "mcp" ? (
                        <svg viewBox="0 0 24 24" fill="none">
                          <path
                            d="M9.5 4v4M14.5 4v4"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                          <path
                            d="M7 8h10v4a5 5 0 0 1-10 0V8Z"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M12 16v4"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        </svg>
                      ) : item.id === "skills" ? (
                        <svg viewBox="0 0 24 24" fill="none">
                          <path
                            d="M9 5V3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V5"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <rect
                            x="3.5"
                            y="5"
                            width="17"
                            height="12"
                            rx="2"
                            stroke="currentColor"
                            strokeWidth="1.8"
                          />
                          <path
                            d="M3.5 10h17"
                            stroke="currentColor"
                            strokeWidth="1.8"
                          />
                        </svg>
                      ) : item.id === "sandbox" ? (
                        <svg viewBox="0 0 24 24" fill="none">
                          <path
                            d="M5 9l1.5-4.5h11L19 9"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M5 9v10a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V9"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M5 9h14"
                            stroke="currentColor"
                            strokeWidth="1.8"
                          />
                          <path
                            d="M10 9V6.5"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                          <circle cx="14.5" cy="14" r="2" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.5 2.5" />
                        </svg>
                      ) : (
                        item.shortLabel
                      )}
                    </span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </aside>

            <div className="settings-content">
              <header className="settings-content__header">
                <h2>{settingsNav.find((item) => item.id === activeSettingsTab)?.label ?? "设置"}</h2>
              </header>

              <div className="settings-content__body">
              {activeSettingsTab === "providers" ? (
                <div className="settings-providers">
                  <div className="settings-providers__body">
                    <div className="provider-list">
                      {providers.map((provider) => (
                        <button
                          key={provider.id}
                          className={`provider-list__item${activeProviderId === provider.id ? " provider-list__item--active" : ""}`}
                          onClick={() => setActiveProviderId(provider.id)}
                        >
                          <div className="provider-list__identity">
                            <span className="provider-list__logo">{provider.label.slice(0, 2)}</span>
                            <div>
                              <div className="provider-list__name">{provider.label}</div>
                              <div className="provider-list__subtitle">{provider.model}</div>
                            </div>
                          </div>
                          <span className={`provider-list__status provider-list__status--${provider.enabled ? "active" : "inactive"}`} />
                        </button>
                      ))}
                    </div>

                    <div className="provider-detail">
                      {activeProvider ? (
                        <>
                          <div className="provider-detail__header">
                            <div>
                              <h3>{activeProvider.label}</h3>
                              <p>{activeProvider.baseUrl}</p>
                            </div>
                            <div className="provider-detail__switches">
                              <button className="provider-detail__icon">ϟ</button>
                              <button
                                className={`provider-detail__toggle${providerEnabled ? " provider-detail__toggle--on" : ""}`}
                                onClick={() => setProviderEnabled((current) => !current)}
                              />
                            </div>
                          </div>

                        <div className="provider-field">
                          <label>当前策略</label>
                          <div className="provider-field__box">
                              Aliceloop 负责 session、sandbox、skills 和事件流；模型网关只负责推理与协议适配。
                          </div>
                        </div>

                          <div className="provider-field">
                            <label>路由模式</label>
                            <div className="provider-field__box">
                              {activeProvider.transport === "auto"
                                ? "自动：Claude 系列走 Anthropic 兼容接口，其余模型默认走 OpenAI 兼容接口。"
                                : activeProvider.transport === "anthropic"
                                  ? "固定走 Anthropic 兼容接口。"
                                  : "固定走 OpenAI 兼容接口。"}
                            </div>
                          </div>

                          <div className="provider-field">
                            <label>API Key</label>
                            <input
                              className="provider-field__input"
                              type="password"
                              value={providerApiKeyInput}
                              onChange={(event) => setProviderApiKeyInput(event.target.value)}
                              placeholder={
                                activeProvider.hasApiKey
                                  ? `已保存 ${activeProvider.apiKeyMasked ?? `${activeProvider.label} Key`}，留空则保持不变`
                                  : `粘贴你的 ${activeProvider.label} API Key`
                              }
                            />
                          </div>

                          <div className="provider-field">
                            <label>Base URL</label>
                            <input
                              className="provider-field__input"
                              value={providerBaseUrlInput}
                              onChange={(event) => setProviderBaseUrlInput(event.target.value)}
                              placeholder={activeProvider.baseUrl}
                            />
                          </div>

                          <div className="provider-field">
                            <label>模型</label>
                            <input
                              className="provider-field__input"
                              value={providerModelInput}
                              onChange={(event) => setProviderModelInput(event.target.value)}
                              placeholder={activeProvider.model}
                            />
                          </div>

                        <div className="provider-field">
                          <label>状态</label>
                          <div className="provider-field__box">
                              {providerEnabled ? "已启用，可通过当前网关发起真实推理" : "未启用，保存后仍可先保留网关配置"}
                          </div>
                        </div>

                          {providerNotice ? <div className="provider-notice">{providerNotice}</div> : null}
                          {providerState.error ? <div className="provider-notice provider-notice--error">{providerState.error}</div> : null}

                          <div className="provider-actions">
                            <button className="settings-toolbar__button" onClick={() => setProviderApiKeyInput("")}>
                              清空本次输入
                            </button>
                            <button
                              className="settings-toolbar__button settings-toolbar__button--primary"
                              onClick={saveActiveProvider}
                              disabled={providerState.savingProviderId === activeProvider.id}
                            >
                              {providerState.savingProviderId === activeProvider.id ? "保存中..." : `保存 ${activeProvider.label}`}
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="provider-field">
                          <label>模型网关</label>
                          <div className="provider-field__box">
                            还没有从 daemon 读到可编辑的模型网关配置。
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}

              {activeSettingsTab === "sandbox" ? (
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
              ) : null}

              {activeSettingsTab === "memory" ? (
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
              ) : null}

              {activeSettingsTab === "mcp" ? (
                <div className="settings-panel">
                  <div className="settings-panel__heading">
                    <span>{runtimeCatalogs.mcpServers.length} 个条目 / 已安装 {installedMcpServers.length}</span>
                  </div>
                  <div className="provider-notice">
                    Aliceloop 只做 MCP client。这里的“安装”是在 Aliceloop 内登记已安装状态，真正的 MCP 服务仍由用户从应用市场自行下载和配置。
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
              ) : null}

              {activeSettingsTab === "skills" ? (
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
              ) : null}

              {activeSettingsTab === "general" ? (
                <div className="settings-panel">
                  <div className="settings-panel__list">
                    <div className="settings-panel__item"><span>暂无可配置项</span></div>
                  </div>
                </div>
              ) : null}
              </div>


              <footer className="settings-actions">
                <button className="settings-actions__button" onClick={() => setIsSettingsOpen(false)}>
                  关闭
                </button>
                <button
                  className="settings-actions__button settings-actions__button--primary"
                  onClick={activeSettingsTab === "sandbox" ? saveSandboxSettings : saveActiveProvider}
                  disabled={
                    activeSettingsTab === "providers"
                      ? !activeProvider || providerState.savingProviderId === activeProvider.id
                      : activeSettingsTab === "sandbox"
                        ? runtimeSettings.saving
                        : true
                  }
                >
                  {activeSettingsTab === "sandbox"
                    ? runtimeSettings.saving
                      ? "保存中..."
                      : "保存"
                    : providerState.savingProviderId
                      ? "保存中..."
                      : "保存"}
                </button>
              </footer>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
