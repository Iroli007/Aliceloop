import { type ProjectDirectory } from "@aliceloop/runtime-core";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/tokens.css";
import "../src/styles/app.css";
import { getDesktopBridge } from "../src/platform/desktopBridge";

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
type ProjectKind = "workspace" | "temporary";

interface ProjectItem {
  id: string;
  name: string;
  path: string;
  kind: ProjectKind;
  isDefault: boolean;
  sessionCount: number;
}

const showTemporaryDirectoriesStorageKey = "aliceloop-settings-show-temporary";

function readStoredShowTemporaryDirectories() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(showTemporaryDirectoriesStorageKey) === "1";
}

function sortProjectItems(items: ProjectItem[]) {
  return [...items].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "workspace" ? -1 : 1;
    }

    if (left.isDefault !== right.isDefault) {
      return Number(right.isDefault) - Number(left.isDefault);
    }

    return left.name.localeCompare(right.name, "zh-CN");
  });
}

function toProjectItem(project: ProjectDirectory): ProjectItem {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    kind: project.kind,
    isDefault: project.isDefault,
    sessionCount: project.sessionCount,
  };
}

async function readApiErrorCode(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return typeof payload?.error === "string" ? payload.error : undefined;
}

function describeProjectApiError(errorCode?: string) {
  switch (errorCode) {
    case "project_path_required":
      return "项目路径不能为空。";
    case "project_name_required":
      return "项目名称不能为空。";
    case "project_path_already_exists":
      return "这个目录已经在项目列表中了。";
    case "temporary_project_cannot_be_default":
      return "临时目录不能设为默认项目。";
    case "default_workspace_project_required":
      return "至少需要保留一个默认工作区项目。";
    case "project_not_found":
      return "项目不存在，列表已经为你刷新。";
    case "project_in_use":
      return "这个项目还有聊天记录绑定，暂时不能删除。";
    default:
      return errorCode ? `项目操作失败：${errorCode}` : "项目操作失败。";
  }
}

function getErrorMessage(error: unknown, fallbackMessage: string) {
  return error instanceof Error ? error.message : fallbackMessage;
}

