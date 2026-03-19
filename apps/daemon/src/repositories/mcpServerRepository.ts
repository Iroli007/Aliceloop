import type {
  McpServerDefinition,
  McpServerSource,
} from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";

interface McpCatalogEntry {
  id: string;
  label: string;
  description: string;
  author: string;
  transport: McpServerDefinition["transport"];
  status: McpServerDefinition["status"];
  capabilities: string[];
  tags: string[];
  verified: boolean;
  featured: boolean;
  homepageUrl: string | null;
}

interface McpInstallRow {
  serverId: string;
  installSource: McpServerSource;
  installedAt: string;
  updatedAt: string;
}

const marketplaceCatalog: McpCatalogEntry[] = [
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
  },
  {
    id: "filesystem-bridge",
    label: "Filesystem Bridge",
    description: "把本地文件系统能力接到 Aliceloop 的 MCP client，适合用户自行安装后的读写桥接。",
    author: "modelcontextprotocol",
    transport: "stdio",
    status: "available",
    capabilities: ["read", "write", "edit"],
    tags: ["filesystem", "local", "productivity"],
    verified: true,
    featured: false,
    homepageUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "task-center-bridge",
    label: "Task Center Bridge",
    description: "预留给后续任务中心与 artifact 协调的 MCP 入口，目前仍处于规划阶段。",
    author: "aliceloop",
    transport: "builtin",
    status: "planned",
    capabilities: ["tasks", "jobs", "artifacts"],
    tags: ["task-center", "artifacts", "planned"],
    verified: false,
    featured: false,
    homepageUrl: null,
  },
];

function getInstallRows() {
  const db = getDatabase();
  return db.prepare(
    `
      SELECT
        server_id AS serverId,
        install_source AS installSource,
        installed_at AS installedAt,
        updated_at AS updatedAt
      FROM mcp_server_installs
    `,
  ).all() as McpInstallRow[];
}

function toPublicDefinition(entry: McpCatalogEntry, installRow?: McpInstallRow): McpServerDefinition {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    author: entry.author,
    transport: entry.transport,
    status: entry.status,
    capabilities: [...entry.capabilities],
    tags: [...entry.tags],
    verified: entry.verified,
    featured: entry.featured,
    homepageUrl: entry.homepageUrl,
    installStatus: installRow ? "installed" : "not-installed",
    installSource: installRow?.installSource ?? "marketplace",
    installedAt: installRow?.installedAt ?? null,
  };
}

export function listMcpServerDefinitions() {
  const installRowsById = new Map(getInstallRows().map((row) => [row.serverId, row] as const));
  return marketplaceCatalog.map((entry) => toPublicDefinition(entry, installRowsById.get(entry.id)));
}

export function listInstalledMcpServerDefinitions() {
  return listMcpServerDefinitions().filter((server) => server.installStatus === "installed");
}

export function getMcpServerDefinition(serverId: string) {
  return listMcpServerDefinitions().find((server) => server.id === serverId) ?? null;
}

export function installMcpServer(serverId: string) {
  const server = getMcpServerDefinition(serverId);
  if (!server) {
    return null;
  }

  if (server.status !== "available") {
    throw new Error("mcp_server_not_installable");
  }

  const now = new Date().toISOString();
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO mcp_server_installs (
        server_id, install_source, installed_at, updated_at
      ) VALUES (
        @serverId, @installSource, @installedAt, @updatedAt
      )
      ON CONFLICT(server_id) DO UPDATE SET
        install_source = excluded.install_source,
        installed_at = excluded.installed_at,
        updated_at = excluded.updated_at
    `,
  ).run({
    serverId,
    installSource: "marketplace",
    installedAt: now,
    updatedAt: now,
  });

  return getMcpServerDefinition(serverId);
}

export function uninstallMcpServer(serverId: string) {
  const server = getMcpServerDefinition(serverId);
  if (!server) {
    return null;
  }

  const db = getDatabase();
  db.prepare("DELETE FROM mcp_server_installs WHERE server_id = ?").run(serverId);
  return getMcpServerDefinition(serverId);
}
