import type { FastifyInstance } from "fastify";
import {
  getRuntimeScriptDefinition,
  getStoredRuntimeScriptDefinition,
  listRuntimeScriptDefinitions,
} from "../repositories/runtimeCatalogRepository";
import { runManagedTask } from "../services/taskRunner";

interface RuntimeScriptParams {
  id: string;
}

interface RunRuntimeScriptBody {
  sessionId?: string | null;
  title?: string;
  args?: string[];
  cwd?: string;
}

export function registerRuntimeScriptRoutes(server: FastifyInstance) {
  server.get("/api/runtime/scripts", async () => listRuntimeScriptDefinitions());

  server.get<{ Params: RuntimeScriptParams }>("/api/runtime/scripts/:id", async (request, reply) => {
    const script = getRuntimeScriptDefinition(request.params.id);
    if (!script) {
      return reply.code(404).send({
        error: "runtime_script_not_found",
      });
    }

    return script;
  });

  server.post<{ Params: RuntimeScriptParams; Body: RunRuntimeScriptBody }>("/api/runtime/scripts/:id/run", async (request, reply) => {
    const script = getStoredRuntimeScriptDefinition(request.params.id);
    if (!script || script.status !== "available") {
      return reply.code(404).send({
        error: "runtime_script_not_found",
      });
    }

    const body = request.body;
    return runManagedTask({
      taskType: "script-runner",
      sessionId: body.sessionId ?? null,
      title: body.title ?? `运行脚本 · ${script.label}`,
      command: script.launchCommand,
      args: [...script.launchArgsPrefix, script.entryPath, ...script.defaultArgs, ...(Array.isArray(body.args) ? body.args : [])],
      cwd: body.cwd ?? script.defaultCwd,
    });
  });
}
