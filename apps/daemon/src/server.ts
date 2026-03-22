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
  type MemoryKind,
  type ProviderKind,
  type SandboxPermissionProfile,
  type ProviderTransportKind,
  type SectionSpan,
  type SessionRole,
  type SourceKind,
  type TaskStatus,
  type TaskType,
} from "@aliceloop/runtime-core";
import { getUploadsDir } from "./db/client";
import { publishSessionEvent, subscribeToSession } from "./realtime/sessionStreams";
import { getMemoryConfig, parseMemoryConfigPatch, updateMemoryConfig } from "./context/memory/memoryConfig";
import {
  clearAllMemories,
  createMemory,
  createMemoryNote,
  deleteMemory,
  deleteMemoryNote,
  getMemoryById,
  getMemoryStats,
  listMemories,
  rebuildAllEmbeddings,
  searchMemoriesBySimilarity,
  searchMemoryNotes,
  updateMemory,
} from "./context/memory/memoryRepository";
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
  getRuntimeCatalogSnapshot,
  getSkillDefinition,
  getRuntimeScriptDefinition,
  getStoredRuntimeScriptDefinition,
  listRuntimeScriptDefinitions,
  listSkillDefinitions,
} from "./repositories/runtimeCatalogRepository";
import { listActiveSkillDefinitions } from "./context/skills/skillLoader";
import {
  getMcpServerDefinition,
  installMcpServer,
  listMcpServerDefinitions,
  uninstallMcpServer,
} from "./repositories/mcpServerRepository";
import { getSandboxRun, listSandboxRuns } from "./repositories/sandboxRunRepository";
import {
  addSessionMessageReaction,
  canAcceptClientTraffic,
  createAttachment,
  createSession,
  deleteSession,
  createSessionMessage,
  hasSession,
  listSessionMessageReactions,
  removeSessionMessageReaction,
  getRuntimePresence,
  getSessionSnapshot,
  heartbeatDevice,
  listSessionThreads,
  listSessionEventsSince,
} from "./repositories/sessionRepository";
import {
  createProjectDirectory,
  deleteProjectDirectory,
  getProjectDirectory,
  listProjectDirectories,
  ProjectDirectoryInUseError,
  ProjectDirectoryNotFoundError,
  ProjectDirectoryValidationError,
  updateProjectDirectory,
} from "./repositories/projectRepository";
import { createCronJob, deleteCronJob, listCronJobs } from "./repositories/cronJobRepository";
import { approvePlan, archivePlan, createPlan, getPlan, listPlans, type PlanStatus, updatePlan } from "./repositories/planRepository";
import { getRuntimeSettings, updateRuntimeSettings } from "./repositories/runtimeSettingsRepository";
import { getUserProfile, updateUserProfile } from "./repositories/userProfileRepository";
import {
  backfillTaskRunsFromJobs,
  createTrackedTask,
  deleteTrackedTask,
  getTaskRun,
  listTaskRuns,
  updateTrackedTask,
} from "./repositories/taskRunRepository";
import { abortAgentForSession } from "./runtime/agentRuntime";
import { runProviderReply } from "./services/providerRunner";
import { createPermissionSandboxExecutor } from "./services/sandboxExecutor";
import { generateImage } from "./services/imageGenerationService";
import { assertResolvableSkillTools, listRequestedSkillToolNames } from "./context/tools/toolRegistry";
import {
  approveSessionToolApproval,
  rejectSessionToolApproval,
  ToolApprovalNotFoundError,
} from "./services/sessionToolApprovalService";
import { runManagedTask } from "./services/taskRunner";
import { startSchedulerService } from "./services/schedulerService";
import {
  assignSessionProjectAndSync,
  resyncProjectSessionHistories,
  syncSessionProjectHistory,
} from "./services/sessionProjectService";

interface SessionParams {
  id: string;
}

