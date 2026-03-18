import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { primarySessionId, type DeviceType, type ProviderKind, type SessionRole } from "@aliceloop/runtime-core";
import { getUploadsDir } from "./db/client";
import { publishSessionEvent, subscribeToSession } from "./realtime/sessionStreams";
import { getShellOverview, shellOverviewRoute } from "./repositories/overviewRepository";
import { getProviderConfig, updateProviderConfig } from "./repositories/providerRepository";
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
import { runMiniMaxReply } from "./services/minimaxRunner";

interface SessionParams {
  id: string;
}

interface ProviderParams {
  id: ProviderKind;
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

  server.get("/api/sessions", async () => listSessionThreads());

  server.post<{ Body: CreateSessionBody }>("/api/sessions", async (request) => createSession(request.body?.title));

  server.get<{ Querystring: { sessionId?: string; limit?: string } }>("/api/tasks", async (request) => {
    return listTaskRuns({
      sessionId: request.query.sessionId,
      limit: parseLimitValue(request.query.limit, 100),
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

    const initialEvents = listSessionEventsSince(sessionId, since);
    reply.raw.write("retry: 2000\n\n");

    for (const event of initialEvents) {
      writeSseEvent(reply.raw.write.bind(reply.raw), event, event.seq);
    }

    const unsubscribe = subscribeToSession(sessionId, (event) => {
      writeSseEvent(reply.raw.write.bind(reply.raw), event, event.seq);
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
      void runMiniMaxReply(request.params.id);
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
    writeFileSync(storagePath, binary);

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
