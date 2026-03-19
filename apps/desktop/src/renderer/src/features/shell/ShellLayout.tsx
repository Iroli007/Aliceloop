import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { useProviderConfigs } from "../providers/useProviderConfigs";
import { settingsNav } from "./nav";
import { useShellConversation } from "./useShellConversation";
import { useRuntimeCatalogs } from "./useRuntimeCatalogs";
import type { ShellState } from "./useShellData";

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
  const conversation = useShellConversation();
  const threadGroups = groupThreadsByDate(conversation.threads);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarMotion, setSidebarMotion] = useState<"opening" | "closing" | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState("providers");
  const [activeProviderId, setActiveProviderId] = useState("minimax");
  const [providerApiKeyInput, setProviderApiKeyInput] = useState("");
  const [providerBaseUrlInput, setProviderBaseUrlInput] = useState("");
  const [providerModelInput, setProviderModelInput] = useState("");
  const [providerEnabled, setProviderEnabled] = useState(false);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState("");
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(176);
  const [composerReserveSpace, setComposerReserveSpace] = useState(192);
  const [threadNotice, setThreadNotice] = useState<string | null>(null);
  const motionTimerRef = useRef<number | null>(null);
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousSessionIdRef = useRef<string | null>(null);
  const previousViewportHeightRef = useRef<number | null>(null);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const scrollSyncTimeoutRef = useRef<number | null>(null);
  const providers = providerState.providers;
  const activeProvider = providers.find((item) => item.id === activeProviderId) ?? providers[0] ?? null;
  const enabledProvider = providers.find((item) => item.enabled) ?? null;
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
  }, [composerHeight, composerReserveSpace, conversation.sessionId, conversation.messages, conversation.latestJob?.updatedAt]);

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
      const nextReserveSpace = Math.max(nextHeight, Math.ceil(viewportRect.bottom - composerRect.top));
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

  async function saveActiveProvider() {
    if (!activeProvider) {
      setProviderNotice("当前还没有可编辑的 provider。");
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
    setProviderNotice(`${result.config?.label ?? activeProvider.label} 已保存。现在主界面和 companion 都可以发真实消息。`);
  }

  async function submitComposerDraft() {
    const content = composerDraft.trim();
    if (!content) {
      return;
    }

    setComposerNotice(null);
    const result = await conversation.sendMessage(content);
    if (!result.ok) {
      setComposerNotice(result.error ?? "发送失败");
      return;
    }

    setComposerDraft("");
  }

  async function submitComposer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitComposerDraft();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    void submitComposerDraft();
  }

  async function createThread() {
    setThreadNotice(null);
    const result = await conversation.createSession();
    if (!result.ok) {
      setThreadNotice(result.error ?? "新建线程失败");
    }
  }

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
        <button
          className="shell__sidebar-pin"
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

        <aside className={`shell__sidebar${isSidebarCollapsed ? " shell__sidebar--collapsed" : ""}`}>
          <header className="sidebar__header">
            <div className="sidebar__titlebar-spacer" />
            <div className="sidebar__icons">
              <button className="sidebar__icon-button" aria-label="线程搜索" type="button">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M10.2 18.2c4.42 0 8-3.13 8-6.98s-3.58-6.97-8-6.97s-8 3.12-8 6.97c0 1.92.89 3.66 2.34 4.92l-.73 3.3l3.27-1.44c.96.14 1.69.2 3.12.2Z" />
                </svg>
                <span className="sidebar__icon-tooltip">线程搜索</span>
              </button>
            </div>
          </header>

          <section className="sidebar__threads">
            <button className="sidebar__thread-button sidebar__new-chat" type="button" onClick={createThread}>
              {isSidebarCollapsed ? "+" : "New Chat"}
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

              {!isSidebarCollapsed ? (
                <div className="sidebar__settings-popout">
                  <button
                    className="sidebar__settings-popout-item"
                    type="button"
                    onClick={() => setIsSettingsOpen(true)}
                  >
                    设置
                  </button>
                  <button className="sidebar__settings-popout-item" type="button">
                    语言
                  </button>
                </div>
              ) : null}
            </div>
          </footer>
        </aside>

        <main className="shell__main" style={shellMainStyle}>
          <header className="main__header">
            <div className="main__title">
              <strong>{conversation.sessionTitle}</strong>
              <span>·</span>
              <span>{conversation.messages.length} 条消息</span>
            </div>
          </header>

          <section ref={messagesViewportRef} className="workspace">
            <div className="workspace__thread">
              <div ref={messagesContentRef} className="workspace__messages">
                {conversation.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`workspace__message workspace__message--${message.role}`}
                  >
                    <div className="workspace__message-label">
                      {message.role === "user" ? "You" : message.role === "assistant" ? "Aliceloop" : "System"}
                    </div>
                    <div className="workspace__message-body">{message.content}</div>
                    {message.attachments.length > 0 ? (
                      <div className="workspace__message-attachments">
                        {message.attachments.map((attachment) => (
                          <span key={attachment.id} className="workspace__attachment-chip">
                            {attachment.fileName}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))}

                {conversation.latestJob?.status === "running" ? (
                  <div className="workspace__status-row">
                    <span className="workspace__status-dot" />
                    <span>{conversation.latestJob.title}</span>
                  </div>
                ) : null}

                <div ref={messagesEndRef} className="workspace__end-anchor" aria-hidden="true" />
              </div>
            </div>
          </section>

          <form ref={composerRef} className="composer" onSubmit={submitComposer}>
            <textarea
              className="composer__input composer__input--field"
              value={composerDraft}
              onChange={(event) => setComposerDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="输入消息..."
              disabled={conversation.pending}
            />
            <div className="composer__toolbar">
              <span className="composer__action">⌘</span>
              <span className="composer__meta">
                {enabledProvider ? enabledProvider.model : "Provider 未启用"}
              </span>
              <span className="composer__spacer" />
              {conversation.latestJob ? (
                <span className={`composer__job composer__job--${conversation.latestJob.status}`}>
                  {conversation.latestJob.title}
                </span>
              ) : null}
              <span className="composer__action">{conversation.pending ? "◌" : "◔"}</span>
              <button
                type="submit"
                className="composer__send"
                disabled={conversation.pending || !composerDraft.trim()}
                aria-label="发送消息"
                title="发送消息"
              >
                ➤
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
                <div className="settings-sidebar__titlebar-spacer" />
              </div>
              <div className="settings-sidebar__list">
                {settingsNav.map((item) => (
                  <button
                    key={item.id}
                    className={`settings-nav__item${activeSettingsTab === item.id ? " settings-nav__item--active" : ""}`}
                    onClick={() => setActiveSettingsTab(item.id)}
                  >
                    <span className="settings-nav__icon">{item.shortLabel}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </aside>

            <div className="settings-content">
              <header className="settings-content__header">
                <h2>{settingsNav.find((item) => item.id === activeSettingsTab)?.label ?? "设置"}</h2>
              </header>

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
                              内置 coding agent 负责调度四原语和 skills；provider 只负责推理，不接管 Aliceloop 的 session、sandbox 和事件流。
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
                              {providerEnabled ? "已启用，可接真实推理" : "未启用，保存后仍可先保留配置"}
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
                          <label>Provider</label>
                          <div className="provider-field__box">
                            还没有从 daemon 读到可编辑的 provider。
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}

              {activeSettingsTab === "memory" ? (
                <div className="settings-panel">
                  <div className="settings-panel__heading">
                    <h3>高层记忆</h3>
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
                    <h3>MCP 服务器</h3>
                    <span>{runtimeCatalogs.mcpServers.length} 个条目</span>
                  </div>
                  {runtimeCatalogs.error && runtimeCatalogs.status === "error" ? (
                    <div className="provider-notice provider-notice--error">{runtimeCatalogs.error}</div>
                  ) : null}
                  <div className="settings-panel__list">
                    {runtimeCatalogs.mcpServers.map((server) => (
                      <div key={server.id} className="settings-panel__item">
                        <strong>{server.label}</strong>
                        <span>
                          {server.transport}
                          {" · "}
                          {server.capabilities.join(" / ")}
                          {" · "}
                          {server.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {activeSettingsTab === "skills" ? (
                <div className="settings-panel">
                  <div className="settings-panel__heading">
                    <h3>技能</h3>
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

              <footer className="settings-actions">
                <button className="settings-actions__button" onClick={() => setIsSettingsOpen(false)}>
                  关闭
                </button>
                <button
                  className="settings-actions__button settings-actions__button--primary"
                  onClick={saveActiveProvider}
                  disabled={activeSettingsTab !== "providers" || !activeProvider || providerState.savingProviderId === activeProvider.id}
                >
                  {providerState.savingProviderId ? "保存中..." : "保存"}
                </button>
              </footer>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