interface ProjectParams {
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

interface ToolApprovalParams {
  id: string;
  approvalId: string;
}

interface SessionMessageParams {
  id: string;
  messageId: string;
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
  originalPath?: string;
  deviceId: string;
  deviceType: DeviceType;
}

interface CreateFolderAttachmentBody {
  folderName: string;
  files: Array<{
    relativePath: string;
    mimeType: string;
    contentBase64: string;
  }>;
  deviceId: string;
  deviceType: DeviceType;
}

interface GenerateImageBody {
  prompt?: string;
  providerId?: ProviderKind;
  model?: string;
  size?: string;
  outputPath?: string;
}

interface CreateReactionBody {
  emoji?: string;
  deviceId?: string;
}

interface DeleteReactionQuery {
  emoji?: string;
  deviceId?: string;
}

interface HeartbeatBody {
  deviceId: string;
  deviceType: DeviceType;
  label?: string;
  sessionId?: string;
}

interface UpdateProviderBody {
  transport?: ProviderTransportKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
}

interface CreateSessionBody {
  title?: string;
  projectId?: string | null;
}

interface CreateProjectBody {
  name?: string;
  path?: string;
  kind?: "workspace" | "temporary";
  isDefault?: boolean;
}

interface UpdateProjectBody {
  name?: string;
  path?: string;
  isDefault?: boolean;
}

interface UpdateSessionProjectBody {
  projectId?: string | null;
}

interface UpdateRuntimeSettingsBody {
  sandboxProfile?: SandboxPermissionProfile;
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
  detail?: string;
  steps?: string[];
  sourcePath?: string;
  sourceKind?: SourceKind;
  documentKind?: DocumentKind;
  command?: string;
  args?: string[];
  cwd?: string;
}

interface UpdateTaskBody {
  title?: string;
  detail?: string;
  status?: string;
  steps?: string[];
  step?: number;
  stepStatus?: string;
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
  source?: string;
}

interface MemorySearchQuery {
  q?: string;
  limit?: string;
  source?: string;
}

interface MemoryParams {
  id: string;
}

interface CreateMemoryBody {
  content?: string;
  title?: string;
  kind?: MemoryKind;
  source?: string;
}

interface SemanticMemoryEntriesQuery {
  limit?: string;
  offset?: string;
  source?: string;
  durability?: string;
  orderBy?: string;
  order?: string;
}

interface SemanticMemorySearchQuery {
  q?: string;
  limit?: string;
  threshold?: string;
}

interface SemanticMemoryConfigBody {
  enabled?: boolean;
  autoRetrieval?: boolean;
  queryRewrite?: boolean;
  maxRetrievalCount?: number;
  similarityThreshold?: number;
  autoSummarize?: boolean;
  embeddingModel?: "text-embedding-3-small" | "text-embedding-3-large";
  embeddingDimension?: number;
}

interface CreateSemanticMemoryBody {
  content?: string;
  source?: string;
  durability?: string;
  relatedTopics?: string[];
}

interface UpdateSemanticMemoryBody {
  content?: string;
  durability?: string;
  relatedTopics?: string[];
}

interface CronJobParams {
  id: string;
}

interface CreateCronJobBody {
  name?: string;
  schedule?: string;
  prompt?: string;
  sessionId?: string | null;
}

interface PlanParams {
  id: string;
}

interface PlanQuery {
  status?: PlanStatus;
  limit?: string;
}

interface CreatePlanBody {
  sessionId?: string | null;
  title?: string;
  goal?: string;
  steps?: string[];
}

interface UpdatePlanBody {
  title?: string;
  goal?: string;
  steps?: string[];
  status?: string;
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

function sanitizeRelativePath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").trim();
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    throw new Error("relativePath is required");
  }

  const sanitizedSegments = segments.map((segment) => {
    if (segment === "." || segment === "..") {
      throw new Error("relativePath cannot contain traversal segments");
    }
    return sanitizeFileName(segment);
  });

  return sanitizedSegments.join("/");
}

function normalizeMemoryKind(value: string | undefined): MemoryKind {
  if (value === "attention-summary" || value === "postmortem") {
    return value;
  }

  return "learning-pattern";
}

function normalizeSemanticMemorySource(value: string | undefined, fallback: "auto" | "manual" = "manual") {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "manual") {
    return normalized;
  }

  throw new Error("invalid_memory_source");
}

function normalizeSemanticMemoryDurability(
  value: string | undefined,
  fallback?: "permanent" | "temporary",
) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "permanent" || normalized === "temporary") {
    return normalized;
  }

  throw new Error("invalid_memory_durability");
}

function normalizeSemanticMemoryOrderBy(value: string | undefined) {
  switch (value?.trim().toLowerCase()) {
    case "updated_at":
    case "updatedat":
    case "updated":
      return "updatedAt" as const;
    case "access_count":
    case "accesscount":
    case "access":
      return "accessCount" as const;
    case "created_at":
    case "createdat":
    case "created":
    case undefined:
      return "createdAt" as const;
    default:
      throw new Error("invalid_memory_order_by");
  }
}

