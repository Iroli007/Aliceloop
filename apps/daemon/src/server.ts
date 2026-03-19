import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  primarySessionId,
  type ContentBlock,
  type CrossReference,
  type DeviceType,
  type DocumentKind,
  type DocumentStructure,
  type ProviderKind,
  type SectionSpan,
  type SessionRole,
  type SourceKind,
  type TaskStatus,
  type TaskType,
} from "@aliceloop/runtime-core";
import { getUploadsDir } from "./db/client";
import { publishSessionEvent, subscribeToSession } from "./realtime/sessionStreams";
import {
  getDocumentStructure,
  listContentBlocks,
  listCrossReferences,
  listLibraryItems,
  listSectionSpans,
  searchContentBlocks,
} from "./repositories/libraryRepository";
import {
  getAttentionState,
  getMemoryNote,
  getShellOverview,
  getStudyArtifact,
  listMemoryNotes,
  listStudyArtifacts,
  shellOverviewRoute,
} from "./repositories/overviewRepository";
import { getProviderConfig, listProviderConfigs, updateProviderConfig } from "./repositories/providerRepository";
import {
  getMcpServerDefinition,
  getRuntimeCatalogSnapshot,
  getSkillDefinition,
  getRuntimeScriptDefinition,
  getStoredRuntimeScriptDefinition,
  listMcpServerDefinitions,
  listRuntimeScriptDefinitions,
  listSkillDefinitions,
} from "./repositories/runtimeCatalogRepository";
import { getSandboxRun, listSandboxRuns } from "./repositories/sandboxRunRepository";
import {
  canAcceptClientTraffic,
  createAttachment,
  createSession,
  createSessionMessage,
  getRuntimePresence,
  getSessionSnapshot,
  heartbeatDevice,
  listSessionThreads,
  listSessionEventsSince,
} from "./repositories/sessionRepository";
import { backfillTaskRunsFromJobs, getTaskRun, listTaskRuns } from "./repositories/taskRunRepository";
import { abortAgentForSession } from "./runtime/agentRuntime";
import { runProviderReply } from "./services/providerRunner";
import { createPermissionSandboxExecutor } from "./services/sandboxExecutor";
import { runManagedTask } from "./services/taskRunner";

interface SessionParams {
  id: string;
}

interface ProviderParams {
  id: ProviderKind;
}

interface SkillParams {
  id: string;
}

interface McpServerParams {
  id: string;
}

interface RuntimeScriptParams {
  id: string;
}

interface CreateMessageBody {
  clientMessageId: string;
  content: string;
  role?: SessionRole;
  attachmentIds?: string[];
  deviceId: string;
  deviceType: DeviceType;
}

interface CreateAttachmentBody {
  fileName: string;
  mimeType: string;
  contentBase64: string;
  deviceId: string;
  deviceType: DeviceType;
}

interface HeartbeatBody {
  deviceId: string;
  deviceType: DeviceType;
  label?: string;
  sessionId?: string;
}

interface UpdateProviderBody {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
}

interface CreateSessionBody {
  title?: string;
}

interface TaskParams {
  id: string;
}

interface LibraryParams {
  id: string;
}

interface ArtifactParams {
  id: string;
}

interface CreateTaskBody {
  taskType: TaskType;
  sessionId?: string | null;
  title?: string;
  sourcePath?: string;
  sourceKind?: SourceKind;
  documentKind?: DocumentKind;
  command?: string;
  args?: string[];
  cwd?: string;
}

interface RunSkillBody {
  sessionId?: string | null;
  title?: string;
  sourcePath?: string;
  sourceKind?: SourceKind;
  documentKind?: DocumentKind;
  command?: string;
  args?: string[];
  cwd?: string;
}

interface RunRuntimeScriptBody {
  sessionId?: string | null;
  title?: string;
  args?: string[];
  cwd?: string;
}

interface LibraryBlocksQuery {
  sectionKey?: string;
}

interface LibrarySearchQuery {
  q?: string;
  libraryItemId?: string;
  limit?: string;
}

interface ArtifactQuery {
  libraryItemId?: string;
  limit?: string;
}

