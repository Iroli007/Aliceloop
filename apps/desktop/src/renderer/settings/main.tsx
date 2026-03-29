import { type MemoryEmbeddingModel, type ProjectDirectory, type ProviderKind, type ProviderTransportKind } from "@aliceloop/runtime-core";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/tokens.css";
import "../src/styles/app.css";
import { getDesktopBridge } from "../src/platform/desktopBridge";
import { useMemoryConfig } from "../src/features/memory/useMemoryConfig";
import { useProviderConfigs } from "../src/features/providers/useProviderConfigs";
import { useRuntimeSettings } from "../src/features/shell/useRuntimeSettings";

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
    title: "全局模型提供商",
    description: "这里是全局 provider 配置，会同步影响主入口和各会话的默认模型路由。",
  },
  {
    id: "relay",
    label: "网络机器人",
    title: "网络机器人",
    description: "看 Google Chrome 有没有连上，只信任本机 relay。",
  },
  {
    id: "memory",
    label: "记忆",
    title: "记忆",
    description: "这里预留给全局记忆条目、规则和长期上下文配置。",
  },
  {
    id: "skills",
    label: "SKILLS",
    title: "SKILLS",
    description: "这里预留给技能列表、启用状态和技能说明。",
  },
] as const;

type SettingsSectionId = (typeof navItems)[number]["id"];
type ProjectKind = "workspace";

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
  minimax: "MiniMax 默认走 Anthropic-compatible 接口，也可以接兼容该格式的第三方中转站。",
  gemini: "Google Gemini 默认走 OpenAI-compatible 接口，官方兼容端点是 v1beta/openai。",
  moonshot: "Kimi / Moonshot 默认走 OpenAI-compatible 接口。",
  deepseek: "DeepSeek 默认走 OpenAI-compatible 接口。",
  zhipu: "智谱 GLM 默认走 OpenAI-compatible 接口。",
  aihubmix: "AIHubMix 适合做多模型聚合和第三方中转站入口。",
  openai: "官方 OpenAI，也可以接任意 OpenAI-compatible 中转站。",
  anthropic: "Claude 官方直连入口，也可以接任意 Anthropic-compatible 中转站。",
  openrouter: "OpenRouter 聚合多家模型，默认走 OpenAI-compatible 接口。",
};

const desktopDeviceStorageKey = "aliceloop-desktop-device-id";
const HEARTBEAT_INTERVAL_MS = 10_000;

const embeddingModelDefinitions: Array<{
  id: MemoryEmbeddingModel;
  label: string;
  dimension: number;
}> = [
  {
    id: "text-embedding-3-small",
    label: "text-embedding-3-small",
    dimension: 1536,
  },
  {
    id: "text-embedding-3-large",
    label: "text-embedding-3-large",
    dimension: 3072,
  },
];

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

interface ProjectItem {
  id: string;
  name: string;
  path: string;
  kind: ProjectKind;
  isDefault: boolean;
  sessionCount: number;
}

