#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateMusicSketch } from "../services/musicSketchService";
import { analyzeAudioFile, analyzeVideoFile } from "../services/multimodalAnalysisService";

interface CliIO {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

interface HealthPayload {
  ok: boolean;
  service: string;
  timestamp: string;
  activeSkills: string[];
  activeSkillAdapters: string[];
}

interface SemanticMemoryPayload {
  id: string;
  content: string;
  source: string;
  durability: string;
  factKind: string | null;
  factKey: string | null;
  factState: string;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  relatedTopics: string[];
  similarityScore?: number;
}

interface RuntimeSettingsPayload {
  sandboxProfile: string;
  autoApproveToolRequests: boolean;
  reasoningEffort: string;
  toolProviderId: string | null;
  toolModel: string | null;
  updatedAt: string | null;
}

interface UserProfilePayload {
  displayName: string | null;
  preferredLanguage: string | null;
  timezone: string | null;
  codeStyle: string | null;
  notes: string | null;
  updatedAt: string;
}

interface ProviderConfigPayload {
  id: string;
  label: string;
  transport: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
}

interface SessionThreadSummaryPayload {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  latestMessagePreview: string | null;
  latestMessageAt: string | null;
  matchedPreview?: string | null;
  matchedMessageCreatedAt?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
}

interface SessionSnapshotPayload {
  session: {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  };
  messages: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: string;
  }>;
  attachments: Array<{ id: string }>;
  jobs: Array<{ id: string; kind: string; status: string; title: string; updatedAt: string }>;
  pendingToolApprovals: Array<{ id: string }>;
  resolvedToolApprovals: Array<{ id: string }>;
  lastEventSeq: number;
}

interface TaskRunPayload {
  id: string;
  sessionId: string | null;
  taskType: string;
  status: string;
  title: string;
  detail: string;
  updatedAt: string;
  updatedAtLabel: string;
}

interface CronJobPayload {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  sessionId: string | null;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

interface PlanPayload {
  id: string;
  sessionId: string | null;
  title: string;
  goal: string;
  steps: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}

interface SkillPayload {
  id: string;
  label: string;
  description: string;
  status: string;
  mode: string;
  sourcePath: string;
  allowedTools: string[];
}

interface AttachmentPayload {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  storagePath: string;
  status: string;
  createdAt: string;
}

interface CreateAttachmentResponsePayload {
  attachment: AttachmentPayload;
  lastEventSeq: number;
}

interface CreateMessageResponsePayload {
  created: boolean;
  message: {
    id: string;
    sessionId: string;
    content: string;
    createdAt: string;
  };
  lastEventSeq: number;
}

interface MessageReactionPayload {
  id: string;
  sessionId: string;
  messageId: string;
  emoji: string;
  deviceId: string;
  createdAt: string;
}

interface GeneratedImagePayload {
  providerId: string;
  model: string;
  prompt: string;
  revisedPrompt: string | null;
  size: string;
  outputPath: string;
  mimeType: string;
  byteSize: number;
  source: "b64_json" | "url";
}

interface ConfigSnapshot {
  runtime: RuntimeSettingsPayload;
  user: UserProfilePayload;
  providers: ProviderConfigPayload[];
}

class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

const defaultIo: CliIO = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

function getDaemonBaseUrl() {
  const explicitUrl = process.env.ALICELOOP_DAEMON_URL?.trim();
  if (explicitUrl) {
    return explicitUrl.replace(/\/+$/, "");
  }

  const host = process.env.ALICELOOP_DAEMON_HOST ?? "127.0.0.1";
  const port = process.env.ALICELOOP_DAEMON_PORT ?? "3030";
  return `http://${host}:${port}`;
}

function usage() {
  return [
    "Usage:",
    "  aliceloop status",
    "  aliceloop memory list [limit]",
    "  aliceloop memory search <query>",
    "  aliceloop memory grep <query>",
    "  aliceloop memory archive",
    "  aliceloop memory add <content>",
    "  aliceloop memory delete <id>",
    "  aliceloop config list",
    "  aliceloop config get <path>",
    "  aliceloop config set <path> <value>",
    "  aliceloop providers",
    "  aliceloop threads [limit]",
    "  aliceloop thread info <id>",
    "  aliceloop thread new [title]",
    "  aliceloop thread search <query>",
    "  aliceloop thread delete <id>",
    "  aliceloop tasks list [all|done|running|queued]",
    "  aliceloop tasks add <title> [--detail <text>] [--steps <comma,separated,steps>]",
    "  aliceloop tasks update <id> [--title <text>] [--detail <text>] [--steps <comma,separated,steps>] [--status <queued|running|done|failed>] [--step <n>] [--step-status <pending|done>]",
    "  aliceloop tasks done <id>",
    "  aliceloop tasks show <id>",
    "  aliceloop tasks delete <id>",
    "  aliceloop plan list [all|draft|approved|archived]",
    "  aliceloop plan create <title> [--goal <text>] [--steps <comma,separated,steps>] [--session <id>]",
    "  aliceloop plan show <id>",
    "  aliceloop plan update <id> [--title <text>] [--goal <text>] [--steps <comma,separated,steps>] [--status <draft|approved|archived>]",
    "  aliceloop plan approve <id>",
    "  aliceloop plan archive <id>",
    "  aliceloop skills list",
    "  aliceloop skills show <id>",
    "  aliceloop skills search <query>",
    "  aliceloop cron list",
    "  aliceloop cron add <name> at <schedule> --prompt <text> [--session <id>]",
    "  aliceloop cron remove <id>",
    "  aliceloop send file <path> [caption] [--session <id>]",
    "  aliceloop send photo <path> [caption] [--session <id>]",
    "  aliceloop screenshot [--output <path>]",
    "  aliceloop reaction list <sessionId> <messageId>",
    "  aliceloop reaction add <sessionId> <messageId> <emoji> [--device <id>]",
    "  aliceloop reaction remove <sessionId> <messageId> <emoji> [--device <id>]",
    "  aliceloop voice list",
    "  aliceloop voice speak <text> [--voice <name>] [--rate <wpm>]",
    "  aliceloop voice save <output> <text> [--voice <name>] [--rate <wpm>]",
    "  aliceloop audio analyze <path> [prompt] [--keep-artifacts]",
    "  aliceloop image generate <prompt> [--provider <id>] [--model <name>] [--size <WxH>] [--output <path>]",
    "  aliceloop video analyze <path> [prompt] [--keep-artifacts]",
    "  aliceloop telegram me [--token <botToken>]",
    "  aliceloop telegram send <chatId> <message> [--token <botToken>] [--thread <id>]",
    "  aliceloop telegram file <chatId> <path> [caption] [--token <botToken>] [--thread <id>]",
    "  aliceloop discord send <message> [--webhook <url>] [--username <name>]",
    "  aliceloop discord file <path> [caption] [--webhook <url>] [--username <name>]",
    "  aliceloop music generate <prompt> [--output <path>] [--tempo <bpm>] [--bars <count>]",
  ].join("\n");
}

function parseJsonSafe(text: string) {
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function renderValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}

async function apiRequest<T>(path: string, init: RequestInit = {}) {
  const baseUrl = getDaemonBaseUrl();
  let response: Response;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `Unable to reach Aliceloop daemon at ${baseUrl}. Start the daemon first or set ALICELOOP_DAEMON_URL.\n${detail}`,
    );
  }

  const text = await response.text();
  const payload = parseJsonSafe(text);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : response.statusText;
    throw new CliError(`Daemon request failed (${response.status}): ${message}`);
  }

  return payload as T;
}

