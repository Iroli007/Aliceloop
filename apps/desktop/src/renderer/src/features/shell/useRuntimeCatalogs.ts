import {
  previewShellOverview,
  type McpServerDefinition,
  type MemoryNote,
  type SkillDefinition,
} from "@aliceloop/runtime-core";
import { useEffect, useMemo, useState } from "react";
import { getDesktopBridge } from "../../platform/desktopBridge";

const previewSkills: SkillDefinition[] = [
  {
    id: "document-ingest",
    label: "document-ingest",
    description: "导入资料，生成结构、块级内容与基础回链。",
    status: "available",
    taskType: "document-ingest",
    usesSandbox: true,
    runtimeScriptId: null,
  },
  {
    id: "study-artifact",
    label: "study-artifact",
    description: "围绕当前会话和资料生成学习型工件。",
    status: "planned",
    taskType: "study-artifact",
    usesSandbox: false,
    runtimeScriptId: null,
  },
  {
    id: "review-coach",
    label: "review-coach",
    description: "围绕近期注意力与长期记忆生成陪练与复盘。",
    status: "available",
    taskType: "review-coach",
    usesSandbox: false,
    runtimeScriptId: null,
  },
  {
    id: "script-runner",
    label: "script-runner",
    description: "在受控目录里运行 Node / TypeScript 脚本。",
    status: "available",
    taskType: "script-runner",
    usesSandbox: true,
    runtimeScriptId: null,
  },
];

const previewMcpServers: McpServerDefinition[] = [
  {
    id: "filesystem-bridge",
    label: "Filesystem Bridge",
    transport: "builtin",
    status: "planned",
    capabilities: ["read", "write", "edit"],
  },
  {
    id: "task-center-bridge",
    label: "Task Center Bridge",
    transport: "builtin",
    status: "planned",
    capabilities: ["tasks", "jobs", "artifacts"],
  },
];

export interface RuntimeCatalogsState {
  status: "loading" | "ready" | "error";
  memories: MemoryNote[];
  skills: SkillDefinition[];
  mcpServers: McpServerDefinition[];
  error?: string;
}

export function useRuntimeCatalogs(): RuntimeCatalogsState {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const [state, setState] = useState<RuntimeCatalogsState>({
    status: "loading",
    memories: previewShellOverview.memories,
    skills: previewSkills,
    mcpServers: previewMcpServers,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { daemonBaseUrl } = await bridge.getAppMeta();
        const [memoriesResponse, skillsResponse, mcpResponse] = await Promise.all([
          fetch(`${daemonBaseUrl}/api/memories?limit=50`),
          fetch(`${daemonBaseUrl}/api/skills`),
          fetch(`${daemonBaseUrl}/api/mcp/servers`),
        ]);

        if (!memoriesResponse.ok) {
          throw new Error(`Failed to load memories (${memoriesResponse.status})`);
        }

        if (!skillsResponse.ok) {
          throw new Error(`Failed to load skills (${skillsResponse.status})`);
        }

        if (!mcpResponse.ok) {
          throw new Error(`Failed to load MCP servers (${mcpResponse.status})`);
        }

        const [memories, skills, mcpServers] = (await Promise.all([
          memoriesResponse.json(),
          skillsResponse.json(),
          mcpResponse.json(),
        ])) as [MemoryNote[], SkillDefinition[], McpServerDefinition[]];

        if (!cancelled) {
          setState({
            status: "ready",
            memories,
            skills,
            mcpServers,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            memories: previewShellOverview.memories,
            skills: previewSkills,
            mcpServers: previewMcpServers,
            error: error instanceof Error ? error.message : "Failed to load runtime catalogs",
          });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  return state;
}