interface SkillItem {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
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

function getStableDesktopDeviceId() {
  if (typeof window === "undefined") {
    return "desktop-server";
  }

  const existing = window.localStorage.getItem(desktopDeviceStorageKey);
  if (existing) {
    return existing;
  }

  const next = `desktop-${crypto.randomUUID()}`;
  window.localStorage.setItem(desktopDeviceStorageKey, next);
  return next;
}

function formatSimilarityPercent(value: number) {
  return `${Math.round(value * 100)}%`;
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

type RelayBrowserStackState = {
  preferredBackend: "opencli" | "pinchtab" | "desktop_chrome" | "none";
  relay: {
    bridgeRelay: {
      enabled: boolean;
      baseUrl: string;
      healthy: boolean;
    } | null;
    bridgeAttachedTabs: number;
    runtimeRelay: {
      enabled: boolean;
      baseUrl: string;
      healthy: boolean;
    } | null;
    runtimeAttachedTabs: number;
  };
};

function StatusDot({ healthy }: { healthy: boolean }) {
  return <span className={`chrome-relay__status-dot${healthy ? " chrome-relay__status-dot--healthy" : ""}`} aria-hidden="true" />;
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
    case "relay":
      return (
        <span className={className} aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="7.5" />
            <path d="M12 4.5v15" />
            <path d="M4.5 12h15" />
            <path d="M6.5 7.5c1.6 1 3.5 1.6 5.5 1.6s3.9-.6 5.5-1.6" />
            <path d="M6.5 16.5c1.6-1 3.5-1.6 5.5-1.6s3.9.6 5.5 1.6" />
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
    case "relay":
      return [
        ["Google Chrome 连接", "这里只看扩展桥有没有连上。"],
        ["本机信任", "只接受 127.0.0.1 上的 relay，不再额外配置认证信息。"],
      ];
    case "memory":
      return [
        ["长期记忆", "管理可以跨会话保留的规则、偏好和身份信息。"],
        ["注入策略", "预留记忆参与 prompt 拼装的方式和优先级。"],
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
  const providerState = useProviderConfigs();
  const runtimeSettings = useRuntimeSettings();
  const memoryConfig = useMemoryConfig();
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>("project");
  const [daemonBaseUrl, setDaemonBaseUrl] = useState<string | null>(null);
  const [projectItems, setProjectItems] = useState<ProjectItem[]>([]);
  const [projectStatus, setProjectStatus] = useState<"loading" | "ready" | "error">("loading");
  const [projectPending, setProjectPending] = useState(false);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [activeProviderId, setActiveProviderId] = useState("");
  const [providerApiKeyInput, setProviderApiKeyInput] = useState("");
  const [providerBaseUrlInput, setProviderBaseUrlInput] = useState("");
  const [providerModelInput, setProviderModelInput] = useState("");
  const [providerEnabled, setProviderEnabled] = useState(false);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);
  const [providerSearchQuery, setProviderSearchQuery] = useState("");
  const [toolProviderIdInput, setToolProviderIdInput] = useState<ProviderKind | "">("");
  const [toolModelInput, setToolModelInput] = useState("");
  const [toolModelNotice, setToolModelNotice] = useState<string | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayBrowserStackState | null>(null);
  const [relayStatusPending, setRelayStatusPending] = useState(false);
  const [relayNotice, setRelayNotice] = useState<string | null>(null);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [memoryEnabledInput, setMemoryEnabledInput] = useState(true);
  const [memoryAutoRetrievalInput, setMemoryAutoRetrievalInput] = useState(true);
  const [memoryQueryRewriteInput, setMemoryQueryRewriteInput] = useState(false);
  const [memoryAutoSummarizeInput, setMemoryAutoSummarizeInput] = useState(true);
  const [memoryMaxRetrievalInput, setMemoryMaxRetrievalInput] = useState(8);
  const [memorySimilarityThresholdInput, setMemorySimilarityThresholdInput] = useState(0.7);
  const [memoryEmbeddingModelInput, setMemoryEmbeddingModelInput] = useState<MemoryEmbeddingModel>("text-embedding-3-small");
  const [skillItems, setSkillItems] = useState<SkillItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);

  const activeSection = navItems.find((item) => item.id === activeSectionId) ?? navItems[0];
  const sectionCards = activeSection.id === "project" ? [] : renderSectionCards(activeSection.id);
  const visibleProjectItems = sortProjectItems(projectItems);
  const providers = providerState.providers;
  const filteredProviders = providers.filter((provider) => {
    const query = providerSearchQuery.trim().toLowerCase();
    if (!query) {
      return true;
    }

    return provider.label.toLowerCase().includes(query)
      || provider.id.toLowerCase().includes(query)
      || formatProviderTransportLabel(provider.transport).toLowerCase().includes(query);
  });
  const activeProvider = filteredProviders.find((provider) => provider.id === activeProviderId)
    ?? providers.find((provider) => provider.id === activeProviderId)
    ?? filteredProviders[0]
    ?? providers[0]
    ?? null;
  const activeProviderModelCatalog = activeProvider
    ? providerState.modelCatalogs[activeProvider.id]
    : undefined;

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

  async function fetchRelayStatus(baseUrlOverride?: string) {
    const baseUrl = baseUrlOverride ?? await ensureDaemonBaseUrl();
    const response = await fetch(`${baseUrl}/api/runtime/browser-relay/status`);
    if (!response.ok) {
      throw new Error(`读取 Chrome Relay 状态失败（${response.status}）`);
    }

    const payload = await response.json() as RelayBrowserStackState;
    setRelayStatus(payload);
    return payload;
  }

  async function loadSkills() {
    setSkillsLoading(true);
    try {
      const baseUrl = await ensureDaemonBaseUrl();
      const response = await fetch(`${baseUrl}/api/skills`);
      if (response.ok) {
        const skills = await response.json() as Array<{ name: string; label: string; description: string; status: string }>;
        setSkillItems(skills.map(s => ({
          name: s.name,
          label: s.label,
          description: s.description,
          enabled: s.status === 'available'
        })));
      }
    } catch {
      // 忽略错误
    } finally {
      setSkillsLoading(false);
    }
  }

  async function toggleSkill(skillName: string, enabled: boolean) {
    setSkillItems(prev => prev.map(s => s.name === skillName ? { ...s, enabled } : s));
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

  useEffect(() => {
    if (activeSectionId === 'skills' && skillItems.length === 0 && !skillsLoading) {
      void loadSkills();
    }
  }, [activeSectionId]);

  useEffect(() => {
    if (!daemonBaseUrl) {
      return;
    }

    const deviceId = getStableDesktopDeviceId();
    const label = desktopBridge.mode === "electron" ? "Aliceloop Desktop" : "Aliceloop Web Preview";

    const heartbeat = async () => {
      try {
        const meta = await desktopBridge.getAppMeta();
        await fetch(`${daemonBaseUrl}/api/runtime/presence/heartbeat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            deviceId,
            deviceType: "desktop",
            label,
            capabilities: meta.desktopCapabilities,
          }),
        });
      } catch {
        // Keep settings usable even when daemon heartbeat fails.
      }
    };

    void heartbeat();
    const timer = window.setInterval(() => {
      void heartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [daemonBaseUrl, desktopBridge]);

  useEffect(() => {
    if (activeSectionId !== "relay") {
      return;
    }

    let cancelled = false;

    const syncRelayStatus = async () => {
      try {
        const next = await fetchRelayStatus();
        if (cancelled) {
          return;
        }
        setRelayStatus(next);
      } catch (error) {
        if (!cancelled) {
          setRelayNotice(getErrorMessage(error, "读取 Chrome Relay 状态失败。"));
        }
      } finally {
        if (!cancelled) {
          setRelayStatusPending(false);
        }
      }
    };

    setRelayStatusPending(true);
    void syncRelayStatus();
    const timer = window.setInterval(() => {
      void syncRelayStatus();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeSectionId]);

  useEffect(() => {
    if (providers.length === 0) {
      return;
    }

    if (!providers.some((provider) => provider.id === activeProviderId)) {
      setActiveProviderId(providers[0].id);
    }
  }, [activeProviderId, providers]);

  useEffect(() => {
    if (!activeProvider) {
      return;
    }

    setProviderBaseUrlInput(activeProvider.baseUrl);
    setProviderModelInput(activeProvider.model);
    setProviderEnabled(activeProvider.enabled);
  }, [activeProvider]);

  useEffect(() => {
    setToolProviderIdInput(runtimeSettings.settings.toolProviderId ?? "");
    setToolModelInput(runtimeSettings.settings.toolModel ?? "");
  }, [runtimeSettings.settings.toolModel, runtimeSettings.settings.toolProviderId]);

  useEffect(() => {
    setMemoryEnabledInput(memoryConfig.config.enabled);
    setMemoryAutoRetrievalInput(memoryConfig.config.autoRetrieval);
    setMemoryQueryRewriteInput(memoryConfig.config.queryRewrite);
    setMemoryAutoSummarizeInput(memoryConfig.config.autoSummarize);
    setMemoryMaxRetrievalInput(memoryConfig.config.maxRetrievalCount);
    setMemorySimilarityThresholdInput(memoryConfig.config.similarityThreshold);
    setMemoryEmbeddingModelInput(memoryConfig.config.embeddingModel);
  }, [memoryConfig.config]);

  async function handleBrowseProject(project: ProjectItem) {
    const result = await desktopBridge.openPath(project.path);
    if (result.ok) {
      setProjectNotice(`已在访达中打开 ${project.name}。`);
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

  async function handleRefreshRelayStatus() {
    try {
      setRelayStatusPending(true);
      setRelayNotice(null);
      await fetchRelayStatus();
    } catch (error) {
      setRelayNotice(getErrorMessage(error, "刷新 Chrome Relay 状态失败。"));
    } finally {
      setRelayStatusPending(false);
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

  async function handleSaveProvider() {
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
      setProviderNotice(result.error ?? `保存 ${activeProvider.label} 配置失败。`);
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
        setProviderNotice(`${result.config?.label ?? activeProvider.label} 已保存，但其他已启用 provider 没有全部关闭。`);
        return;
      }
    }

    setProviderApiKeyInput("");
    setProviderNotice(`${result.config?.label ?? activeProvider.label} 已保存。`);
  }

  async function handleFetchProviderModels() {
    if (!activeProvider) {
      return;
    }

    const result = await providerState.fetchModels(activeProvider.id);
    if (!result.ok) {
      setProviderNotice(result.error ?? `抓取 ${activeProvider.label} 模型列表失败。`);
      return;
    }

    setProviderNotice(`已抓取 ${activeProvider.label} 的 ${result.models?.length ?? 0} 个模型。`);
  }

  async function handleRecommendToolModel() {
    if (!activeProvider) {
      return;
    }

    const existingCatalog = providerState.modelCatalogs[activeProvider.id];
    const catalog = existingCatalog ?? await (async () => {
      const result = await providerState.fetchModels(activeProvider.id);
      if (!result.ok) {
        setProviderNotice(result.error ?? `抓取 ${activeProvider.label} 模型列表失败。`);
        return null;
      }

      return {
        models: result.models ?? [],
        recommendedToolModel: result.recommendedToolModel ?? null,
      };
    })();

    if (!catalog?.recommendedToolModel) {
      setProviderNotice(`${activeProvider.label} 暂时没有可推荐的 Tool Model。`);
      return;
    }

    setToolProviderIdInput(activeProvider.id);
    setToolModelInput(catalog.recommendedToolModel);
    setToolModelNotice(`已为 Tool Model 推荐 ${activeProvider.label} · ${catalog.recommendedToolModel}。记得点保存。`);
  }

  async function handleSaveToolModel() {
    const result = await runtimeSettings.save({
      toolProviderId: toolProviderIdInput || null,
      toolModel: toolModelInput.trim() || null,
    });

    if (!result.ok) {
      setToolModelNotice(result.error ?? "保存 Tool Model 失败。");
      return;
    }

    setToolModelNotice(toolProviderIdInput && toolModelInput.trim()
      ? `Tool Model 已保存为 ${toolProviderIdInput} · ${toolModelInput.trim()}。`
      : "Tool Model 已恢复为自动跟随默认路由。");
  }

  async function handleSaveMemoryConfig() {
    const selectedEmbeddingDefinition = embeddingModelDefinitions.find((item) => item.id === memoryEmbeddingModelInput);
    const result = await memoryConfig.save({
      enabled: memoryEnabledInput,
      autoRetrieval: memoryAutoRetrievalInput,
      queryRewrite: memoryQueryRewriteInput,
      autoSummarize: memoryAutoSummarizeInput,
      maxRetrievalCount: memoryMaxRetrievalInput,
      similarityThreshold: memorySimilarityThresholdInput,
      embeddingModel: memoryEmbeddingModelInput,
      embeddingDimension: selectedEmbeddingDefinition?.dimension,
    });

    if (!result.ok) {
      setMemoryNotice(result.error ?? "保存记忆配置失败。");
      return;
    }

    setMemoryNotice("记忆配置已保存。");
  }

  async function handleRebuildEmbeddings() {
    const result = await memoryConfig.rebuild();
    setMemoryNotice(result.ok ? "向量索引重建已开始。" : (result.error ?? "重建向量索引失败。"));
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
                          aria-label={project.isDefault ? "默认项目" : "设为默认项目"}
                          title={project.isDefault ? "默认项目" : "设为默认项目"}
                          disabled={projectPending}
                          onClick={() => void handleSetDefaultProject(project.id)}
                        >
                          <svg viewBox="0 0 24 24">
                            <path d="m12 3.8 2.53 5.13 5.66.82-4.1 4 1 5.64L12 16.7l-5.09 2.69 1-5.64-4.1-4 5.66-.82Z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="settings-project__icon-button"
                          aria-label="浏览目录"
                          title="浏览目录"
                          disabled={projectPending}
                          onClick={() => void handleBrowseProject(project)}
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
                    <p>暂时没有项目目录。</p>
                  </div>
                )}
              </div>
            </article>
          ) : activeSection.id === "relay" ? (
            <article className="settings-relay">
              <div className="settings-relay__panel">
                <div className="settings-relay__header">
                  <div className="settings-relay__intro">
                    <p>这里直接显示 Google Chrome 扩展有没有连接，以及当前 relay 状态。</p>
                  </div>
                </div>

                <div className="settings-relay__cards">
                  {sectionCards.map(([title, body], index) => (
                    <article key={title} className="settings-window__content-card settings-relay__card">
                      <span className="settings-relay__step-index">{String(index + 1).padStart(2, "0")}</span>
                      <strong>{title}</strong>
                      <p>{body}</p>
                    </article>
                  ))}
                </div>

                <div className="settings-panel__item chrome-relay__card">
                  <div className="settings-panel__heading">
                    <span>连接状态</span>
                  </div>
                  <div className="chrome-relay__status-grid">
                    <span>Google Chrome 扩展</span>
                    <strong className="chrome-relay__status-value">
                      <StatusDot healthy={Boolean(relayStatus?.relay.bridgeRelay?.healthy)} />
                      {relayStatus?.relay.bridgeRelay?.healthy ? "已连接" : "未连接"}
                    </strong>
                    <span>扩展桥地址</span>
                    <strong>{relayStatus?.relay.bridgeRelay?.baseUrl ?? "http://127.0.0.1:23001"}</strong>
                    <span>Relay 服务</span>
                    <strong className="chrome-relay__status-value">
                      <StatusDot healthy={Boolean(relayStatus?.relay.runtimeRelay?.healthy)} />
                      {relayStatus?.relay.runtimeRelay?.healthy ? "运行中" : "未启动"}
                    </strong>
                  </div>
                  {relayNotice ? <div className="provider-notice">{relayNotice}</div> : null}
                </div>

                <div className="chrome-relay__launch-row">
                  <button className="settings-actions__button" type="button" onClick={() => void handleRefreshRelayStatus()}>
                    {relayStatusPending ? "刷新中..." : "刷新"}
                  </button>
                </div>

                <p className="settings-relay__footnote">绿色表示 Google Chrome 扩展已经连上；灰色表示还没连上。</p>
              </div>
            </article>
          ) : activeSection.id === "providers" ? (
            <article className="settings-providers settings-providers--window">
              <div className="settings-providers__body settings-providers__body--window">
                <aside className="settings-providers__sidebar">
                  <div className="settings-providers__sidebar-top">
                    <label className="settings-search settings-search--providers">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                        <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                      <input
                        className="settings-search__input"
                        type="text"
                        value={providerSearchQuery}
                        onChange={(event) => setProviderSearchQuery(event.target.value)}
                        placeholder="搜索 providers..."
                      />
                    </label>
                    <div className="settings-providers__sidebar-copy">
                      <strong>Providers</strong>
                      <span>{filteredProviders.length} 个可配置入口</span>
                    </div>
                  </div>

                  <div className="provider-list provider-list--sidebar">
                    {filteredProviders.length > 0 ? filteredProviders.map((provider) => (
                      <button
                        key={provider.id}
                        type="button"
                        className={`provider-list__item provider-list__item--sidebar${provider.id === activeProvider?.id ? " provider-list__item--active" : ""}`}
                        onClick={() => {
                          setActiveProviderId(provider.id);
                          setProviderNotice(null);
                        }}
                      >
                        <div className="provider-list__identity">
                          <span className="provider-list__logo" aria-hidden="true">
                            {providerMonograms[provider.id] ?? provider.label.slice(0, 2).toUpperCase()}
                          </span>
                          <div className="provider-list__copy">
                            <div className="provider-list__title-row">
                              <div className="provider-list__name">{provider.label}</div>
                            </div>
                            <div className="provider-list__subtitle">{formatProviderTransportLabel(provider.transport)}</div>
                          </div>
                        </div>
                        <span className={`provider-list__status${provider.enabled ? " provider-list__status--active" : ""}`} />
                      </button>
                    )) : (
                      <div className="provider-list__empty">
                        <strong>没有匹配的 provider</strong>
                        <span>换个关键词试试。</span>
                      </div>
                    )}
                  </div>
                </aside>

                {activeProvider ? (
                  <section className="provider-detail provider-detail--window">
                    <header className="provider-detail__hero">
                      <div className="provider-detail__hero-main">
                        <div className="provider-detail__hero-top">
                          <div className="provider-detail__icon provider-detail__icon--lg" aria-hidden="true">
                            {providerMonograms[activeProvider.id] ?? activeProvider.label.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="provider-detail__hero-copy">
                            <div className="provider-detail__hero-heading">
                              <h3>{activeProvider.label}</h3>
                              <span className={`provider-detail__hero-badge${providerEnabled ? " provider-detail__hero-badge--active" : ""}`}>
                                {providerEnabled ? "Active" : "Inactive"}
                              </span>
                            </div>
                            <p>{providerDescriptions[activeProvider.id] ?? "支持自定义 Base URL、模型和 API Key。"}</p>
                          </div>
                        </div>
                        <div className="provider-detail__meta">
                          <div className="provider-field">
                            <label>当前协议</label>
                            <div className="provider-field__box provider-field__box--input">{formatProviderTransportLabel(activeProvider.transport)}</div>
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        className={`provider-detail__toggle${providerEnabled ? " provider-detail__toggle--on" : ""}`}
                        aria-label={providerEnabled ? "停用当前 provider" : "启用当前 provider"}
                        title={providerEnabled ? "停用当前 provider" : "启用当前 provider"}
                        onClick={() => setProviderEnabled((current) => !current)}
                      />
                    </header>

                    <div className="provider-detail__stack">
                      {providerState.error ? <div className="provider-notice provider-notice--error">{providerState.error}</div> : null}
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

                      <div className="provider-inline-actions">
                        <button
                          type="button"
                          className="settings-actions__button"
                          onClick={() => void handleFetchProviderModels()}
                          disabled={providerState.loadingModelsProviderId !== null}
                        >
                          {providerState.loadingModelsProviderId === activeProvider.id ? "抓取中..." : "自动抓取模型"}
                        </button>
                        <button
                          type="button"
                          className="settings-actions__button"
                          onClick={() => void handleRecommendToolModel()}
                          disabled={providerState.loadingModelsProviderId !== null}
                        >
                          推荐 Tool Model
                        </button>
                      </div>

                      {activeProviderModelCatalog?.models.length ? (
                        <div className="provider-field">
                          <label>已抓取模型</label>
                          <select
                            className="provider-field__input"
                            value={providerModelInput}
                            onChange={(event) => setProviderModelInput(event.target.value)}
                          >
                            <option value="">选择一个模型...</option>
                            {activeProviderModelCatalog.models.map((modelId) => (
                              <option key={modelId} value={modelId}>
                                {modelId}
                              </option>
                            ))}
                          </select>
                          {activeProviderModelCatalog.recommendedToolModel ? (
                            <div className="provider-field__hint">
                              推荐 Tool Model：{activeProviderModelCatalog.recommendedToolModel}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <div className="provider-actions provider-actions--window">
                      <button
                        type="button"
                        className="settings-actions__button"
                        onClick={() => {
                          if (!activeProvider) {
                            return;
                          }
                          setProviderApiKeyInput("");
                          setProviderBaseUrlInput(activeProvider.baseUrl);
                          setProviderModelInput(activeProvider.model);
                          setProviderEnabled(activeProvider.enabled);
                          setProviderNotice(null);
                        }}
                        disabled={providerState.savingProviderId !== null}
                      >
                        重置
                      </button>
                      <button
                        type="button"
                        className="settings-actions__button settings-actions__button--primary"
                        onClick={() => void handleSaveProvider()}
                        disabled={providerState.savingProviderId !== null}
                      >
                        {providerState.savingProviderId === activeProvider.id ? "保存中..." : "保存 Provider"}
                      </button>
                    </div>
                  </section>
                ) : (
                  <section className="provider-detail provider-detail--window">
                    <div className="provider-list__empty">
                      <strong>当前还没有可编辑的 provider</strong>
                      <span>等 provider 列表加载完成后再试。</span>
                    </div>
                  </section>
                )}
              </div>
            </article>
          ) : activeSection.id === "memory" ? (
            <article className="settings-memory">
              <div className="settings-memory__stack">
                <section className="settings-memory__card">
                  <div className="settings-memory__card-header">
                    <div>
                      <h3>工具模型</h3>
                      <p>给查询重写、技能路由和记忆提炼单独指定一个更快的小模型，不再默认复用主聊天模型。</p>
                    </div>
                  </div>

                  {toolModelNotice ? <div className="provider-notice">{toolModelNotice}</div> : null}
                  {runtimeSettings.error ? <div className="provider-notice provider-notice--error">{runtimeSettings.error}</div> : null}

                  <div className="settings-memory__grid">
                    <div className="provider-field">
                      <label>Provider</label>
                      <select
                        className="provider-field__input"
                        value={toolProviderIdInput}
                        onChange={(event) => setToolProviderIdInput(event.target.value as ProviderKind | "")}
                      >
                        <option value="">自动选择</option>
                        {providers.filter((provider) => provider.hasApiKey).map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="provider-field">
                      <label>Tool Model</label>
                      <input
                        className="provider-field__input"
                        type="text"
                        value={toolModelInput}
                        placeholder="留空则按默认路由自动选择"
                        onChange={(event) => setToolModelInput(event.target.value)}
                      />
                    </div>
                  </div>

                  <div className="provider-actions">
                    <button
                      type="button"
                      className="settings-actions__button"
                      onClick={() => {
                        setToolProviderIdInput(runtimeSettings.settings.toolProviderId ?? "");
                        setToolModelInput(runtimeSettings.settings.toolModel ?? "");
                        setToolModelNotice(null);
                      }}
                      disabled={runtimeSettings.saving}
                    >
                      重置
                    </button>
                    <button
                      type="button"
                      className="settings-actions__button settings-actions__button--primary"
                      onClick={() => void handleSaveToolModel()}
                      disabled={runtimeSettings.saving}
                    >
                      {runtimeSettings.saving ? "保存中..." : "保存 Tool Model"}
                    </button>
                  </div>
                </section>

                <section className="settings-memory__card">
                  <div className="settings-memory__card-header">
                    <div>
                      <h3>记忆检索</h3>
                      <p>先把 embedding model 和检索参数接进来，后面再把这里扩成更完整的 Alma 风格配置面板。</p>
                    </div>
                  </div>

                  {memoryNotice ? <div className="provider-notice">{memoryNotice}</div> : null}
                  {memoryConfig.error ? <div className="provider-notice provider-notice--error">{memoryConfig.error}</div> : null}

                  <label className="settings-memory__toggle">
                    <input
                      type="checkbox"
                      checked={memoryEnabledInput}
                      onChange={(event) => setMemoryEnabledInput(event.target.checked)}
                    />
                    <span>启用长期记忆</span>
                  </label>

                  <label className="settings-memory__toggle">
                    <input
                      type="checkbox"
                      checked={memoryAutoRetrievalInput}
                      onChange={(event) => setMemoryAutoRetrievalInput(event.target.checked)}
                    />
                    <span>自动检索记忆</span>
                  </label>

                  <label className="settings-memory__toggle">
                    <input
                      type="checkbox"
                      checked={memoryQueryRewriteInput}
                      onChange={(event) => setMemoryQueryRewriteInput(event.target.checked)}
                    />
                    <span>查询重写</span>
                  </label>

                  <label className="settings-memory__toggle">
                    <input
                      type="checkbox"
                      checked={memoryAutoSummarizeInput}
                      onChange={(event) => setMemoryAutoSummarizeInput(event.target.checked)}
                    />
                    <span>自动总结对话</span>
                  </label>

                  <div className="settings-memory__grid">
                    <div className="provider-field">
                      <label>Embedding Model</label>
                      <select
                        className="provider-field__input"
                        value={memoryEmbeddingModelInput}
                        onChange={(event) => setMemoryEmbeddingModelInput(event.target.value as MemoryEmbeddingModel)}
                      >
                        {embeddingModelDefinitions.map((definition) => (
                          <option key={definition.id} value={definition.id}>
                            {definition.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="provider-field">
                      <label>维度</label>
                      <div className="provider-field__box provider-field__box--input">
                        {embeddingModelDefinitions.find((definition) => definition.id === memoryEmbeddingModelInput)?.dimension ?? memoryConfig.config.embeddingDimension}
                      </div>
                    </div>

                    <div className="provider-field">
                      <label>最大检索记忆数</label>
                      <input
                        className="provider-field__input"
                        type="number"
                        min={1}
                        max={50}
                        value={memoryMaxRetrievalInput}
                        onChange={(event) => setMemoryMaxRetrievalInput(Number.parseInt(event.target.value, 10) || 1)}
                      />
                    </div>

                    <div className="provider-field">
                      <label>相似度阈值</label>
                      <input
                        className="provider-field__input"
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={memorySimilarityThresholdInput}
                        onChange={(event) => {
                          const nextValue = Number.parseFloat(event.target.value);
                          setMemorySimilarityThresholdInput(Number.isFinite(nextValue) ? Math.max(0, Math.min(1, nextValue)) : 0);
                        }}
                      />
                      <div className="provider-field__hint">
                        当前约等于 {formatSimilarityPercent(memorySimilarityThresholdInput)}
                      </div>
                    </div>
                  </div>

                  <div className="provider-actions">
                    <button
                      type="button"
                      className="settings-actions__button"
                      onClick={() => void handleRebuildEmbeddings()}
                      disabled={memoryConfig.rebuilding}
                    >
                      {memoryConfig.rebuilding ? "重建中..." : "重建向量索引"}
                    </button>
                    <button
                      type="button"
                      className="settings-actions__button settings-actions__button--primary"
                      onClick={() => void handleSaveMemoryConfig()}
                      disabled={memoryConfig.saving}
                    >
                      {memoryConfig.saving ? "保存中..." : "保存记忆配置"}
                    </button>
                  </div>
                </section>
              </div>
            </article>
          ) : activeSection.id === "skills" ? (
            <div className="settings-skills">
              <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
                <button
                  type="button"
                  className="settings-actions__button"
                  onClick={() => void loadSkills()}
                  disabled={skillsLoading}
                >
                  🔄 Refresh
                </button>
                <button
                  type="button"
                  className="settings-actions__button"
                  onClick={() => {
                    const skillsPath = "/Users/raper/workspace/Projects/Aliceloop/skills";
                    void desktopBridge.openPath(skillsPath);
                  }}
                >
                  📁 Open Folder
                </button>
              </div>
              {skillsLoading ? (
                <div className="settings-skills__loading">加载中...</div>
              ) : skillItems.length === 0 ? (
                <div className="settings-skills__empty">暂无技能</div>
              ) : (
                skillItems.map((skill) => (
                  <article key={skill.name} className="settings-skills__item">
                    <div className="settings-skills__item-main">
                      <div className="settings-skills__item-header">
                        <strong>{skill.label}</strong>
                      </div>
                      <p className="settings-skills__item-description">{skill.description}</p>
                    </div>
                  </article>
                ))
              )}
            </div>
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
