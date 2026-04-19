import type { FastifyInstance } from "fastify";
import {
  getMcpServerDefinition,
  installMcpServer,
  listMcpServerDefinitions,
  uninstallMcpServer,
} from "../repositories/mcpServerRepository";

interface McpServerParams {
  id: string;
}

export function registerMcpRoutes(server: FastifyInstance) {
  server.get("/api/mcp/servers", async () => listMcpServerDefinitions());

  server.get<{ Params: McpServerParams }>("/api/mcp/servers/:id", async (request, reply) => {
    const serverDefinition = getMcpServerDefinition(request.params.id);
    if (!serverDefinition) {
      return reply.code(404).send({
        error: "mcp_server_not_found",
      });
    }

    return serverDefinition;
  });

  server.post<{ Params: McpServerParams }>("/api/mcp/servers/:id/install", async (request, reply) => {
    try {
      const serverDefinition = installMcpServer(request.params.id);
      if (!serverDefinition) {
        return reply.code(404).send({
          error: "mcp_server_not_found",
        });
      }

      return serverDefinition;
    } catch (error) {
      if (error instanceof Error && error.message === "mcp_server_not_installable") {
        return reply.code(409).send({
          error: "mcp_server_not_installable",
        });
      }

      throw error;
    }
  });

  server.delete<{ Params: McpServerParams }>("/api/mcp/servers/:id/install", async (request, reply) => {
    const serverDefinition = uninstallMcpServer(request.params.id);
    if (!serverDefinition) {
      return reply.code(404).send({
        error: "mcp_server_not_found",
      });
    }

    return serverDefinition;
  });
}