function normalizeSortOrder(value: string | undefined) {
  if (!value) {
    return "DESC" as const;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === "ASC" || normalized === "DESC") {
    return normalized;
  }

  throw new Error("invalid_sort_order");
}

function parseThresholdValue(value: string | string[] | undefined, fallback = 0.7) {
  if (!value) {
    return fallback;
  }

  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(-1, Math.min(parsed, 1));
}

function summarizeMemoryTitle(content: string) {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return "CLI Memory";
  }

  return firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}…` : firstLine;
}

function normalizeTrackedTaskStatus(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "queued":
    case "todo":
    case "pending":
      return "queued" as const;
    case "running":
    case "in_progress":
      return "running" as const;
    case "done":
    case "complete":
    case "completed":
      return "done" as const;
    case "failed":
      return "failed" as const;
    default:
      throw new Error("invalid_task_status");
  }
}

function normalizeTrackedTaskStepDone(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "done":
    case "complete":
    case "completed":
      return true;
    case "pending":
    case "todo":
    case "open":
    case "queued":
    case "running":
    case "in_progress":
      return false;
    default:
      throw new Error("invalid_step_status");
  }
}

function normalizePlanStatusValue(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "draft":
      return "draft" as const;
    case "approved":
    case "approve":
      return "approved" as const;
    case "archived":
    case "archive":
      return "archived" as const;
    default:
      throw new Error("invalid_plan_status");
  }
}

function writeSseEvent(write: (chunk: string) => void, event: unknown, seq: number) {
  write(`id: ${seq}\n`);
  write("event: session\n");
  write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function createServer() {
  const activeSkills = listActiveSkillDefinitions();
  assertResolvableSkillTools(activeSkills);
  const activeSkillToolNames = listRequestedSkillToolNames(activeSkills);

  const server = Fastify({
    logger: true,
    bodyLimit: 20 * 1024 * 1024,
  });

  await server.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  backfillTaskRunsFromJobs();
  const stopScheduler = startSchedulerService();
  server.addHook("onClose", async () => {
    stopScheduler();
  });

  server.get("/health", async () => ({
    ok: true,
    service: "aliceloop-daemon",
    timestamp: new Date().toISOString(),
    activeSkills: activeSkills.map((skill) => skill.id),
    activeSkillAdapters: activeSkillToolNames,
  }));

  server.get(shellOverviewRoute, async () => getShellOverview());
  server.get("/api/attention", async () => getAttentionState());
  server.get<{ Querystring: MemoryQuery }>("/api/memories", async (request) => {
    return listMemoryNotes(parseLimitValue(request.query.limit, 50), request.query.source);
  });
  server.get<{ Querystring: MemorySearchQuery }>("/api/memories/search", async (request) => {
    return searchMemoryNotes(request.query.q ?? "", parseLimitValue(request.query.limit, 10), request.query.source);
  });
  server.post<{ Body: CreateMemoryBody }>("/api/memories", async (request, reply) => {
    const body = request.body ?? {};
    const content = body.content?.trim();
    if (!content) {
      return reply.code(400).send({
        error: "content_required",
      });
    }

    return createMemoryNote({
      id: randomUUID(),
      kind: normalizeMemoryKind(body.kind),
      title: body.title?.trim() || summarizeMemoryTitle(content),
      content,
      source: body.source?.trim() || "cli",
      updatedAt: new Date().toISOString(),
    });
  });
  server.get<{ Params: MemoryParams }>("/api/memories/:id", async (request, reply) => {
    const memory = getMemoryNote(request.params.id);
    if (!memory) {
      return reply.code(404).send({
        error: "memory_not_found",
      });
    }

    return memory;
  });
  server.delete<{ Params: MemoryParams }>("/api/memories/:id", async (request, reply) => {
    if (!deleteMemoryNote(request.params.id)) {
      return reply.code(404).send({
        error: "memory_not_found",
      });
    }

    return {
      ok: true,
      id: request.params.id,
    };
  });
  server.get("/api/memory/config", async () => getMemoryConfig());
  server.put<{ Body: SemanticMemoryConfigBody }>("/api/memory/config", async (request, reply) => {
    try {
      const updates = parseMemoryConfigPatch(request.body ?? {});
      return updateMemoryConfig(updates);
    } catch (error) {
      if (error instanceof Error) {
        return reply.code(400).send({
          error: "invalid_memory_config",
          detail: error.message,
        });
      }
      throw error;
    }
  });
  server.get("/api/memory/stats", async () => getMemoryStats());
  server.post("/api/memory/rebuild", async (_request, reply) => {
    try {
      return await rebuildAllEmbeddings();
    } catch (error) {
      if (error instanceof Error && error.message === "embedding_provider_not_configured") {
        return reply.code(409).send({
          error: "embedding_provider_not_configured",
        });
      }

      throw error;
    }
  });
  server.get<{ Querystring: SemanticMemoryEntriesQuery }>("/api/memory/entries", async (request, reply) => {
    try {
      return listMemories({
        limit: parseLimitValue(request.query.limit, 50),
        offset: request.query.offset ? Math.max(0, Number.parseInt(request.query.offset, 10) || 0) : 0,
        source: request.query.source
          ? normalizeSemanticMemorySource(request.query.source, "manual")
          : undefined,
        durability: request.query.durability
          ? normalizeSemanticMemoryDurability(request.query.durability)
          : undefined,
        orderBy: normalizeSemanticMemoryOrderBy(request.query.orderBy),
        order: normalizeSortOrder(request.query.order),
      });
    } catch (error) {
      if (error instanceof Error) {
        return reply.code(400).send({
          error: "invalid_memory_query",
          detail: error.message,
        });
      }
      throw error;
    }
  });
  server.post<{ Body: CreateSemanticMemoryBody }>("/api/memory/entries", async (request, reply) => {
    const body = request.body ?? {};
    const content = body.content?.trim();
    if (!content) {
      return reply.code(400).send({
        error: "content_required",
      });
    }

    try {
      const memory = await createMemory({
        content,
        source: normalizeSemanticMemorySource(body.source, "manual"),
        durability: normalizeSemanticMemoryDurability(body.durability, "permanent") ?? "permanent",
        relatedTopics: Array.isArray(body.relatedTopics) ? body.relatedTopics : undefined,
      });
      return reply.code(201).send(memory);
    } catch (error) {
      if (error instanceof Error) {
        return reply.code(400).send({
          error: "invalid_memory",
          detail: error.message,
        });
      }
      throw error;
    }
  });
  server.get<{ Querystring: SemanticMemorySearchQuery }>("/api/memory/search", async (request, reply) => {
    const query = request.query.q?.trim();
    if (!query) {
      return reply.code(400).send({
        error: "query_required",
      });
    }

    return searchMemoriesBySimilarity(
      query,
      parseLimitValue(request.query.limit, 10),
      parseThresholdValue(request.query.threshold, getMemoryConfig().similarityThreshold),
    );
  });
  server.get<{ Params: MemoryParams }>("/api/memory/entries/:id", async (request, reply) => {
    const memory = getMemoryById(request.params.id);
    if (!memory) {
      return reply.code(404).send({
        error: "memory_not_found",
      });
    }

    return memory;
  });
  server.put<{ Params: MemoryParams; Body: UpdateSemanticMemoryBody }>("/api/memory/entries/:id", async (request, reply) => {
    try {
      const memory = await updateMemory(request.params.id, {
        content: request.body?.content,
        durability: normalizeSemanticMemoryDurability(request.body?.durability),
        relatedTopics: Array.isArray(request.body?.relatedTopics) ? request.body.relatedTopics : undefined,
      });

      if (!memory) {
        return reply.code(404).send({
          error: "memory_not_found",
        });
      }

      return memory;
    } catch (error) {
      if (error instanceof Error) {
        return reply.code(400).send({
          error: "invalid_memory_update",
          detail: error.message,
        });
      }
      throw error;
    }
  });
  server.delete<{ Params: MemoryParams }>("/api/memory/entries/:id", async (request, reply) => {
    if (!deleteMemory(request.params.id)) {
      return reply.code(404).send({
        error: "memory_not_found",
      });
    }

    return {
      ok: true,
      id: request.params.id,
    };
  });
  server.delete("/api/memory/entries", async () => {
    clearAllMemories();
    return {
      ok: true,
    };
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

  server.get("/api/cron", async () => listCronJobs());
  server.post<{ Body: CreateCronJobBody }>("/api/cron", async (request, reply) => {
    try {
      return createCronJob({
        name: request.body?.name ?? "",
        schedule: request.body?.schedule ?? "",
        prompt: request.body?.prompt ?? "",
        sessionId: request.body?.sessionId ?? null,
      });
    } catch (error) {
      if (error instanceof Error) {
        switch (error.message) {
          case "cron_name_required":
          case "cron_prompt_required":
          case "cron_schedule_required":
          case "invalid_cron_schedule":
          case "cron_schedule_in_past":
            return reply.code(400).send({
              error: error.message,
            });
          default:
            break;
        }
      }

      throw error;
    }
  });
  server.delete<{ Params: CronJobParams }>("/api/cron/:id", async (request, reply) => {
    const deleted = deleteCronJob(request.params.id);
    if (!deleted) {
      return reply.code(404).send({
        error: "cron_not_found",
      });
    }

    return {
      ok: true,
      cron: deleted,
    };
  });

  server.get<{ Querystring: PlanQuery }>("/api/plans", async (request) => {
    return listPlans({
      status: request.query.status,
      limit: parseLimitValue(request.query.limit, 50),
    });
  });
  server.post<{ Body: CreatePlanBody }>("/api/plans", async (request, reply) => {
    const sessionId = request.body?.sessionId?.trim() || null;
    if (sessionId && !hasSession(sessionId)) {
      return reply.code(400).send({
        error: "session_not_found",
      });
    }

    try {
      return createPlan({
        sessionId,
        title: request.body?.title ?? "",
        goal: request.body?.goal,
        steps: Array.isArray(request.body?.steps) ? request.body.steps : [],
      });
    } catch (error) {
      if (error instanceof Error && error.message === "plan_title_required") {
        return reply.code(400).send({
          error: error.message,
        });
      }

      throw error;
    }
  });
  server.get<{ Params: PlanParams }>("/api/plans/:id", async (request, reply) => {
    const plan = getPlan(request.params.id);
    if (!plan) {
      return reply.code(404).send({
        error: "plan_not_found",
      });
    }

    return plan;
  });
  server.patch<{ Params: PlanParams; Body: UpdatePlanBody }>("/api/plans/:id", async (request, reply) => {
    try {
      const updated = updatePlan({
        planId: request.params.id,
        title: request.body?.title,
        goal: request.body?.goal,
        steps: Array.isArray(request.body?.steps) ? request.body.steps : undefined,
        status: normalizePlanStatusValue(request.body?.status),
      });

      if (!updated) {
        return reply.code(404).send({
          error: "plan_not_found",
        });
      }

      return updated;
    } catch (error) {
      if (error instanceof Error && (error.message === "invalid_plan_status" || error.message === "plan_title_required")) {
        return reply.code(400).send({
          error: error.message,
        });
      }

      throw error;
    }
  });
  server.post<{ Params: PlanParams }>("/api/plans/:id/approve", async (request, reply) => {
    const approved = approvePlan(request.params.id);
    if (!approved) {
      return reply.code(404).send({
        error: "plan_not_found",
      });
    }

    return approved;
  });
  server.post<{ Params: PlanParams }>("/api/plans/:id/archive", async (request, reply) => {
    const archived = archivePlan(request.params.id);
    if (!archived) {
      return reply.code(404).send({
        error: "plan_not_found",
      });
    }

    return archived;
  });

  server.get("/api/projects", async () => listProjectDirectories());

  server.get<{ Params: ProjectParams }>("/api/projects/:id", async (request, reply) => {
    try {
      return getProjectDirectory(request.params.id);
    } catch (error) {
      if (error instanceof ProjectDirectoryNotFoundError) {
        return reply.code(404).send({
          error: "project_not_found",
        });
      }

      throw error;
    }
  });

  server.post<{ Body: CreateProjectBody }>("/api/projects", async (request, reply) => {
    if (!request.body?.path?.trim()) {
      return reply.code(400).send({
        error: "project_path_required",
      });
    }

    try {
      return createProjectDirectory({
        name: request.body?.name,
        path: request.body.path,
        kind: request.body?.kind,
        isDefault: request.body?.isDefault,
      });
    } catch (error) {
      if (error instanceof ProjectDirectoryValidationError) {
        return reply.code(400).send({
          error: error.message,
        });
      }

      throw error;
    }
  });

  server.put<{ Params: ProjectParams; Body: UpdateProjectBody }>("/api/projects/:id", async (request, reply) => {
    try {
      const result = updateProjectDirectory({
        id: request.params.id,
        name: request.body?.name,
        path: request.body?.path,
        isDefault: request.body?.isDefault,
      });
      const syncResult = await resyncProjectSessionHistories(result.project.id, result.previousPath);
      return {
        project: result.project,
        migratedSessionCount: syncResult.sessionCount,
      };
    } catch (error) {
      if (error instanceof ProjectDirectoryNotFoundError) {
        return reply.code(404).send({
          error: "project_not_found",
        });
      }

      if (error instanceof ProjectDirectoryValidationError) {
        return reply.code(400).send({
          error: error.message,
        });
      }

      throw error;
    }
  });

  server.delete<{ Params: ProjectParams }>("/api/projects/:id", async (request, reply) => {
    try {
      return deleteProjectDirectory(request.params.id);
    } catch (error) {
      if (error instanceof ProjectDirectoryNotFoundError) {
        return reply.code(404).send({
          error: "project_not_found",
        });
      }

      if (error instanceof ProjectDirectoryInUseError) {
        return reply.code(409).send({
          error: "project_in_use",
        });
      }

      if (error instanceof ProjectDirectoryValidationError) {
        return reply.code(400).send({
          error: error.message,
        });
      }

      throw error;
    }
  });

  server.get("/api/sessions", async () => listSessionThreads());

  server.post<{ Body: CreateSessionBody }>("/api/sessions", async (request, reply) => {
    try {
      return createSession({
        title: request.body?.title,
        projectId: request.body?.projectId,
      });
    } catch (error) {
      if (error instanceof ProjectDirectoryNotFoundError) {
        return reply.code(404).send({
          error: "project_not_found",
        });
      }

      throw error;
    }
  });
  server.delete<{ Params: SessionParams }>("/api/sessions/:id", async (request, reply) => {
    const deleted = deleteSession(request.params.id);
    if (!deleted) {
      return reply.code(404).send({
        error: "session_not_found",
      });
    }

    return {
      ok: true,
      session: deleted,
    };
  });

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

    if (body.taskType === "tracked-task") {
      if (!body.title?.trim()) {
        return reply.code(400).send({
          error: "title_required",
        });
      }

      return createTrackedTask({
        title: body.title,
        sessionId: body.sessionId ?? null,
        detail: body.detail,
        steps: Array.isArray(body.steps) ? body.steps : [],
      });
    }

    return reply.code(400).send({
      error: "unsupported_task_type",
      supportedTaskTypes: ["document-ingest", "review-coach", "script-runner", "tracked-task"],
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
  server.patch<{ Params: TaskParams; Body: UpdateTaskBody }>("/api/tasks/:id", async (request, reply) => {
    const existing = getTaskRun(request.params.id);
    if (!existing) {
      return reply.code(404).send({
        error: "task_not_found",
      });
    }

    if (existing.taskType !== "tracked-task") {
      return reply.code(409).send({
        error: "task_not_mutable",
      });
    }

    try {
      const updated = updateTrackedTask({
        taskId: request.params.id,
        title: request.body?.title,
        detail: request.body?.detail,
        status: normalizeTrackedTaskStatus(request.body?.status),
        steps: Array.isArray(request.body?.steps) ? request.body.steps : undefined,
        stepIndex:
          typeof request.body?.step === "number" && Number.isInteger(request.body.step)
            ? request.body.step - 1
            : undefined,
        stepDone: normalizeTrackedTaskStepDone(request.body?.stepStatus),
      });

      if (!updated) {
        return reply.code(404).send({
          error: "task_not_found",
        });
      }

      return updated;
    } catch (error) {
      if (error instanceof Error && error.message === "tracked_task_step_out_of_range") {
        return reply.code(400).send({
          error: "tracked_task_step_out_of_range",
        });
      }

      if (error instanceof Error && (error.message === "invalid_task_status" || error.message === "invalid_step_status")) {
        return reply.code(400).send({
          error: error.message,
        });
      }

      throw error;
    }
  });
  server.post<{ Params: TaskParams }>("/api/tasks/:id/done", async (request, reply) => {
    const existing = getTaskRun(request.params.id);
    if (!existing) {
      return reply.code(404).send({
        error: "task_not_found",
      });
    }

    if (existing.taskType !== "tracked-task") {
      return reply.code(409).send({
        error: "task_not_mutable",
      });
    }

    const updated = updateTrackedTask({
      taskId: request.params.id,
      status: "done",
      markAllStepsDone: true,
    });

    if (!updated) {
      return reply.code(404).send({
        error: "task_not_found",
      });
    }

    return updated;
  });
  server.delete<{ Params: TaskParams }>("/api/tasks/:id", async (request, reply) => {
    const deleted = deleteTrackedTask(request.params.id);
    if (!deleted) {
      return reply.code(404).send({
        error: "task_not_found",
      });
    }

    return {
      ok: true,
      task: deleted,
    };
  });

  server.get<{ Params: SessionParams }>("/api/session/:id/snapshot", async (request) => {
    return getSessionSnapshot(request.params.id);
  });

  server.get<{ Params: SessionParams }>("/api/session/:id/project", async (request, reply) => {
    try {
      return getSessionSnapshot(request.params.id).project;
    } catch {
      return reply.code(404).send({
        error: "session_not_found",
      });
    }
  });

  server.put<{ Params: SessionParams; Body: UpdateSessionProjectBody }>("/api/session/:id/project", async (request, reply) => {
    try {
      const result = await assignSessionProjectAndSync(request.params.id, request.body?.projectId ?? null);
      return result;
    } catch (error) {
      if (error instanceof ProjectDirectoryNotFoundError) {
        return reply.code(404).send({
          error: "project_not_found",
        });
      }

      if (error instanceof Error && error.message.includes("was not found")) {
        return reply.code(404).send({
          error: "session_not_found",
        });
      }

      throw error;
    }
  });

  server.post<{ Params: ToolApprovalParams }>("/api/session/:id/tool-approvals/:approvalId/approve", async (request, reply) => {
    try {
      return {
        approval: approveSessionToolApproval(request.params.id, request.params.approvalId),
      };
    } catch (error) {
      if (error instanceof ToolApprovalNotFoundError) {
        return reply.code(404).send({
          error: "tool_approval_not_found",
        });
      }

      throw error;
    }
  });

  server.post<{ Params: ToolApprovalParams }>("/api/session/:id/tool-approvals/:approvalId/reject", async (request, reply) => {
    try {
      return {
        approval: rejectSessionToolApproval(request.params.id, request.params.approvalId),
      };
    } catch (error) {
      if (error instanceof ToolApprovalNotFoundError) {
        return reply.code(404).send({
          error: "tool_approval_not_found",
        });
      }

      throw error;
    }
  });

  server.post<{ Params: SessionParams }>("/api/session/:id/abort", async (request) => {
    return {
      aborted: abortAgentForSession(request.params.id),
    };
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

    await syncSessionProjectHistory(request.params.id);

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

  server.get<{ Params: SessionMessageParams }>("/api/session/:id/messages/:messageId/reactions", async (request, reply) => {
    if (!hasSession(request.params.id)) {
      return reply.code(404).send({
        error: "session_not_found",
      });
    }

    try {
      return listSessionMessageReactions(request.params.id, request.params.messageId);
    } catch {
      return reply.code(404).send({
        error: "message_not_found",
      });
    }
  });

  server.post<{ Params: SessionMessageParams; Body: CreateReactionBody }>(
    "/api/session/:id/messages/:messageId/reactions",
    async (request, reply) => {
      if (!hasSession(request.params.id)) {
        return reply.code(404).send({
          error: "session_not_found",
        });
      }

      const emoji = request.body?.emoji?.trim();
      const deviceId = request.body?.deviceId?.trim() || "aliceloop-cli";
      if (!emoji) {
        return reply.code(400).send({
          error: "emoji_required",
        });
      }

      try {
        return addSessionMessageReaction({
          sessionId: request.params.id,
          messageId: request.params.messageId,
          emoji,
          deviceId,
        });
      } catch {
        return reply.code(404).send({
          error: "message_not_found",
        });
      }
    },
  );

  server.delete<{ Params: SessionMessageParams; Querystring: DeleteReactionQuery }>(
    "/api/session/:id/messages/:messageId/reactions",
    async (request, reply) => {
      if (!hasSession(request.params.id)) {
        return reply.code(404).send({
          error: "session_not_found",
        });
      }

      const emoji = request.query?.emoji?.trim();
      const deviceId = request.query?.deviceId?.trim() || "aliceloop-cli";
      if (!emoji) {
        return reply.code(400).send({
          error: "emoji_required",
        });
      }

      try {
        return removeSessionMessageReaction({
          sessionId: request.params.id,
          messageId: request.params.messageId,
          emoji,
          deviceId,
        });
      } catch {
        return reply.code(404).send({
          error: "message_not_found",
        });
      }
    },
  );

  server.post<{ Params: SessionParams; Body: CreateAttachmentBody }>("/api/session/:id/attachments", async (request, reply) => {
    const { fileName, mimeType, contentBase64, originalPath, deviceType } = request.body;

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
    const runtimeSettings = getRuntimeSettings();
    const sandbox = createPermissionSandboxExecutor({
      label: `attachment:${request.params.id}:${fileName}`,
      permissionProfile: runtimeSettings.sandboxProfile,
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
      originalPath,
    });

    for (const event of result.events) {
      publishSessionEvent(event);
    }

    await syncSessionProjectHistory(request.params.id);

    return {
      attachment: result.attachment,
      jobs: result.jobs,
      lastEventSeq: result.events.at(-1)?.seq ?? getSessionSnapshot(request.params.id).lastEventSeq,
    };
  });

  server.post<{ Params: SessionParams; Body: CreateFolderAttachmentBody }>("/api/session/:id/attachment-folders", async (request, reply) => {
    const { folderName, files, deviceType } = request.body;

    if (!folderName || !Array.isArray(files) || files.length === 0) {
      return reply.code(400).send({
        error: "folderName and files are required",
      });
    }

    if (!canAcceptClientTraffic(deviceType)) {
      return reply.code(409).send({
        error: "runtime_offline",
        runtimePresence: getRuntimePresence(),
      });
    }

    const safeFolderName = sanitizeFileName(folderName) || "folder";
    const folderStoragePath = join(getUploadsDir(), `${randomUUID()}-${safeFolderName}`);
    const runtimeSettings = getRuntimeSettings();
    const sandbox = createPermissionSandboxExecutor({
      label: `attachment-folder:${request.params.id}:${folderName}`,
      permissionProfile: runtimeSettings.sandboxProfile,
    });

    let totalBytes = 0;

    for (const file of files) {
      if (!file?.relativePath || !file.contentBase64) {
        return reply.code(400).send({
          error: "each folder file requires relativePath and contentBase64",
        });
      }

      const relativePath = sanitizeRelativePath(file.relativePath);
      const binary = Buffer.from(file.contentBase64, "base64");
      totalBytes += binary.byteLength;

      await sandbox.writeBinaryFile({
        targetPath: join(folderStoragePath, relativePath),
        content: binary,
      });
    }

    const result = createAttachment({
      sessionId: request.params.id,
      fileName: folderName,
      mimeType: "inode/directory",
      byteSize: totalBytes,
      storagePath: folderStoragePath,
    });

    for (const event of result.events) {
      publishSessionEvent(event);
    }

    await syncSessionProjectHistory(request.params.id);

    return {
      attachment: result.attachment,
      jobs: result.jobs,
      lastEventSeq: result.events.at(-1)?.seq ?? getSessionSnapshot(request.params.id).lastEventSeq,
    };
  });

  server.post<{ Body: GenerateImageBody }>("/api/images/generate", async (request, reply) => {
    const prompt = request.body?.prompt?.trim();
    if (!prompt) {
      return reply.code(400).send({
        error: "prompt_required",
      });
    }

    try {
      return await generateImage({
        prompt,
        providerId: request.body?.providerId,
        model: request.body?.model,
        size: request.body?.size,
        outputPath: request.body?.outputPath,
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get("/api/runtime/presence", async () => getRuntimePresence());
  server.get("/api/runtime/settings", async () => getRuntimeSettings());
  server.put<{ Body: UpdateRuntimeSettingsBody }>("/api/runtime/settings", async (request) => {
    return updateRuntimeSettings({
      sandboxProfile: request.body?.sandboxProfile,
    });
  });

  // User Profile
  server.get("/api/user/profile", async () => getUserProfile());
  server.put<{ Body: { displayName?: string; preferredLanguage?: string; timezone?: string; codeStyle?: string; notes?: string } }>(
    "/api/user/profile",
    async (request) => {
      return updateUserProfile({
        displayName: request.body?.displayName,
        preferredLanguage: request.body?.preferredLanguage,
        timezone: request.body?.timezone,
        codeStyle: request.body?.codeStyle,
        notes: request.body?.notes,
      });
    },
  );
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
