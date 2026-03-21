import { useState } from "react";
import { useRuntimeCatalogs } from "../shell/useRuntimeCatalogs";
import { useRuntimeSettings } from "../shell/useRuntimeSettings";
import { getDesktopBridge } from "../../platform/desktopBridge";
import type { SandboxPermissionProfile } from "@aliceloop/runtime-core";

export function SettingsPanel() {
  const runtimeCatalogs = useRuntimeCatalogs();
  const runtimeSettings = useRuntimeSettings();
  const desktopBridge = getDesktopBridge();

  const [sandboxProfileInput, setSandboxProfileInput] = useState<SandboxPermissionProfile>("development");
  const [sandboxNotice, setSandboxNotice] = useState<string | null>(null);
  const [mcpView, setMcpView] = useState<"marketplace" | "installed">("marketplace");
  const [mcpNotice, setMcpNotice] = useState<string | null>(null);

  const installedMcpServers = runtimeCatalogs.mcpServers.filter((server) => server.installStatus === "installed");
  const visibleMcpServers = (mcpView === "installed" ? installedMcpServers : runtimeCatalogs.mcpServers)
    .slice()
    .sort((left, right) => Number(right.featured) - Number(left.featured) || left.label.localeCompare(right.label, "zh-CN"));

  async function saveSandboxSettings() {
    setSandboxNotice(null);
    const result = await runtimeSettings.save({ sandboxProfile: sandboxProfileInput });
    if (!result.ok) {
      setSandboxNotice(result.error ?? "保存失败");
    } else {
      setSandboxNotice("保存成功");
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
            onClick={saveSandboxSettings}
            disabled={runtimeSettings.saving}
          >
            {runtimeSettings.saving ? "保存中..." : "保存"}
          </button>
        </footer>
      </div>
    </div>
  );
}
