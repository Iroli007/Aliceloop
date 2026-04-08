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
  const [permissionModeInput, setPermissionModeInput] = useState<"bypassPermissions" | "auto">("bypassPermissions");
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

  useEffect(() => {
    setPermissionModeInput(runtimeSettings.settings.autoApproveToolRequests ? "bypassPermissions" : "auto");
  }, [runtimeSettings.settings.autoApproveToolRequests]);

  async function saveRuntimePreferences() {
    setReasoningNotice(null);
    const result = await runtimeSettings.save({
      reasoningEffort: reasoningEffortInput,
      autoApproveToolRequests: permissionModeInput === "bypassPermissions",
    });
    if (!result.ok) {
      const message = result.error ?? "保存失败";
      setReasoningNotice(message);
    } else {
      setReasoningNotice(
        `当前权限模式：${permissionModeInput === "bypassPermissions" ? "全绿灯" : "自动裁决"}；推理强度：${formatReasoningEffortLabel(reasoningEffortInput)}`,
      );
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
              <span>{permissionModeInput === "bypassPermissions" ? "全绿灯" : "自动裁决"}</span>
            </div>
            <div className="provider-notice">
              {permissionModeInput === "bypassPermissions"
                ? "工具请求默认直接通过，只有显式 deny 规则会拦住它。"
                : "工具请求默认走自动裁决；显式 ask 规则会弹一次确认，其余请求直接通过。"}
            </div>
            {runtimeSettings.error ? <div className="provider-notice provider-notice--error">{runtimeSettings.error}</div> : null}
            <div className="sandbox-profile-list sandbox-profile-list--compact">
              <button
                type="button"
                className={`sandbox-profile-card sandbox-profile-card--compact${permissionModeInput === "bypassPermissions" ? " sandbox-profile-card--active" : ""}`}
                onClick={() => setPermissionModeInput("bypassPermissions")}
              >
                <strong>全绿灯</strong>
                <span>默认直通，不再单独拦工具。</span>
              </button>
              <button
                type="button"
                className={`sandbox-profile-card sandbox-profile-card--compact${permissionModeInput === "auto" ? " sandbox-profile-card--active" : ""}`}
                onClick={() => setPermissionModeInput("auto")}
              >
                <strong>自动裁决</strong>
                <span>命中 ask 规则时才停一下，其余直接通过。</span>
              </button>
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
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
            <h3 className="settings-section-title" style={{ margin: 0 }}>Skills</h3>
            <button
              className="settings-actions__button"
              onClick={() => window.location.reload()}
              style={{ padding: "6px 12px", fontSize: "13px" }}
            >
              🔄 Refresh
            </button>
          </div>
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