async function externalJsonRequest(url: string, init: RequestInit = {}) {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`External request failed for ${url}.\n${detail}`);
  }

  const text = await response.text();
  const payload = parseJsonSafe(text);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "description" in payload
        ? String((payload as { description: unknown }).description)
        : payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : response.statusText;
    throw new CliError(`External request failed (${response.status}): ${message}`);
  }

  return payload;
}

function parseOptionalLimit(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`Invalid limit: ${value}`);
  }

  return Math.trunc(parsed);
}

function parseBoolean(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new CliError(`Invalid boolean value: ${value}`);
}

function parseNullableString(value: string) {
  return value.trim().toLowerCase() === "null" ? null : value;
}

function parseFlagArgs(args: string[]) {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
      continue;
    }

    flags[key] = "true";
  }

  return {
    positionals,
    flags,
  };
}

function splitSteps(rawValue: string | undefined) {
  if (!rawValue) {
    return undefined;
  }

  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitCsv(rawValue: string | undefined) {
  return splitSteps(rawValue);
}

function parseVoiceRate(rawValue: string | undefined) {
  if (!rawValue) {
    return undefined;
  }

  const rate = Number(rawValue);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new CliError(`Invalid voice rate: ${rawValue}`);
  }

  return Math.trunc(rate);
}

function parsePositiveInteger(rawValue: string | undefined, label: string) {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`Invalid ${label}: ${rawValue}`);
  }

  return Math.trunc(parsed);
}

function detectMimeType(filePath: string, forcePhoto = false) {
  const extension = extname(filePath).toLowerCase();
  const imageTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
  };
  const commonTypes: Record<string, string> = {
    ...imageTypes,
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".csv": "text/csv",
    ".zip": "application/zip",
  };

  if (forcePhoto) {
    return imageTypes[extension] ?? "image/jpeg";
  }

  return commonTypes[extension] ?? "application/octet-stream";
}

function requireTelegramBotToken(rawToken: string | undefined) {
  const token = rawToken?.trim() || process.env.ALICELOOP_TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new CliError("telegram commands require --token or ALICELOOP_TELEGRAM_BOT_TOKEN");
  }

  return token;
}

function getTelegramApiBase() {
  return (process.env.ALICELOOP_TELEGRAM_API_BASE?.trim() || "https://api.telegram.org/bot").replace(/\/+$/, "");
}

async function telegramRequest(token: string, method: string, init: RequestInit = {}) {
  const payload = await externalJsonRequest(`${getTelegramApiBase()}/${encodeURIComponent(token)}/${method}`, init);
  if (payload && typeof payload === "object" && "ok" in payload && "result" in payload) {
    const envelope = payload as { ok: boolean; result: unknown; description?: unknown };
    if (!envelope.ok) {
      throw new CliError(`Telegram request failed: ${String(envelope.description ?? "unknown error")}`);
    }

    return envelope.result;
  }

  return payload;
}

function requireDiscordWebhookUrl(rawUrl: string | undefined) {
  const webhookUrl = rawUrl?.trim() || process.env.ALICELOOP_DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new CliError("discord commands require --webhook or ALICELOOP_DISCORD_WEBHOOK_URL");
  }

  return webhookUrl;
}

