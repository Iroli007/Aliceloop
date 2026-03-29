import { useEffect, useState } from "react";
import { useRuntimeCatalogs } from "../shell/useRuntimeCatalogs";
import { useRuntimeSettings } from "../shell/useRuntimeSettings";
import { getDesktopBridge } from "../../platform/desktopBridge";
import {
  reasoningEffortDefinitions,
  type ReasoningEffort,
} from "@aliceloop/runtime-core";

const reasoningEffortLabels = new Map(reasoningEffortDefinitions.map((definition) => [definition.id, definition.label] as const));

function formatReasoningEffortLabel(value: ReasoningEffort) {
  return reasoningEffortLabels.get(value) ?? value;
}

export function SettingsPanel() {
  const runtimeCatalogs = useRuntimeCatalogs();
  const runtimeSettings = useRuntimeSettings();
  const desktopBridge = getDesktopBridge();

  const [reasoningEffortInput, setReasoningEffortInput] = useState<ReasoningEffort>("medium");
  const [reasoningNotice, setReasoningNotice] = useState<string | null>(null);
  const [mcpView, setMcpView] = useState<"marketplace" | "installed">("marketplace");
  const [mcpNotice, setMcpNotice] = useState<string | null>(null);

  const installedMcpServers = runtimeCatalogs.mcpServers.filter((server) => server.installStatus === "installed");
  const visibleMcpServers = (mcpView === "installed" ? installedMcpServers : runtimeCatalogs.mcpServers)
    .slice()
    .sort((left, right) => Number(right.featured) - Number(left.featured) || left.label.localeCompare(right.label, "zh-CN"));

  useEffect(() => {
    setReasoningEffortInput(runtimeSettings.settings.reasoningEffort);
  }, [runtimeSettings.settings.reasoningEffort]);

  async function saveRuntimePreferences() {
    setReasoningNotice(null);
    const result = await runtimeSettings.save({
      reasoningEffort: reasoningEffortInput,
    });
    if (!result.ok) {
      const message = result.error ?? "保存失败";
      setReasoningNotice(message);
    } else {
      setReasoningNotice(`当前推理强度：${formatReasoningEffortLabel(reasoningEffortInput)}`);
    }
  }

  async function handleCloseWindow() {
    try {
      await desktopBridge.closeWindow();
    } catch {
      window.close();
    }
  }

  return (
    <div className="settings-modal">
      <div className="settings-content">
        <header className="settings-content__header" style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div className="window-controls" role="toolbar" aria-label="窗口控制">
            <div className="window-controls__traffic-group">
              <button
                className="window-controls__traffic-button"
                type="button"
                aria-label="关闭窗口"
                title="关闭窗口"
                onClick={() => void handleCloseWindow()}
              >
                <span className="window-controls__traffic-dot window-controls__traffic-dot--close" />
              </button>
            </div>
          </div>
          <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>全局设置</h2>
        </header>

        <div className="settings-content__body">
          {/* ── 权限设置 ── */}
          <h3 className="settings-section-title">权限</h3>
          <div className="settings-panel">
            <div className="settings-panel__heading">
              <span>{runtimeSettings.settings.autoApproveToolRequests ? "工具默认放行" : "工具需要确认"}</span>
            </div>
            <div className="provider-notice">
              {runtimeSettings.settings.autoApproveToolRequests
                ? "工具请求默认自动批准。文件读写和命令只在默认工作区内执行，删除文件会在聊天里单独确认后再执行。"
                : "工具请求会要求确认。文件读写和命令只在默认工作区内执行，删除文件会在聊天里单独确认后再执行。"}
            </div>
            {runtimeSettings.error ? <div className="provider-notice provider-notice--error">{runtimeSettings.error}</div> : null}
            <div className="settings-panel__list">
              <div className="settings-panel__item">
                <strong>工具执行</strong>
                <span>工具请求默认自动批准，普通读写和命令都只在默认工作区内执行。</span>
              </div>
              <div className="settings-panel__item">
                <strong>删除确认</strong>
                <span>删除文件会先通过对话确认后再执行。</span>
              </div>
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
                            void runtimeCatalogs.uninstallMcpServer(server.id);
                            return;
                          }

                          void runtimeCatalogs.installMcpServer(server.id);
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
          <button className="settings-actions__button" onClick={() => void handleCloseWindow()}>
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
    </div>
  );
}
