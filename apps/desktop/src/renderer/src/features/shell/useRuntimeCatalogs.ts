import { previewShellOverview, type McpServerDefinition, type MemoryNote, type SkillDefinition } from "@aliceloop/runtime-core";
import { useEffect, useMemo, useState } from "react";
import { getDesktopBridge } from "../../platform/desktopBridge";

const previewMcpServers: McpServerDefinition[] = [
  {
    id: "context7",
    label: "Context7",
    description: "为 LLM 和代码编辑器提供实时、版本感知的文档与代码示例索引。",
    author: "upstash",
    transport: "http",
    status: "available",
    capabilities: ["documentation", "code-examples", "api-reference"],
    tags: ["documentation", "up-to-date", "code-examples"],
    verified: true,
    featured: true,
    homepageUrl: "https://github.com/upstash/context7",
    installStatus: "not-installed",
    installSource: "marketplace",
    installedAt: null,
  },
  {
    id: "fetch",
    label: "Fetch",
    description: "抓取网页内容并转成更适合模型消费的文本格式，适合轻量检索和资料收集。",
    author: "modelcontextprotocol",
    transport: "stdio",
    status: "available",
    capabilities: ["web-fetching", "html-to-markdown", "automation"],
    tags: ["web-fetching", "content-extraction", "automation"],
    verified: true,
    featured: true,
    homepageUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    installStatus: "not-installed",
    installSource: "marketplace",
    installedAt: null,
  },
];

export interface RuntimeCatalogsState {
  status: "loading" | "ready" | "error";
  memories: MemoryNote[];
  skills: SkillDefinition[];
  mcpServers: McpServerDefinition[];
  mutatingMcpServerId: string | null;
  error?: string;
  refresh(): Promise<void>;
  installMcpServer(serverId: string): Promise<{ ok: boolean; server?: McpServerDefinition; error?: string }>;
  uninstallMcpServer(serverId: string): Promise<{ ok: boolean; server?: McpServerDefinition; error?: string }>;
}

export function useRuntimeCatalogs(): RuntimeCatalogsState {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const [state, setState] = useState<RuntimeCatalogsState>({
    status: "loading",
    memories: previewShellOverview.memories,
    skills: [],
    mcpServers: previewMcpServers,
    mutatingMcpServerId: null,
    refresh,
    installMcpServer,
    uninstallMcpServer,
  });

  async function loadMcpServers() {
    const { daemonBaseUrl } = await bridge.getAppMeta();
    const response = await fetch(`${daemonBaseUrl}/api/mcp/servers`);
    if (!response.ok) {
      throw new Error(`Failed to load MCP servers (${response.status})`);
    }

    return response.json() as Promise<McpServerDefinition[]>;
  }

  async function loadCatalogs() {
    const { daemonBaseUrl } = await bridge.getAppMeta();
    const [memoriesResponse, skillsResponse, mcpServers] = await Promise.all([
      fetch(`${daemonBaseUrl}/api/memories?limit=50`),
      fetch(`${daemonBaseUrl}/api/skills`),
      loadMcpServers(),
    ]);

    if (!memoriesResponse.ok) {
      throw new Error(`Failed to load memories (${memoriesResponse.status})`);
    }

    if (!skillsResponse.ok) {
      throw new Error(`Failed to load skills (${skillsResponse.status})`);
    }

    const [memories, skills] = (await Promise.all([
      memoriesResponse.json(),
      skillsResponse.json(),
    ])) as [MemoryNote[], SkillDefinition[]];

    return {
      memories,
      skills,
      mcpServers,
    };
  }

  async function refresh() {
    try {
      const { memories, skills, mcpServers } = await loadCatalogs();
      setState((current) => ({
        ...current,
        status: "ready",
        memories,
        skills,
        mcpServers,
        mutatingMcpServerId: null,
        error: undefined,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        status: "error",
        mutatingMcpServerId: null,
        error: error instanceof Error ? error.message : "Failed to load runtime catalogs",
      }));
    }
  }

  async function installMcpServer(serverId: string) {
    setState((current) => ({
      ...current,
      mutatingMcpServerId: serverId,
    }));

    try {
      const { daemonBaseUrl } = await bridge.getAppMeta();
      const response = await fetch(`${daemonBaseUrl}/api/mcp/servers/${serverId}/install`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Failed to install MCP server (${response.status})`);
      }

      const server = (await response.json()) as McpServerDefinition;
      setState((current) => ({
        ...current,
        status: "ready",
        error: undefined,
        mutatingMcpServerId: null,
        mcpServers: current.mcpServers.map((item) => (item.id === server.id ? server : item)),
      }));
      return { ok: true as const, server };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to install MCP server";
      setState((current) => ({
        ...current,
        error: message,
        mutatingMcpServerId: null,
      }));
      return { ok: false as const, error: message };
    }
  }

  async function uninstallMcpServer(serverId: string) {
    setState((current) => ({
      ...current,
      mutatingMcpServerId: serverId,
    }));

    try {
      const { daemonBaseUrl } = await bridge.getAppMeta();
      const response = await fetch(`${daemonBaseUrl}/api/mcp/servers/${serverId}/install`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(`Failed to uninstall MCP server (${response.status})`);
      }

      const server = (await response.json()) as McpServerDefinition;
      setState((current) => ({
        ...current,
        status: "ready",
        error: undefined,
        mutatingMcpServerId: null,
        mcpServers: current.mcpServers.map((item) => (item.id === server.id ? server : item)),
      }));
      return { ok: true as const, server };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to uninstall MCP server";
      setState((current) => ({
        ...current,
        error: message,
        mutatingMcpServerId: null,
      }));
      return { ok: false as const, error: message };
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { memories, skills, mcpServers } = await loadCatalogs();

        if (!cancelled) {
          setState({
            status: "ready",
            memories,
            skills,
            mcpServers,
            mutatingMcpServerId: null,
            refresh,
            installMcpServer,
            uninstallMcpServer,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            memories: previewShellOverview.memories,
            skills: [],
            mcpServers: previewMcpServers,
            mutatingMcpServerId: null,
            error: error instanceof Error ? error.message : "Failed to load runtime catalogs",
            refresh,
            installMcpServer,
            uninstallMcpServer,
          });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  return {
    ...state,
    refresh,
    installMcpServer,
    uninstallMcpServer,
  };
}