async function discordWebhookRequest(webhookUrl: string, init: RequestInit) {
  const url = new URL(webhookUrl);
  if (!url.searchParams.has("wait")) {
    url.searchParams.set("wait", "true");
  }

  const payload = await externalJsonRequest(url.toString(), init);
  return payload ?? { ok: true };
}

async function fetchConfigSnapshot(): Promise<ConfigSnapshot> {
  const [runtime, user, providers] = await Promise.all([
    apiRequest<RuntimeSettingsPayload>("/api/runtime/settings"),
    apiRequest<UserProfilePayload>("/api/user/profile"),
    apiRequest<ProviderConfigPayload[]>("/api/providers"),
  ]);

  return {
    runtime,
    user,
    providers,
  };
}

function flattenConfigSnapshot(snapshot: ConfigSnapshot) {
  const flattened: Record<string, string | boolean | null> = {
    "runtime.sandboxProfile": snapshot.runtime.sandboxProfile,
    "runtime.autoApproveToolRequests": snapshot.runtime.autoApproveToolRequests,
    "runtime.reasoningEffort": snapshot.runtime.reasoningEffort,
    "runtime.toolProviderId": snapshot.runtime.toolProviderId,
    "runtime.toolModel": snapshot.runtime.toolModel,
    "runtime.updatedAt": snapshot.runtime.updatedAt,
    "user.displayName": snapshot.user.displayName,
    "user.preferredLanguage": snapshot.user.preferredLanguage,
    "user.timezone": snapshot.user.timezone,
    "user.codeStyle": snapshot.user.codeStyle,
    "user.notes": snapshot.user.notes,
    "user.updatedAt": snapshot.user.updatedAt,
  };

  for (const provider of snapshot.providers) {
    flattened[`providers.${provider.id}.transport`] = provider.transport;
    flattened[`providers.${provider.id}.baseUrl`] = provider.baseUrl;
    flattened[`providers.${provider.id}.model`] = provider.model;
    flattened[`providers.${provider.id}.enabled`] = provider.enabled;
    flattened[`providers.${provider.id}.hasApiKey`] = provider.hasApiKey;
    flattened[`providers.${provider.id}.apiKeyMasked`] = provider.apiKeyMasked;
    flattened[`providers.${provider.id}.updatedAt`] = provider.updatedAt;
  }

  return flattened;
}

function resolveConfigValue(snapshot: ConfigSnapshot, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) {
    throw new CliError("config path is required");
  }

  if (segments[0] === "runtime") {
    if (segments.length === 1) {
      return snapshot.runtime;
    }

    const key = segments[1] as keyof RuntimeSettingsPayload;
    if (!(key in snapshot.runtime)) {
      throw new CliError(`Unknown runtime config path: ${path}`);
    }

    return snapshot.runtime[key];
  }

  if (segments[0] === "user") {
    if (segments.length === 1) {
      return snapshot.user;
    }

    const key = segments[1] as keyof UserProfilePayload;
    if (!(key in snapshot.user)) {
      throw new CliError(`Unknown user config path: ${path}`);
    }

    return snapshot.user[key];
  }

  if (segments[0] === "providers") {
    if (segments.length === 1) {
      return snapshot.providers;
    }

    const provider = snapshot.providers.find((entry) => entry.id === segments[1]);
    if (!provider) {
      throw new CliError(`Unknown provider id in config path: ${path}`);
    }

    if (segments.length === 2) {
      return provider;
    }

    const key = segments[2] as keyof ProviderConfigPayload;
    if (!(key in provider)) {
      throw new CliError(`Unknown provider config path: ${path}`);
    }

    return provider[key];
  }

  throw new CliError(`Unknown config namespace: ${segments[0]}`);
}

async function setConfigValue(path: string, rawValue: string) {
  const segments = path.split(".").filter(Boolean);
  if (segments.length < 2) {
    throw new CliError(`Unsupported config path: ${path}`);
  }

  if (segments[0] === "runtime") {
    if (segments[1] === "sandboxProfile") {
      const sandboxProfile = rawValue.trim();
      if (sandboxProfile !== "development" && sandboxProfile !== "full-access") {
        throw new CliError("runtime.sandboxProfile must be development or full-access");
      }

      return apiRequest<RuntimeSettingsPayload>("/api/runtime/settings", {
        method: "PUT",
        body: JSON.stringify({ sandboxProfile }),
      });
    }

    if (segments[1] === "autoApproveToolRequests") {
      const autoApproveToolRequests = parseBoolean(rawValue);
      return apiRequest<RuntimeSettingsPayload>("/api/runtime/settings", {
        method: "PUT",
        body: JSON.stringify({ autoApproveToolRequests }),
      });
    }

    if (segments[1] === "reasoningEffort") {
      const reasoningEffort = rawValue.trim();
      if (!["off", "low", "medium", "high", "xhigh"].includes(reasoningEffort)) {
        throw new CliError("runtime.reasoningEffort must be off, low, medium, high, or xhigh");
      }

      return apiRequest<RuntimeSettingsPayload>("/api/runtime/settings", {
        method: "PUT",
        body: JSON.stringify({ reasoningEffort }),
      });
    }

    if (segments[1] === "toolProviderId") {
      const toolProviderId = rawValue.trim() || null;
      return apiRequest<RuntimeSettingsPayload>("/api/runtime/settings", {
        method: "PUT",
        body: JSON.stringify({ toolProviderId }),
      });
    }

    if (segments[1] === "toolModel") {
      const toolModel = rawValue.trim() || null;
      return apiRequest<RuntimeSettingsPayload>("/api/runtime/settings", {
        method: "PUT",
        body: JSON.stringify({ toolModel }),
      });
    }

    throw new CliError(`Unsupported runtime config path: ${path}`);
  }

  if (segments[0] === "user") {
    const field = segments[1];
    if (!["displayName", "preferredLanguage", "timezone", "codeStyle", "notes"].includes(field)) {
      throw new CliError(`Unsupported user config path: ${path}`);
    }

    return apiRequest<UserProfilePayload>("/api/user/profile", {
      method: "PUT",
      body: JSON.stringify({
        [field]: parseNullableString(rawValue),
      }),
    });
  }

  if (segments[0] === "providers" && segments.length >= 3) {
    const providerId = segments[1];
    const field = segments[2];

    const updateBody: Record<string, unknown> = {};
    if (field === "enabled") {
      updateBody.enabled = parseBoolean(rawValue);
    } else if (field === "transport" || field === "baseUrl" || field === "model" || field === "apiKey") {
      updateBody[field] = rawValue;
    } else {
      throw new CliError(`Unsupported provider config path: ${path}`);
    }

    return apiRequest<ProviderConfigPayload>(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: "PUT",
      body: JSON.stringify(updateBody),
    });
  }

  throw new CliError(`Unsupported config path: ${path}`);
}

