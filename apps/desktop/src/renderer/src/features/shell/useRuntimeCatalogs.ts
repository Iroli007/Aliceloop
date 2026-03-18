import { previewShellOverview, type McpServerDefinition, type MemoryNote, type SkillDefinition } from "@aliceloop/runtime-core";
import { useEffect, useMemo, useState } from "react";
import { getDesktopBridge } from "../../platform/desktopBridge";

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
    skills: [],
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
            skills: [],
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
