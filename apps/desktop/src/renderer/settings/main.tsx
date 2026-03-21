import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/app.css";

const navItems = [
  {
    id: "project",
    label: "项目",
    title: "项目",
    description: "当前工作区、项目根目录和桌面集成相关设置会放在这里。",
  },
  {
    id: "providers",
    label: "模型提供商",
    title: "模型提供商",
    description: "接下来这里可以放 provider 列表、启用状态和模型默认项。",
  },
  {
    id: "memory",
    label: "记忆",
    title: "记忆",
    description: "这里预留给全局记忆条目、规则和长期上下文配置。",
  },
  {
    id: "mcp",
    label: "MCP",
    title: "MCP",
    description: "这里预留给 MCP 服务接入、安装状态和连接参数。",
  },
  {
    id: "skills",
    label: "SKILLS",
    title: "SKILLS",
    description: "这里预留给技能列表、启用状态和技能说明。",
  },
] as const;

type SettingsSectionId = (typeof navItems)[number]["id"];

function renderSectionCards(sectionId: SettingsSectionId) {
  switch (sectionId) {
    case "project":
      return [
        ["工作区", "显示当前项目、默认打开位置和关联的本地目录。"],
        ["窗口行为", "预留窗口尺寸、布局偏好和启动方式。"],
      ];
    case "providers":
      return [
        ["Provider 列表", "展示不同模型提供商、默认模型和启用状态。"],
        ["请求策略", "预留超时、重试和默认路由之类的配置。"],
      ];
    case "memory":
      return [
        ["长期记忆", "管理可以跨会话保留的规则、偏好和身份信息。"],
        ["注入策略", "预留记忆参与 prompt 拼装的方式和优先级。"],
      ];
    case "mcp":
      return [
        ["服务目录", "显示已连接的 MCP 服务、来源和 transport 类型。"],
        ["连接参数", "预留启动命令、环境变量和权限范围。"],
      ];
    case "skills":
      return [
        ["技能列表", "查看当前可用技能、来源和启用状态。"],
        ["技能详情", "预留描述、入口说明和调试信息。"],
      ];
    default:
      return [];
  }
}

function SettingsApp() {
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>("project");
  const activeSection = navItems.find((item) => item.id === activeSectionId) ?? navItems[0];
  const sectionCards = renderSectionCards(activeSection.id);

  return (
    <div className="settings-window">
      <aside className="settings-window__sidebar">
        <div className="settings-window__drag-strip" aria-hidden="true" />
        <header className="settings-window__sidebar-header">
          <div className="settings-window__eyebrow">Settings</div>
          <h1>设置</h1>
        </header>
        <nav className="settings-window__nav" aria-label="设置导航">
          <button
            type="button"
            className={`settings-window__nav-item${activeSectionId === "project" ? " settings-window__nav-item--active" : ""}`}
            onClick={() => setActiveSectionId("project")}
          >
            <span className="settings-window__nav-item-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M3.75 7.75a2 2 0 0 1 2-2h4.17l1.72 2.08h6.61a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2z" />
                <path d="M3.75 9.25h16.5" />
              </svg>
            </span>
            <span>项目</span>
          </button>
          <button
            type="button"
            className={`settings-window__nav-item${activeSectionId === "providers" ? " settings-window__nav-item--active" : ""}`}
            onClick={() => setActiveSectionId("providers")}
          >
            <span className="settings-window__nav-item-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M12 4.5V7" />
                <path d="M9 4.5h6" />
                <rect x="4.5" y="7.5" width="15" height="11" rx="2.5" />
                <path d="M8.5 12h.01" />
                <path d="M15.5 12h.01" />
                <path d="M9 15.5h6" />
                <path d="M2.5 10.5v5" />
                <path d="M21.5 10.5v5" />
              </svg>
            </span>
            <span>模型提供商</span>
          </button>
          <button
            type="button"
            className={`settings-window__nav-item${activeSectionId === "memory" ? " settings-window__nav-item--active" : ""}`}
            onClick={() => setActiveSectionId("memory")}
          >
            <span className="settings-window__nav-item-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M10.4 5.2a3.2 3.2 0 0 0-5.7 1.6A3.3 3.3 0 0 0 3 9.7a3.3 3.3 0 0 0 1.8 2.9a3.2 3.2 0 0 0 1.7 5.9c.5 0 .9-.1 1.3-.3a3.2 3.2 0 0 0 2.6 1.3" />
                <path d="M13.6 5.2a3.2 3.2 0 0 1 5.7 1.6A3.3 3.3 0 0 1 21 9.7a3.3 3.3 0 0 1-1.8 2.9a3.2 3.2 0 0 1-1.7 5.9c-.5 0-.9-.1-1.3-.3a3.2 3.2 0 0 1-2.6 1.3" />
                <path d="M12 4.5v15" />
                <path d="M8.8 9.2c1 0 1.8.8 1.8 1.8v.2c0 1 .8 1.8 1.8 1.8" />
                <path d="M15.2 9.2c-1 0-1.8.8-1.8 1.8v.2c0 1-.8 1.8-1.8 1.8" />
              </svg>
            </span>
            <span>记忆</span>
          </button>
          <button
            type="button"
            className={`settings-window__nav-item${activeSectionId === "mcp" ? " settings-window__nav-item--active" : ""}`}
            onClick={() => setActiveSectionId("mcp")}
          >
            <span className="settings-window__nav-item-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M9 3.8v4.1" />
                <path d="M15 3.8v4.1" />
                <path d="M7.5 7.8h9v4.3a4.5 4.5 0 0 1-4.5 4.5h0a4.5 4.5 0 0 1-4.5-4.5z" />
                <path d="M12 16.6v3.6" />
              </svg>
            </span>
            <span>MCP</span>
          </button>
          <button
            type="button"
            className={`settings-window__nav-item${activeSectionId === "skills" ? " settings-window__nav-item--active" : ""}`}
            onClick={() => setActiveSectionId("skills")}
          >
            <span className="settings-window__nav-item-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M9 6.5V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8v.7" />
                <path d="M4.5 9.5A2.5 2.5 0 0 1 7 7h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 19H7a2.5 2.5 0 0 1-2.5-2.5z" />
                <path d="M4.5 12.5h15" />
                <path d="M10 12.5v1.8h4v-1.8" />
              </svg>
            </span>
            <span>SKILLS</span>
          </button>
        </nav>
      </aside>
      <main className="settings-window__content">
        <header className="settings-window__content-header">
          <div>
            <h2>{activeSection.title}</h2>
          </div>
        </header>
        <section className="settings-window__canvas">
          <div className="settings-window__content-grid">
            {sectionCards.map(([title, body]) => (
              <article key={title} className="settings-window__content-card">
                <strong>{title}</strong>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