async function handleStatus() {
  const payload = await apiRequest<HealthPayload>("/health");
  return {
    daemonUrl: getDaemonBaseUrl(),
    ...payload,
  };
}

async function handleMemory(args: string[]) {
  const action = args[0];

  if (action === "list") {
    const limit = parseOptionalLimit(args[1], 20);
    return apiRequest<SemanticMemoryPayload[]>(`/api/memory/entries?limit=${limit}`);
  }

  if (action === "search") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      throw new CliError("memory search requires a query");
    }

    const params = new URLSearchParams({
      q: query,
      limit: "10",
    });
    return apiRequest<SemanticMemoryPayload[]>(`/api/memory/search?${params.toString()}`);
  }

  if (action === "grep") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      throw new CliError("memory grep requires a query");
    }

    const params = new URLSearchParams({
      q: query,
      limit: "10",
    });
    return apiRequest<SessionThreadSummaryPayload[]>(`/api/threads/search?${params.toString()}`);
  }

  if (action === "archive") {
    return apiRequest<{ projectCount: number; sessionCount: number }>("/api/memory/archive", {
      method: "POST",
    });
  }

  if (action === "add") {
    const content = args.slice(1).join(" ").trim();
    if (!content) {
      throw new CliError("memory add requires content");
    }

    return apiRequest<SemanticMemoryPayload>("/api/memory/entries", {
      method: "POST",
      body: JSON.stringify({
        content,
        source: "manual",
        durability: "permanent",
      }),
    });
  }

  if (action === "delete") {
    const memoryId = args[1]?.trim();
    if (!memoryId) {
      throw new CliError("memory delete requires an id");
    }

    return apiRequest<{ ok: boolean; id: string }>(`/api/memory/entries/${encodeURIComponent(memoryId)}`, {
      method: "DELETE",
    });
  }

  throw new CliError(`Unknown memory command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleConfig(args: string[]) {
  const action = args[0];

  if (action === "list") {
    const snapshot = await fetchConfigSnapshot();
    return flattenConfigSnapshot(snapshot);
  }

  if (action === "get") {
    const path = args[1]?.trim();
    if (!path) {
      throw new CliError("config get requires a path");
    }

    const snapshot = await fetchConfigSnapshot();
    return resolveConfigValue(snapshot, path);
  }

  if (action === "set") {
    const path = args[1]?.trim();
    const value = args.slice(2).join(" ");
    if (!path || !value.trim()) {
      throw new CliError("config set requires a path and value");
    }

    return setConfigValue(path, value);
  }

  throw new CliError(`Unknown config command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleProviders() {
  return apiRequest<ProviderConfigPayload[]>("/api/providers");
}

async function handleThreads(args: string[]) {
  const limit = parseOptionalLimit(args[0], 20);
  const threads = await apiRequest<SessionThreadSummaryPayload[]>("/api/sessions");
  return threads.slice(0, limit);
}

async function handleThread(args: string[]) {
  const action = args[0];

  if (action === "info") {
    const sessionId = args[1]?.trim();
    if (!sessionId) {
      throw new CliError("thread info requires a session id");
    }

    const snapshot = await apiRequest<SessionSnapshotPayload>(`/api/session/${encodeURIComponent(sessionId)}/snapshot`);
    return {
      session: snapshot.session,
      messageCount: snapshot.messages.length,
      attachmentCount: snapshot.attachments.length,
      jobCount: snapshot.jobs.length,
      pendingToolApprovals: snapshot.pendingToolApprovals.length,
      resolvedToolApprovals: snapshot.resolvedToolApprovals.length,
      lastEventSeq: snapshot.lastEventSeq,
      recentMessages: snapshot.messages.slice(-5).map((message) => ({
        role: message.role,
        createdAt: message.createdAt,
        content: message.content,
      })),
    };
  }

  if (action === "new") {
    const title = args.slice(1).join(" ").trim();
    return apiRequest<{ id: string; title: string; createdAt: string; updatedAt: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    });
  }

  if (action === "search") {
    const query = args.slice(1).join(" ").trim().toLowerCase();
    if (!query) {
      throw new CliError("thread search requires a query");
    }

    const params = new URLSearchParams({
      q: query,
      limit: "10",
    });
    return apiRequest<SessionThreadSummaryPayload[]>(`/api/threads/search?${params.toString()}`);
  }

  if (action === "delete") {
    const sessionId = args[1]?.trim();
    if (!sessionId) {
      throw new CliError("thread delete requires a session id");
    }

    return apiRequest<{ ok: boolean; session: { id: string; title: string } }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  throw new CliError(`Unknown thread command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleTasks(args: string[]) {
  const action = args[0];

  if (action === "list") {
    const mode = args[1]?.trim() ?? "open";
    const tasks = await apiRequest<TaskRunPayload[]>("/api/tasks?taskType=tracked-task&limit=100");

    switch (mode) {
      case "open":
        return tasks.filter((task) => task.status !== "done");
      case "all":
        return tasks;
      case "done":
      case "running":
      case "queued":
      case "failed":
        return tasks.filter((task) => task.status === mode);
      default:
        throw new CliError(`Unknown tasks list mode: ${mode}`);
    }
  }

  if (action === "add") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const title = positionals.join(" ").trim();
    if (!title) {
      throw new CliError("tasks add requires a title");
    }

    return apiRequest<TaskRunPayload>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        taskType: "tracked-task",
        title,
        detail: flags.detail,
        steps: splitSteps(flags.steps),
      }),
    });
  }

  if (action === "update") {
    const taskId = args[1]?.trim();
    if (!taskId) {
      throw new CliError("tasks update requires a task id");
    }

    const { flags } = parseFlagArgs(args.slice(2));
    const step = flags.step ? Number(flags.step) : undefined;
    if (flags.step) {
      if (step === undefined || !Number.isFinite(step) || step < 1) {
        throw new CliError(`Invalid task step: ${flags.step}`);
      }
    }

    const stepStatus = flags["step-status"] ?? (step !== undefined ? flags.status : undefined);
    const overallStatus = step !== undefined && !flags["step-status"] ? undefined : flags.status;

    return apiRequest<TaskRunPayload>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: flags.title,
        detail: flags.detail,
        steps: splitSteps(flags.steps),
        status: overallStatus,
        step,
        stepStatus,
      }),
    });
  }

  if (action === "done") {
    const taskId = args[1]?.trim();
    if (!taskId) {
      throw new CliError("tasks done requires a task id");
    }

    return apiRequest<TaskRunPayload>(`/api/tasks/${encodeURIComponent(taskId)}/done`, {
      method: "POST",
    });
  }

  if (action === "show") {
    const taskId = args[1]?.trim();
    if (!taskId) {
      throw new CliError("tasks show requires a task id");
    }

    return apiRequest<TaskRunPayload>(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  if (action === "delete") {
    const taskId = args[1]?.trim();
    if (!taskId) {
      throw new CliError("tasks delete requires a task id");
    }

    return apiRequest<{ ok: boolean; task: TaskRunPayload }>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
    });
  }

  throw new CliError(`Unknown tasks command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handlePlan(args: string[]) {
  const action = args[0];

  if (action === "list") {
    const mode = args[1]?.trim() ?? "draft";
    if (mode === "all") {
      return apiRequest<PlanPayload[]>("/api/plans?limit=100");
    }

    if (!["draft", "approved", "archived"].includes(mode)) {
      throw new CliError(`Unknown plan list mode: ${mode}`);
    }

    return apiRequest<PlanPayload[]>(`/api/plans?status=${encodeURIComponent(mode)}&limit=100`);
  }

  if (action === "create") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const title = positionals.join(" ").trim();
    if (!title) {
      throw new CliError("plan create requires a title");
    }

    return apiRequest<PlanPayload>("/api/plans", {
      method: "POST",
      body: JSON.stringify({
        title,
        goal: flags.goal,
        steps: splitSteps(flags.steps),
        sessionId: flags.session?.trim() || null,
      }),
    });
  }

  if (action === "show") {
    const planId = args[1]?.trim();
    if (!planId) {
      throw new CliError("plan show requires a plan id");
    }

    return apiRequest<PlanPayload>(`/api/plans/${encodeURIComponent(planId)}`);
  }

  if (action === "update") {
    const planId = args[1]?.trim();
    if (!planId) {
      throw new CliError("plan update requires a plan id");
    }

    const { flags } = parseFlagArgs(args.slice(2));
    return apiRequest<PlanPayload>(`/api/plans/${encodeURIComponent(planId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: flags.title,
        goal: flags.goal,
        steps: splitSteps(flags.steps),
        status: flags.status,
      }),
    });
  }

  if (action === "approve") {
    const planId = args[1]?.trim();
    if (!planId) {
      throw new CliError("plan approve requires a plan id");
    }

    return apiRequest<PlanPayload>(`/api/plans/${encodeURIComponent(planId)}/approve`, {
      method: "POST",
    });
  }

  if (action === "archive") {
    const planId = args[1]?.trim();
    if (!planId) {
      throw new CliError("plan archive requires a plan id");
    }

    return apiRequest<PlanPayload>(`/api/plans/${encodeURIComponent(planId)}/archive`, {
      method: "POST",
    });
  }

  throw new CliError(`Unknown plan command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleSkills(args: string[]) {
  const action = args[0];

  if (action === "list") {
    return apiRequest<SkillPayload[]>("/api/skills");
  }

  if (action === "show") {
    const skillId = args[1]?.trim();
    if (!skillId) {
      throw new CliError("skills show requires a skill id");
    }

    return apiRequest<SkillPayload>(`/api/skills/${encodeURIComponent(skillId)}`);
  }

  if (action === "search") {
    const query = args.slice(1).join(" ").trim().toLowerCase();
    if (!query) {
      throw new CliError("skills search requires a query");
    }

    const skills = await apiRequest<SkillPayload[]>("/api/skills");
    return skills.filter((skill) => {
      const haystack = [
        skill.id,
        skill.label,
        skill.description,
        skill.allowedTools.join(" "),
      ]
        .join("\n")
        .toLowerCase();

      return haystack.includes(query);
    });
  }

  throw new CliError(`Unknown skills command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleCron(args: string[]) {
  const action = args[0];

  if (action === "list") {
    return apiRequest<CronJobPayload[]>("/api/cron");
  }

  if (action === "add") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const atIndex = positionals.findIndex((token) => token.toLowerCase() === "at");
    if (atIndex <= 0 || atIndex === positionals.length - 1) {
      throw new CliError("cron add requires '<name> at <schedule>'");
    }

    const name = positionals.slice(0, atIndex).join(" ").trim();
    const schedule = positionals.slice(atIndex + 1).join(" ").trim();
    const prompt = flags.prompt?.trim();

    if (!prompt) {
      throw new CliError("cron add requires --prompt");
    }

    return apiRequest<CronJobPayload>("/api/cron", {
      method: "POST",
      body: JSON.stringify({
        name,
        schedule,
        prompt,
        sessionId: flags.session?.trim() || null,
      }),
    });
  }

  if (action === "remove" || action === "delete") {
    const cronId = args[1]?.trim();
    if (!cronId) {
      throw new CliError("cron remove requires an id");
    }

    return apiRequest<{ ok: boolean; cron: CronJobPayload }>(`/api/cron/${encodeURIComponent(cronId)}`, {
      method: "DELETE",
    });
  }

  throw new CliError(`Unknown cron command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function resolveTargetSessionId(explicitSessionId: string | undefined) {
  const sessionId = explicitSessionId?.trim() || process.env.ALICELOOP_SESSION_ID?.trim();
  if (sessionId) {
    return sessionId;
  }

  const threads = await apiRequest<SessionThreadSummaryPayload[]>("/api/sessions");
  if (threads.length > 0) {
    return threads[0].id;
  }

  const created = await apiRequest<{ id: string }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "CLI Uploads" }),
  });
  return created.id;
}

async function sendAttachment(kind: "file" | "photo", args: string[]) {
  const { positionals, flags } = parseFlagArgs(args);
  const filePath = positionals[0]?.trim();
  if (!filePath) {
    throw new CliError(`send ${kind} requires a path`);
  }

  const caption = positionals.slice(1).join(" ").trim();
  const sessionId = await resolveTargetSessionId(flags.session);
  const binary = readFileSync(filePath);
  const fileName = basename(filePath);
  const mimeType = detectMimeType(filePath, kind === "photo");

  const attachmentPayload = await apiRequest<CreateAttachmentResponsePayload>(`/api/session/${encodeURIComponent(sessionId)}/attachments`, {
    method: "POST",
    body: JSON.stringify({
      fileName,
      mimeType,
      contentBase64: binary.toString("base64"),
      deviceId: "aliceloop-cli",
      deviceType: "desktop",
    }),
  });

  const messagePayload = await apiRequest<CreateMessageResponsePayload>(`/api/session/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      clientMessageId: `aliceloop-cli-${randomUUID()}`,
      content: caption,
      role: "user",
      attachmentIds: [attachmentPayload.attachment.id],
      deviceId: "aliceloop-cli",
      deviceType: "desktop",
    }),
  });

  return {
    sessionId,
    attachment: attachmentPayload.attachment,
    message: messagePayload.message,
  };
}

async function handleSend(args: string[]) {
  const action = args[0];
  if (action === "file") {
    return sendAttachment("file", args.slice(1));
  }

  if (action === "photo") {
    return sendAttachment("photo", args.slice(1));
  }

  throw new CliError(`Unknown send command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleScreenshot(args: string[]) {
  const { flags } = parseFlagArgs(args);
  const baseOutputPath = flags.output?.trim() || join(tmpdir(), `aliceloop-screenshot-${Date.now()}.jpg`);
  const previewOutputPath = baseOutputPath.replace(/\.jpg$/i, "-thumb.jpg");

  const capture = spawnSync("/usr/sbin/screencapture", ["-x", "-t", "jpg", baseOutputPath], {
    encoding: "utf8",
  });
  if (capture.status !== 0) {
    throw new CliError(capture.stderr.trim() || "Failed to capture screenshot");
  }

  const resize = spawnSync(
    "/usr/bin/sips",
    ["--resampleWidth", "1024", "--setProperty", "formatOptions", "60", baseOutputPath, "--out", previewOutputPath],
    { encoding: "utf8" },
  );

  return {
    screenshotPath: baseOutputPath,
    previewPath: resize.status === 0 ? previewOutputPath : null,
  };
}

async function handleReaction(args: string[]) {
  const action = args[0];

  if (action === "list") {
    const sessionId = args[1]?.trim();
    const messageId = args[2]?.trim();
    if (!sessionId || !messageId) {
      throw new CliError("reaction list requires a session id and message id");
    }

    return apiRequest<MessageReactionPayload[]>(
      `/api/session/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    );
  }

  if (action === "add") {
    const sessionId = args[1]?.trim();
    const messageId = args[2]?.trim();
    const emoji = args[3]?.trim();
    if (!sessionId || !messageId || !emoji) {
      throw new CliError("reaction add requires a session id, message id, and emoji");
    }

    const { flags } = parseFlagArgs(args.slice(4));
    return apiRequest<{
      created: boolean;
      reaction: MessageReactionPayload | null;
      reactions: MessageReactionPayload[];
    }>(
      `/api/session/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: "POST",
        body: JSON.stringify({
          emoji,
          deviceId: flags.device?.trim() || "aliceloop-cli",
        }),
      },
    );
  }

  if (action === "remove" || action === "delete") {
    const sessionId = args[1]?.trim();
    const messageId = args[2]?.trim();
    const emoji = args[3]?.trim();
    if (!sessionId || !messageId || !emoji) {
      throw new CliError("reaction remove requires a session id, message id, and emoji");
    }

    const { flags } = parseFlagArgs(args.slice(4));
    const search = new URLSearchParams({
      emoji,
      deviceId: flags.device?.trim() || "aliceloop-cli",
    });

    return apiRequest<{ removed: boolean; reactions: MessageReactionPayload[] }>(
      `/api/session/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/reactions?${search.toString()}`,
      {
        method: "DELETE",
      },
    );
  }

  throw new CliError(`Unknown reaction command: ${action ?? "(missing)"}\n\n${usage()}`);
}

function buildVoiceArgs(
  voice: string | undefined,
  rate: number | undefined,
  extraArgs: string[] = [],
) {
  const args: string[] = [];
  if (voice?.trim()) {
    args.push("-v", voice.trim());
  }
  if (rate !== undefined) {
    args.push("-r", String(rate));
  }
  args.push(...extraArgs);
  return args;
}

async function handleVoice(args: string[]) {
  if (process.platform !== "darwin") {
    throw new CliError("voice commands currently require macOS (`say`)");
  }

  const action = args[0];

  if (action === "list") {
    const listVoices = spawnSync("/usr/bin/say", ["-v", "?"], {
      encoding: "utf8",
    });
    if (listVoices.status !== 0) {
      throw new CliError(listVoices.stderr.trim() || "Failed to list system voices");
    }

    return listVoices.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(.*?)\s{2,}([A-Za-z_]+)\s+#\s*(.*)$/);
        if (!match) {
          return {
            voice: line,
            locale: null,
            sample: null,
          };
        }

        return {
          voice: match[1].trim(),
          locale: match[2].trim(),
          sample: match[3].trim(),
        };
      });
  }

  if (action === "speak") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const text = positionals.join(" ").trim();
    if (!text) {
      throw new CliError("voice speak requires text");
    }

    const rate = parseVoiceRate(flags.rate);
    const speak = spawnSync("/usr/bin/say", buildVoiceArgs(flags.voice, rate, [text]), {
      encoding: "utf8",
    });
    if (speak.status !== 0) {
      throw new CliError(speak.stderr.trim() || "Failed to speak text");
    }

    return {
      spoken: true,
      voice: flags.voice?.trim() || null,
      rate: rate ?? null,
      text,
    };
  }

  if (action === "save") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const outputPath = positionals[0]?.trim();
    const text = positionals.slice(1).join(" ").trim();
    if (!outputPath || !text) {
      throw new CliError("voice save requires an output path and text");
    }

    const rate = parseVoiceRate(flags.rate);
    const save = spawnSync("/usr/bin/say", buildVoiceArgs(flags.voice, rate, ["-o", outputPath, text]), {
      encoding: "utf8",
    });
    if (save.status !== 0) {
      throw new CliError(save.stderr.trim() || "Failed to save spoken audio");
    }

    return {
      saved: true,
      outputPath,
      voice: flags.voice?.trim() || null,
      rate: rate ?? null,
      text,
    };
  }

  throw new CliError(`Unknown voice command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleImage(args: string[]) {
  const action = args[0];

  if (action === "generate" || action === "gen" || action === "create") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const prompt = positionals.join(" ").trim();
    if (!prompt) {
      throw new CliError("image generate requires a prompt");
    }

    return apiRequest<GeneratedImagePayload>("/api/images/generate", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        providerId: flags.provider?.trim(),
        model: flags.model?.trim(),
        size: flags.size?.trim(),
        outputPath: flags.output?.trim(),
      }),
    });
  }

  throw new CliError(`Unknown image command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleAudio(args: string[]) {
  const action = args[0];

  if (action === "analyze") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const filePath = positionals[0]?.trim();
    const prompt = positionals.slice(1).join(" ").trim();
    if (!filePath) {
      throw new CliError("audio analyze requires a file path");
    }

    try {
      return await analyzeAudioFile({
        path: filePath,
        prompt: prompt || undefined,
        keepArtifacts: flags["keep-artifacts"] === "true",
      });
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
  }

  throw new CliError(`Unknown audio command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleVideo(args: string[]) {
  const action = args[0];

  if (action === "analyze") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const filePath = positionals[0]?.trim();
    const prompt = positionals.slice(1).join(" ").trim();
    if (!filePath) {
      throw new CliError("video analyze requires a file path");
    }

    try {
      return await analyzeVideoFile({
        path: filePath,
        prompt: prompt || undefined,
        keepArtifacts: flags["keep-artifacts"] === "true",
      });
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
  }

  throw new CliError(`Unknown video command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleTelegram(args: string[]) {
  const action = args[0];

  if (action === "me") {
    const { flags } = parseFlagArgs(args.slice(1));
    const token = requireTelegramBotToken(flags.token);
    return telegramRequest(token, "getMe", {
      method: "GET",
    });
  }

  if (action === "send") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const chatId = positionals[0]?.trim();
    const text = positionals.slice(1).join(" ").trim();
    if (!chatId || !text) {
      throw new CliError("telegram send requires a chat id and message text");
    }

    const token = requireTelegramBotToken(flags.token);
    return telegramRequest(token, "sendMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(flags.thread?.trim() ? { message_thread_id: flags.thread.trim() } : {}),
      }),
    });
  }

  if (action === "file" || action === "document") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const chatId = positionals[0]?.trim();
    const filePath = positionals[1]?.trim();
    const caption = positionals.slice(2).join(" ").trim();
    if (!chatId || !filePath) {
      throw new CliError("telegram file requires a chat id and file path");
    }

    const token = requireTelegramBotToken(flags.token);
    const binary = readFileSync(filePath);
    const form = new FormData();
    form.set("chat_id", chatId);
    if (caption) {
      form.set("caption", caption);
    }
    if (flags.thread?.trim()) {
      form.set("message_thread_id", flags.thread.trim());
    }
    form.set(
      "document",
      new Blob([binary], { type: detectMimeType(filePath) }),
      basename(filePath),
    );

    return telegramRequest(token, "sendDocument", {
      method: "POST",
      body: form,
    });
  }

  throw new CliError(`Unknown telegram command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleDiscord(args: string[]) {
  const action = args[0];

  if (action === "send") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const content = positionals.join(" ").trim();
    if (!content) {
      throw new CliError("discord send requires message content");
    }

    const webhookUrl = requireDiscordWebhookUrl(flags.webhook);
    return discordWebhookRequest(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        ...(flags.username?.trim() ? { username: flags.username.trim() } : {}),
      }),
    });
  }

  if (action === "file" || action === "upload") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const filePath = positionals[0]?.trim();
    const caption = positionals.slice(1).join(" ").trim();
    if (!filePath) {
      throw new CliError("discord file requires a file path");
    }

    const webhookUrl = requireDiscordWebhookUrl(flags.webhook);
    const binary = readFileSync(filePath);
    const form = new FormData();
    form.set(
      "payload_json",
      JSON.stringify({
        ...(caption ? { content: caption } : {}),
        ...(flags.username?.trim() ? { username: flags.username.trim() } : {}),
      }),
    );
    form.set(
      "files[0]",
      new Blob([binary], { type: detectMimeType(filePath) }),
      basename(filePath),
    );

    return discordWebhookRequest(webhookUrl, {
      method: "POST",
      body: form,
    });
  }

  throw new CliError(`Unknown discord command: ${action ?? "(missing)"}\n\n${usage()}`);
}

async function handleMusic(args: string[]) {
  const action = args[0];

  if (action === "generate" || action === "gen" || action === "create") {
    const { positionals, flags } = parseFlagArgs(args.slice(1));
    const prompt = positionals.join(" ").trim();
    if (!prompt) {
      throw new CliError("music generate requires a prompt");
    }

    return generateMusicSketch({
      prompt,
      outputPath: flags.output?.trim(),
      tempo: parsePositiveInteger(flags.tempo, "tempo"),
      bars: parsePositiveInteger(flags.bars, "bars"),
    });
  }

  throw new CliError(`Unknown music command: ${action ?? "(missing)"}\n\n${usage()}`);
}

export async function runCli(args: string[], io: CliIO = defaultIo) {
  try {
    if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
      io.stdout(usage());
      return 0;
    }

    let result: unknown;
    switch (args[0]) {
      case "status":
        result = await handleStatus();
        break;
      case "memory":
        result = await handleMemory(args.slice(1));
        break;
      case "config":
        result = await handleConfig(args.slice(1));
        break;
      case "providers":
        result = await handleProviders();
        break;
      case "threads":
        result = await handleThreads(args.slice(1));
        break;
      case "thread":
        result = await handleThread(args.slice(1));
        break;
      case "tasks":
        result = await handleTasks(args.slice(1));
        break;
      case "plan":
        result = await handlePlan(args.slice(1));
        break;
      case "skills":
        result = await handleSkills(args.slice(1));
        break;
      case "cron":
        result = await handleCron(args.slice(1));
        break;
      case "send":
        result = await handleSend(args.slice(1));
        break;
      case "screenshot":
        result = await handleScreenshot(args.slice(1));
        break;
      case "reaction":
        result = await handleReaction(args.slice(1));
        break;
      case "voice":
        result = await handleVoice(args.slice(1));
        break;
      case "audio":
        result = await handleAudio(args.slice(1));
        break;
      case "image":
        result = await handleImage(args.slice(1));
        break;
      case "video":
        result = await handleVideo(args.slice(1));
        break;
      case "telegram":
        result = await handleTelegram(args.slice(1));
        break;
      case "discord":
        result = await handleDiscord(args.slice(1));
        break;
      case "music":
        result = await handleMusic(args.slice(1));
        break;
      default:
        throw new CliError(`Unknown command: ${args[0]}\n\n${usage()}`);
    }

    io.stdout(renderValue(result));
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(error.message);
      return error.exitCode;
    }

    io.stderr(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  }
}

const cliEntryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && cliEntryPath === process.argv[1]) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