async function fetchProjectItems(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/projects`);
  if (!response.ok) {
    throw new Error(describeProjectApiError(await readApiErrorCode(response)));
  }

  const payload = await response.json() as ProjectDirectory[];
  return sortProjectItems(payload.map(toProjectItem));
}

interface UpdateProjectResponse {
  project: ProjectDirectory;
  migratedSessionCount: number;
}

function SectionIcon({
  sectionId,
  className,
}: {
  sectionId: SettingsSectionId;
  className: string;
}) {
  switch (sectionId) {
    case "project":
      return (
        <span className={className} aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M3.75 7.75a2 2 0 0 1 2-2h4.17l1.72 2.08h6.61a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2z" />
            <path d="M3.75 9.25h16.5" />
          </svg>
        </span>
      );
    case "providers":
      return (
        <span className={className} aria-hidden="true">
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
      );
    case "memory":
      return (
        <span className={className} aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M10.4 5.2a3.2 3.2 0 0 0-5.7 1.6A3.3 3.3 0 0 0 3 9.7a3.3 3.3 0 0 0 1.8 2.9a3.2 3.2 0 0 0 1.7 5.9c.5 0 .9-.1 1.3-.3a3.2 3.2 0 0 0 2.6 1.3" />
            <path d="M13.6 5.2a3.2 3.2 0 0 1 5.7 1.6A3.3 3.3 0 0 1 21 9.7a3.3 3.3 0 0 1-1.8 2.9a3.2 3.2 0 0 1-1.7 5.9c-.5 0-.9-.1-1.3-.3a3.2 3.2 0 0 1-2.6 1.3" />
            <path d="M12 4.5v15" />
            <path d="M8.8 9.2c1 0 1.8.8 1.8 1.8v.2c0 1 .8 1.8 1.8 1.8" />
            <path d="M15.2 9.2c-1 0-1.8.8-1.8 1.8v.2c0 1-.8 1.8-1.8 1.8" />
          </svg>
        </span>
      );
    case "mcp":
      return (
        <span className={className} aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M9 3.8v4.1" />
            <path d="M15 3.8v4.1" />
            <path d="M7.5 7.8h9v4.3a4.5 4.5 0 0 1-4.5 4.5h0a4.5 4.5 0 0 1-4.5-4.5z" />
            <path d="M12 16.6v3.6" />
          </svg>
        </span>
      );
    case "skills":
      return (
        <span className={className} aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M9 6.5V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8v.7" />
            <path d="M4.5 9.5A2.5 2.5 0 0 1 7 7h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 19H7a2.5 2.5 0 0 1-2.5-2.5z" />
            <path d="M4.5 12.5h15" />
            <path d="M10 12.5v1.8h4v-1.8" />
          </svg>
        </span>
      );
    default:
      return null;
  }
}

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
  const desktopBridge = useMemo(() => getDesktopBridge(), []);
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>("project");
  const [daemonBaseUrl, setDaemonBaseUrl] = useState<string | null>(null);
  const [projectItems, setProjectItems] = useState<ProjectItem[]>([]);
  const [showTemporaryDirectories, setShowTemporaryDirectories] = useState(() => readStoredShowTemporaryDirectories());
  const [projectStatus, setProjectStatus] = useState<"loading" | "ready" | "error">("loading");
  const [projectPending, setProjectPending] = useState(false);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  const activeSection = navItems.find((item) => item.id === activeSectionId) ?? navItems[0];
  const sectionCards = activeSection.id === "project" ? [] : renderSectionCards(activeSection.id);
  const visibleProjectItems = sortProjectItems(
    projectItems.filter((project) => showTemporaryDirectories || project.kind !== "temporary"),
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(showTemporaryDirectoriesStorageKey, showTemporaryDirectories ? "1" : "0");
  }, [showTemporaryDirectories]);

  async function ensureDaemonBaseUrl() {
    if (daemonBaseUrl) {
      return daemonBaseUrl;
    }

    const { daemonBaseUrl: baseUrl } = await desktopBridge.getAppMeta();
    setDaemonBaseUrl(baseUrl);
    return baseUrl;
  }

  async function refreshProjectItems(baseUrlOverride?: string) {
    const baseUrl = baseUrlOverride ?? await ensureDaemonBaseUrl();
    const nextItems = await fetchProjectItems(baseUrl);
    setProjectItems(nextItems);
    setProjectStatus("ready");
    setProjectError(null);
    return nextItems;
  }

  useEffect(() => {
    let cancelled = false;

    async function loadProjects() {
      try {
        setProjectStatus("loading");
        setProjectNotice(null);
        const { daemonBaseUrl: baseUrl } = await desktopBridge.getAppMeta();
        if (cancelled) {
          return;
        }

        setDaemonBaseUrl(baseUrl);
        const nextItems = await fetchProjectItems(baseUrl);
        if (cancelled) {
          return;
        }

        setProjectItems(nextItems);
        setProjectStatus("ready");
        setProjectError(null);
      } catch (error) {
        if (!cancelled) {
          setProjectStatus("error");
          setProjectError(getErrorMessage(error, "加载项目列表失败。"));
        }
      }
    }

    void loadProjects();

    return () => {
      cancelled = true;
    };
  }, [desktopBridge]);

  async function handleAddProject() {
    const selection = await desktopBridge.openProjectDirectories();
    if (selection.canceled || selection.directories.length === 0) {
      return;
    }

    try {
      const baseUrl = await ensureDaemonBaseUrl();
      let addedCount = 0;
      let duplicatesCount = 0;
      let failureCount = 0;
      let failureMessage: string | null = null;

      setProjectPending(true);
      setProjectNotice(null);
      setProjectError(null);

      for (const directory of selection.directories) {
        const response = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: directory.name,
            path: directory.path,
            kind: "workspace",
          }),
        });

        if (response.ok) {
          addedCount += 1;
          continue;
        }

        const errorCode = await readApiErrorCode(response);
        if (errorCode === "project_path_already_exists") {
          duplicatesCount += 1;
          continue;
        }

        failureCount += 1;
        failureMessage ??= describeProjectApiError(errorCode);
      }

      await refreshProjectItems(baseUrl);

      if (addedCount === 0 && duplicatesCount > 0 && failureCount === 0) {
        setProjectNotice("所选目录已经在列表中了。");
        return;
      }

      const messageParts = [
        addedCount > 0 ? `已添加 ${addedCount} 个项目。` : null,
        duplicatesCount > 0 ? `跳过 ${duplicatesCount} 个重复目录。` : null,
        failureCount > 0 ? (failureMessage ?? `还有 ${failureCount} 个项目添加失败。`) : null,
      ].filter(Boolean);

      setProjectNotice(messageParts.join(" "));
    } catch (error) {
      setProjectError(getErrorMessage(error, "添加项目失败。"));
    } finally {
      setProjectPending(false);
    }
  }

  async function handleOpenProject(project: ProjectItem) {
    const result = await desktopBridge.openPath(project.path);
    if (result.ok) {
      setProjectNotice(`已打开 ${project.name}。`);
      setProjectError(null);
      return;
    }

    setProjectNotice(null);
    setProjectError(result.error ?? "打开目录失败。");
  }

  async function handleSetDefaultProject(projectId: string) {
    try {
      const baseUrl = await ensureDaemonBaseUrl();
      setProjectPending(true);
      setProjectNotice(null);
      setProjectError(null);

      const response = await fetch(`${baseUrl}/api/projects/${projectId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          isDefault: true,
        }),
      });

      if (!response.ok) {
        throw new Error(describeProjectApiError(await readApiErrorCode(response)));
      }

      await refreshProjectItems(baseUrl);
      setProjectNotice("默认项目已更新。");
    } catch (error) {
      setProjectError(getErrorMessage(error, "更新默认项目失败。"));
    } finally {
      setProjectPending(false);
    }
  }

  async function handleRenameProject(projectId: string) {
    const currentProject = projectItems.find((project) => project.id === projectId);
    if (!currentProject) {
      return;
    }

    const nextNameInput = window.prompt("输入新的项目名称", currentProject.name);
    if (nextNameInput === null) {
      return;
    }

    const nextPathInput = window.prompt("输入新的项目路径", currentProject.path);
    if (nextPathInput === null) {
      return;
    }

    const nextName = nextNameInput.trim();
    const nextPath = nextPathInput.trim();
    if (!nextName) {
      setProjectError("项目名称不能为空。");
      return;
    }

    if (!nextPath) {
      setProjectError("项目路径不能为空。");
      return;
    }

    const updateBody: { name?: string; path?: string } = {};
    if (nextName !== currentProject.name) {
      updateBody.name = nextName;
    }

    if (nextPath !== currentProject.path) {
      updateBody.path = nextPath;
    }

    if (Object.keys(updateBody).length === 0) {
      return;
    }

    try {
      const baseUrl = await ensureDaemonBaseUrl();
      setProjectPending(true);
      setProjectNotice(null);
      setProjectError(null);

      const response = await fetch(`${baseUrl}/api/projects/${projectId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updateBody),
      });

      if (!response.ok) {
        throw new Error(describeProjectApiError(await readApiErrorCode(response)));
      }

      const result = await response.json() as UpdateProjectResponse;
      await refreshProjectItems(baseUrl);

      if (updateBody.path && result.migratedSessionCount > 0) {
        setProjectNotice(`已更新 ${result.project.name}，并迁移 ${result.migratedSessionCount} 个会话记录。`);
        return;
      }

      if (result.migratedSessionCount > 0) {
        setProjectNotice(`已更新 ${result.project.name}，并同步 ${result.migratedSessionCount} 个会话记录。`);
        return;
      }

      setProjectNotice(`已更新 ${result.project.name}。`);
    } catch (error) {
      setProjectError(getErrorMessage(error, "更新项目失败。"));
    } finally {
      setProjectPending(false);
    }
  }

  async function handleRemoveProject(projectId: string) {
    const currentProject = projectItems.find((project) => project.id === projectId);
    if (!currentProject) {
      return;
    }

    const shouldRemove = window.confirm(`删除项目“${currentProject.name}”？`);
    if (!shouldRemove) {
      return;
    }

    try {
      const baseUrl = await ensureDaemonBaseUrl();
      setProjectPending(true);
      setProjectNotice(null);
      setProjectError(null);

      const response = await fetch(`${baseUrl}/api/projects/${projectId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(describeProjectApiError(await readApiErrorCode(response)));
      }

      await refreshProjectItems(baseUrl);
      setProjectNotice(`已移除 ${currentProject.name}。`);
    } catch (error) {
      setProjectError(getErrorMessage(error, "删除项目失败。"));
    } finally {
      setProjectPending(false);
    }
  }

  return (
    <div className="settings-window">
      <aside className="settings-window__sidebar">
        <div className="settings-window__drag-strip" aria-hidden="true" />
        <header className="settings-window__sidebar-header">
          <div className="settings-window__eyebrow">Settings</div>
          <h1>设置</h1>
        </header>
        <nav className="settings-window__nav" aria-label="设置导航">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-window__nav-item${activeSectionId === item.id ? " settings-window__nav-item--active" : ""}`}
              onClick={() => setActiveSectionId(item.id)}
            >
              <SectionIcon sectionId={item.id} className="settings-window__nav-item-icon" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="settings-window__content">
        <header className="settings-window__content-header">
          <div className="settings-window__content-heading">
            <SectionIcon sectionId={activeSection.id} className="settings-window__content-icon" />
            <h2>{activeSection.title}</h2>
          </div>
          {activeSection.id === "project" ? null : (
            <p className="settings-window__content-copy">{activeSection.description}</p>
          )}
        </header>
        <section className="settings-window__canvas">
          {activeSection.id === "project" ? (
            <article className="settings-project">
              <div className="settings-project__panel">
                <div className="settings-project__header">
                  <div className="settings-project__intro">
                    <h3>项目</h3>
                    <p>新对话将自动使用此目录，而不是创建临时目录</p>
                  </div>
                  <div className="settings-project__controls">
                    <div className="settings-project__toggle-row">
                      <button
                        type="button"
                        className={`settings-project__toggle${showTemporaryDirectories ? " settings-project__toggle--on" : ""}`}
                        aria-pressed={showTemporaryDirectories}
                        aria-label="显示临时目录"
                        onClick={() => setShowTemporaryDirectories((current) => !current)}
                      />
                      <span>显示临时目录</span>
                    </div>
                    <button
                      type="button"
                      className="settings-project__add-button"
                      disabled={projectPending || projectStatus === "loading"}
                      onClick={() => void handleAddProject()}
                    >
                      <span className="settings-project__add-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                          <path d="M12 5v14" />
                          <path d="M5 12h14" />
                        </svg>
                      </span>
                      <span>添加项目</span>
                    </button>
                  </div>
                </div>

                {projectNotice ? <div className="settings-project__notice">{projectNotice}</div> : null}
                {projectError && projectStatus !== "error" ? (
                  <div className="settings-project__notice settings-project__notice--error">{projectError}</div>
                ) : null}

                <div className="settings-project__list">
                  {projectStatus === "loading" ? (
                    <div className="settings-project__empty">
                      <strong>正在加载项目目录</strong>
                      <p>项目列表会从 daemon 后端读取，稍等一下就好。</p>
                    </div>
                  ) : projectStatus === "error" ? (
                    <div className="settings-project__empty">
                      <strong>项目列表加载失败</strong>
                      <p>{projectError ?? "暂时还拿不到后端项目数据。"}</p>
                      <button
                        type="button"
                        className="settings-project__empty-action"
                        onClick={() => {
                          void (async () => {
                            try {
                              setProjectStatus("loading");
                              setProjectNotice(null);
                              setProjectError(null);
                              await refreshProjectItems();
                            } catch (error) {
                              setProjectStatus("error");
                              setProjectError(getErrorMessage(error, "重新加载项目失败。"));
                            }
                          })();
                        }}
                      >
                        重新加载
                      </button>
                    </div>
                  ) : visibleProjectItems.length > 0 ? (
                    visibleProjectItems.map((project) => (
                      <article key={project.id} className="settings-project__item">
                        <div className="settings-project__item-main">
                          <span className="settings-project__item-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                              <path d="M3.75 7.75a2 2 0 0 1 2-2h4.17l1.72 2.08h6.61a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2z" />
                              <path d="M3.75 9.25h16.5" />
                            </svg>
                          </span>
                          <div className="settings-project__item-copy">
                            <div className="settings-project__item-title-row">
                              <strong>{project.name}</strong>
                              {project.isDefault ? <span className="settings-project__badge">默认</span> : null}
                              {project.kind === "temporary" ? (
                                <span className="settings-project__badge settings-project__badge--muted">临时</span>
                              ) : null}
                              {project.sessionCount > 0 ? (
                                <span className="settings-project__badge settings-project__badge--muted">
                                  {project.sessionCount} 个会话
                                </span>
                              ) : null}
                            </div>
                            <span>{project.path}</span>
                          </div>
                        </div>
                        <div className="settings-project__item-actions">
                          <button
                            type="button"
                            className={`settings-project__icon-button${project.isDefault ? " settings-project__icon-button--active" : ""}`}
                            aria-label={
                              project.kind === "temporary"
                                ? "临时目录不可设为默认"
                                : project.isDefault
                                  ? "默认项目"
                                  : "设为默认项目"
                            }
                            title={
                              project.kind === "temporary"
                                ? "临时目录不可设为默认"
                                : project.isDefault
                                  ? "默认项目"
                                  : "设为默认项目"
                            }
                            disabled={projectPending || project.kind === "temporary"}
                            onClick={() => void handleSetDefaultProject(project.id)}
                          >
                            <svg viewBox="0 0 24 24">
                              <path d="m12 3.8 2.53 5.13 5.66.82-4.1 4 1 5.64L12 16.7l-5.09 2.69 1-5.64-4.1-4 5.66-.82Z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="settings-project__icon-button"
                            aria-label="打开目录"
                            title="打开目录"
                            disabled={projectPending}
                            onClick={() => void handleOpenProject(project)}
                          >
                            <svg viewBox="0 0 24 24">
                              <path d="M3.75 7.75a2 2 0 0 1 2-2h4.17l1.72 2.08h6.61a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2z" />
                              <path d="M3.75 9.25h16.5" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="settings-project__icon-button"
                            aria-label="编辑项目"
                            title="编辑项目"
                            disabled={projectPending}
                            onClick={() => void handleRenameProject(project.id)}
                          >
                            <svg viewBox="0 0 24 24">
                              <path d="m4.5 16.2 8.95-8.95a2.1 2.1 0 0 1 2.97 0l.33.33a2.1 2.1 0 0 1 0 2.97L7.8 19.5 4.5 20.2Z" />
                              <path d="m12.9 7.8 3.3 3.3" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="settings-project__icon-button settings-project__icon-button--danger"
                            aria-label="删除项目"
                            title="删除项目"
                            disabled={projectPending}
                            onClick={() => void handleRemoveProject(project.id)}
                          >
                            <svg viewBox="0 0 24 24">
                              <path d="M9 4.8h6" />
                              <path d="M5.8 7.5h12.4" />
                              <path d="M8.2 7.5v10a1.7 1.7 0 0 0 1.7 1.7h4.2a1.7 1.7 0 0 0 1.7-1.7v-10" />
                              <path d="M10.2 10.2v5.6" />
                              <path d="M13.8 10.2v5.6" />
                            </svg>
                          </button>
                        </div>
                      </article>
                    ))
                  ) : (
                    <div className="settings-project__empty">
                      <strong>还没有可显示的项目目录</strong>
                      <p>先添加一个项目目录，或者打开“显示临时目录”查看临时工作区。</p>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ) : (
            <div className="settings-window__content-grid">
              {sectionCards.map(([title, body]) => (
                <article key={title} className="settings-window__content-card">
                  <strong>{title}</strong>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          )}
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