interface SandboxRunQuery {
  limit?: string;
}

interface MemoryQuery {
  limit?: string;
}

interface MemoryParams {
  id: string;
}

interface SandboxRunParams {
  id: string;
}

function parseSinceValue(value: string | string[] | undefined): number {
  if (!value) {
    return 0;
  }

  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseLimitValue(value: string | string[] | undefined, fallback = 50): number {
  if (!value) {
    return fallback;
  }

  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.trunc(parsed), 200));
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function writeSseEvent(write: (chunk: string) => void, event: unknown, seq: number) {
  write(`id: ${seq}\n`);
  write("event: session\n");
  write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function createServer() {
  const server = Fastify({
    logger: true,
    bodyLimit: 20 * 1024 * 1024,
  });

  await server.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
  });

  backfillTaskRunsFromJobs();

  server.get("/health", async () => ({
    ok: true,
    service: "aliceloop-daemon",
    timestamp: new Date().toISOString(),
  }));

  server.get(shellOverviewRoute, async () => getShellOverview());
  server.get("/api/attention", async () => getAttentionState());
  server.get<{ Querystring: MemoryQuery }>("/api/memories", async (request) => listMemoryNotes(parseLimitValue(request.query.limit, 50)));
  server.get<{ Params: MemoryParams }>("/api/memories/:id", async (request, reply) => {
    const memory = getMemoryNote(request.params.id);
    if (!memory) {
      return reply.code(404).send({
        error: "memory_not_found",
      });
    }

    return memory;
  });
  server.get("/api/skills", async () => listSkillDefinitions());
  server.get<{ Params: SkillParams }>("/api/skills/:id", async (request, reply) => {
    const skill = getSkillDefinition(request.params.id);
    if (!skill) {
      return reply.code(404).send({
        error: "skill_not_found",
      });
    }

    return skill;
  });
  server.post<{ Params: SkillParams; Body: RunSkillBody }>("/api/skills/:id/run", async (request, reply) => {
    const skill = getSkillDefinition(request.params.id);
    if (!skill) {
      return reply.code(404).send({
        error: "skill_not_found",
      });
    }

    return reply.code(409).send({
      error: "skill_not_runnable",
      detail: "Project skills are instructional SKILL.md entries. Use /api/tasks or /api/runtime/scripts for executable actions.",
      skill,
    });
  });
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

  server.get("/api/library", async () => listLibraryItems());
  server.get<{ Querystring: ArtifactQuery }>("/api/artifacts", async (request) => {
    return listStudyArtifacts({
      libraryItemId: request.query.libraryItemId,
      limit: parseLimitValue(request.query.limit, 50),
    });
  });
  server.get<{ Params: ArtifactParams }>("/api/artifacts/:id", async (request, reply) => {
    const artifact = getStudyArtifact(request.params.id);
    if (!artifact) {
      return reply.code(404).send({
        error: "artifact_not_found",
      });
    }

    return artifact;
  });

  server.get<{ Params: LibraryParams }>("/api/library/:id/structure", async (request, reply) => {
    const structure = getDocumentStructure(request.params.id);
    if (!structure) {
      return reply.code(404).send({
        error: "library_structure_not_found",
      });
    }

    return {
      structure,
      sections: listSectionSpans(request.params.id),
    } as { structure: DocumentStructure; sections: SectionSpan[] };
  });

  server.get<{ Params: LibraryParams; Querystring: LibraryBlocksQuery }>("/api/library/:id/blocks", async (request) => {
    return listContentBlocks({
      libraryItemId: request.params.id,
      sectionKey: request.query.sectionKey,
    }) as ContentBlock[];
  });

  server.get<{ Params: LibraryParams }>("/api/library/:id/cross-references", async (request) => {
    return listCrossReferences(request.params.id) as CrossReference[];
  });

  server.get<{ Querystring: LibrarySearchQuery }>("/api/library/search", async (request) => {
    return searchContentBlocks({
      query: request.query.q ?? "",
      libraryItemId: request.query.libraryItemId,
      limit: parseLimitValue(request.query.limit, 20),
    });
  });

  server.get("/api/sessions", async () => listSessionThreads());

  server.post<{ Body: CreateSessionBody }>("/api/sessions", async (request) => createSession(request.body?.title));

  server.get<{ Querystring: { sessionId?: string; taskType?: TaskType; status?: TaskStatus; limit?: string } }>(
    "/api/tasks",
    async (request) => {
    return listTaskRuns({
      sessionId: request.query.sessionId,
      taskType: request.query.taskType,
      status: request.query.status,
      limit: parseLimitValue(request.query.limit, 100),
    });
    },
  );

  server.post<{ Body: CreateTaskBody }>("/api/tasks", async (request, reply) => {
    const body = request.body;

    if (body.taskType === "document-ingest") {
      if (!body.sourcePath?.trim()) {
        return reply.code(400).send({
          error: "sourcePath_required",
        });
      }

      return runManagedTask({
        taskType: "document-ingest",
        title: body.title,
        sourcePath: body.sourcePath.trim(),
        sourceKind: body.sourceKind,
        documentKind: body.documentKind,
      });
    }

    if (body.taskType === "review-coach") {
      return runManagedTask({
        taskType: "review-coach",
        sessionId: body.sessionId ?? null,
        title: body.title,
      });
    }

    if (body.taskType === "script-runner") {
      if (!body.command?.trim()) {
        return reply.code(400).send({
          error: "command_required",
        });
      }

      return runManagedTask({
        taskType: "script-runner",
        sessionId: body.sessionId ?? null,
        title: body.title,
        command: body.command.trim(),
        args: Array.isArray(body.args) ? body.args : [],
        cwd: body.cwd,
      });
    }

    return reply.code(400).send({
      error: "unsupported_task_type",
      supportedTaskTypes: ["document-ingest", "review-coach", "script-runner"],
    });
  });

  server.get<{ Params: TaskParams }>("/api/tasks/:id", async (request, reply) => {
    const taskRun = getTaskRun(request.params.id);
    if (!taskRun) {
      return reply.code(404).send({
        error: "task_not_found",
      });
    }

    return taskRun;
  });

  server.get<{ Params: SessionParams }>("/api/session/:id/snapshot", async (request) => {
    return getSessionSnapshot(request.params.id);
  });

  server.get<{ Params: SessionParams; Querystring: { since?: string } }>("/api/session/:id/stream", (request, reply) => {
    const sessionId = request.params.id;
    const since = Math.max(
      parseSinceValue(request.query.since),
      parseSinceValue(request.headers["last-event-id"]),
    );
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "*";

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
    });

    reply.raw.write("retry: 2000\n\n");

    let ready = false;
    const bufferedEvents: ReturnType<typeof listSessionEventsSince> = [];

    const unsubscribe = subscribeToSession(sessionId, (event) => {
      if (!ready) {
        bufferedEvents.push(event);
        return;
      }

      writeSseEvent(reply.raw.write.bind(reply.raw), event, event.seq);
    });

    const initialEvents = listSessionEventsSince(sessionId, since);

    for (const event of initialEvents) {
      writeSseEvent(reply.raw.write.bind(reply.raw), event, event.seq);
    }

    const initialSeqs = new Set(initialEvents.map((event) => event.seq));
    bufferedEvents
      .filter((event) => event.seq > since && !initialSeqs.has(event.seq))
      .sort((left, right) => left.seq - right.seq)
      .forEach((event) => {
        writeSseEvent(reply.raw.write.bind(reply.raw), event, event.seq);
      });

    ready = true;

    request.raw.on("error", () => {
      unsubscribe();
    });

    const keepAlive = setInterval(() => {
      reply.raw.write(": keep-alive\n\n");
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      reply.raw.end();
    });
  });

  server.post<{ Params: SessionParams; Body: CreateMessageBody }>("/api/session/:id/messages", async (request, reply) => {
    const { clientMessageId, content, role = "user", attachmentIds = [], deviceId, deviceType } = request.body;

    if (!content.trim() && attachmentIds.length === 0) {
      return reply.code(400).send({
        error: "Message content or attachmentIds is required",
      });
    }

    if (!canAcceptClientTraffic(deviceType)) {
      return reply.code(409).send({
        error: "runtime_offline",
        runtimePresence: getRuntimePresence(),
      });
    }

    const result = createSessionMessage({
      sessionId: request.params.id,
      clientMessageId,
      content: content.trim(),
      role,
      attachmentIds,
      deviceId,
    });

    for (const event of result.events) {
      publishSessionEvent(event);
    }

    if (role === "user" && result.created) {
      abortAgentForSession(request.params.id);
      void runProviderReply(request.params.id);
    }

    return {
      created: result.created,
      message: result.message,
      lastEventSeq: result.events.at(-1)?.seq ?? getSessionSnapshot(request.params.id).lastEventSeq,
    };
  });

  server.post<{ Params: SessionParams; Body: CreateAttachmentBody }>("/api/session/:id/attachments", async (request, reply) => {
    const { fileName, mimeType, contentBase64, deviceType } = request.body;

    if (!fileName || !mimeType || !contentBase64) {
      return reply.code(400).send({
        error: "fileName, mimeType and contentBase64 are required",
      });
    }

    if (!canAcceptClientTraffic(deviceType)) {
      return reply.code(409).send({
        error: "runtime_offline",
        runtimePresence: getRuntimePresence(),
      });
    }

    const binary = Buffer.from(contentBase64, "base64");
    const attachmentId = randomUUID();
    const safeName = sanitizeFileName(fileName);
    const storagePath = join(getUploadsDir(), `${attachmentId}-${safeName}`);
    const sandbox = createPermissionSandboxExecutor({
      label: `attachment:${request.params.id}:${fileName}`,
    });
    await sandbox.writeBinaryFile({
      targetPath: storagePath,
      content: binary,
    });

    const result = createAttachment({
      sessionId: request.params.id,
      fileName,
      mimeType,
      byteSize: binary.byteLength,
      storagePath,
    });

    for (const event of result.events) {
      publishSessionEvent(event);
    }

    return {
      attachment: result.attachment,
      jobs: result.jobs,
      lastEventSeq: result.events.at(-1)?.seq ?? getSessionSnapshot(request.params.id).lastEventSeq,
    };
  });

  server.get("/api/runtime/presence", async () => getRuntimePresence());
  server.get<{ Querystring: SandboxRunQuery }>("/api/runtime/catalog", async (request) => {
    return getRuntimeCatalogSnapshot(parseLimitValue(request.query.limit, 10));
  });

  server.get<{ Querystring: SandboxRunQuery }>("/api/runtime/sandbox-runs", async (request) => {
    return listSandboxRuns(parseLimitValue(request.query.limit, 50));
  });
  server.get<{ Params: SandboxRunParams }>("/api/runtime/sandbox-runs/:id", async (request, reply) => {
    const sandboxRun = getSandboxRun(request.params.id);
    if (!sandboxRun) {
      return reply.code(404).send({
        error: "sandbox_run_not_found",
      });
    }

    return sandboxRun;
  });

  server.get("/api/providers", async () => listProviderConfigs());

  server.get<{ Params: ProviderParams }>("/api/providers/:id", async (request) => {
    return getProviderConfig(request.params.id);
  });

  server.put<{ Params: ProviderParams; Body: UpdateProviderBody }>("/api/providers/:id", async (request) => {
    return updateProviderConfig({
      providerId: request.params.id,
      ...request.body,
    });
  });

  server.post<{ Body: HeartbeatBody }>("/api/runtime/presence/heartbeat", async (request) => {
    const sessionId = request.body.sessionId ?? primarySessionId;
    const label =
      request.body.label ??
      (request.body.deviceType === "desktop" ? "Aliceloop Desktop" : "Aliceloop Mobile");

    const result = heartbeatDevice({
      deviceId: request.body.deviceId,
      deviceType: request.body.deviceType,
      label,
      sessionId,
    });

    publishSessionEvent(result.event);

    return {
      devices: result.devices,
      runtimePresence: result.runtimePresence,
      lastEventSeq: result.event.seq,
    };
  });

  return server;
}
