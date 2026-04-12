export type DocumentKind = "digital" | "hybrid" | "scanned";
export type SourceKind = "book" | "web" | "handout";
export type ArtifactKind = "study-page" | "topic-page" | "review-pack";
export type TaskStatus = "queued" | "running" | "done" | "failed";
export type TaskType =
  | "document-ingest"
  | "attachment-ingest"
  | "study-artifact"
  | "review-coach"
  | "script-runner"
  | "tracked-task";
export type BlockKind = "outline" | "paragraph" | "figure-caption" | "table";
export type DeviceType = "desktop" | "mobile";
export type DeviceStatus = "online" | "offline";
export type SessionRole = "user" | "assistant" | "system";
export type SessionMessageStatus = "pending" | "acked" | "error";
export type AttachmentStatus = "ready" | "failed";
export type ProviderKind =
  | "minimax"
  | "gemini"
  | "moonshot"
  | "deepseek"
  | "zhipu"
  | "aihubmix"
  | "openai"
  | "anthropic"
  | "openrouter";
export type ProviderTransportKind = "auto" | "openai-compatible" | "anthropic";
export type SandboxPermissionProfile = "development" | "full-access";
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "xhigh";
export type LegacySandboxPermissionProfile = "restricted" | "high-privilege";
export type SandboxExecutionAccess = "standard" | "elevated";
export type SandboxPrimitive = "read" | "write" | "edit" | "delete" | "bash";
export type SandboxRunStatus = "running" | "done" | "failed" | "blocked";
export type ToolApprovalStatus = "pending" | "approved" | "rejected";
export type ToolApprovalDecisionOption = "allow_once" | "deny_once" | "allow_always" | "deny_always";
export type ToolPermissionRuleToolName = "read" | "write" | "edit" | "delete" | "bash" | "*";

export interface ToolPermissionRule {
  toolName: ToolPermissionRuleToolName;
  pathPrefix?: string;
  cwdPrefix?: string;
  commandPrefix?: string;
}

export interface ToolPermissionRules {
  allow: ToolPermissionRule[];
  deny: ToolPermissionRule[];
  ask: ToolPermissionRule[];
}
export type ToolCallStatus =
  | "input-streaming"
  | "input-available"
  | "queued"
  | "executing"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "permission-denied"
  | "done";
export type SkillStatus = "available" | "planned";
export type SkillMode = "instructional" | "task";
export type McpServerStatus = "available" | "planned";
export type McpInstallStatus = "not-installed" | "installed";
export type McpServerSource = "marketplace" | "manual";
export type RuntimeScriptStatus = "available" | "planned";
export type ProjectDirectoryKind = "workspace";
export type SessionEventType =
  | "message.created"
  | "message.acked"
  | "message.updated"
  | "task.notification"
  | "job.updated"
  | "artifact.created"
  | "artifact.block.created"
  | "artifact.block.append"
  | "artifact.done"
  | "artifact.updated"
  | "attachment.ready"
  | "presence.updated"
  | "runtime.offline"
  | "tool.approval.requested"
  | "tool.approval.resolved"
  | "tool.call.started"
  | "tool.call.completed"
  | "tool.state.change"
  | "plan_mode.updated";

export interface SessionPlanModeState {
  sessionId: string;
  active: boolean;
  activePlanId: string | null;
  enteredAt: string | null;
  updatedAt: string | null;
}

export interface LibraryItem {
  id: string;
  title: string;
  sourceKind: SourceKind;
  documentKind: DocumentKind;
  sourcePath: string | null;
  createdAt: string;
  updatedAt: string;
  lastAttentionLabel: string | null;
}

export interface StudyArtifact {
  id: string;
  libraryItemId: string;
  kind: ArtifactKind;
  title: string;
  summary: string;
  body: string;
  relatedLibraryTitle: string;
  updatedAt: string;
  updatedAtLabel: string;
}

export interface TaskRun {
  id: string;
  sessionId: string | null;
  taskType: TaskType;
  status: TaskStatus;
  title: string;
  detail: string;
  updatedAt: string;
  updatedAtLabel: string;
}

export interface AttentionEvent {
  id: string;
  libraryItemId: string;
  sectionKey: string | null;
  conceptKey: string | null;
  reason: string;
  weight: number;
  occurredAt: string;
}

export interface AttentionState {
  id: string;
  currentLibraryItemId: string | null;
  currentLibraryTitle: string | null;
  currentSectionKey: string | null;
  currentSectionLabel: string | null;
  focusSummary: string;
  concepts: string[];
  updatedAt: string;
  events: AttentionEvent[];
}

export interface DocumentStructure {
  id: string;
  libraryItemId: string;
  title: string;
  rootSectionKeys: string[];
}

export interface SectionSpan {
  key: string;
  title: string;
  pageFrom: number;
  pageTo: number;
  parentKey: string | null;
}

export interface ContentBlock {
  id: string;
  libraryItemId: string;
  sectionKey: string;
  sectionLabel: string;
  pageFrom: number;
  pageTo: number;
  blockKind: BlockKind;
  content: string;
}

export interface CrossReference {
  id: string;
  sourceKind: string;
  sourceRef: string;
  targetKind: string;
  targetRef: string;
  label: string;
  score: number;
}

export interface ShellOverview {
  library: LibraryItem[];
  artifacts: StudyArtifact[];
  attention: AttentionState;
  taskRuns: TaskRun[];
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  projectId?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  projectKind?: ProjectDirectoryKind | null;
}

export interface SessionThreadSummary {
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
  projectKind?: ProjectDirectoryKind | null;
  planMode?: SessionPlanModeState;
}

export interface ProjectDirectory {
  id: string;
  name: string;
  path: string;
  kind: ProjectDirectoryKind;
  isDefault: boolean;
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionProjectBinding {
  sessionId: string;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  projectKind: ProjectDirectoryKind | null;
  transcriptMarkdownPath: string | null;
}

export interface Attachment {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  storagePath: string;
  originalPath?: string;
  status: AttachmentStatus;
  createdAt: string;
}

export interface SessionMessage {
  id: string;
  clientMessageId: string;
  sessionId: string;
  role: SessionRole;
  content: string;
  attachments: Attachment[];
  status: SessionMessageStatus;
  createdAt: string;
}

export interface SessionEvent<TPayload = Record<string, unknown>> {
  id: string;
  sessionId: string;
  seq: number;
  type: SessionEventType;
  payload: TPayload;
  createdAt: string;
}

export interface TaskNotification {
  id: string;
  taskId: string;
  role: string | null;
  status: "completed" | "failed";
  title: string;
  objective: string;
  outputPath: string;
  preview: string | null;
  childSessionId: string;
  createdAt: string;
}

export interface BrowserRelayCapability {
  enabled: boolean;
  backend: "desktop_chrome";
  baseUrl: string;
  visible: true;
  healthy: boolean;
}

export interface DeviceCapabilities {
  browserRelay?: BrowserRelayCapability;
}

export interface DevicePresence {
  deviceId: string;
  deviceType: DeviceType;
  label: string;
  status: DeviceStatus;
  lastSeenAt: string;
  capabilities?: DeviceCapabilities;
}

export interface RuntimePresence {
  online: boolean;
  hostDeviceId: string | null;
  hostLabel: string | null;
  lastHeartbeatAt: string | null;
}

export interface ProviderConfig {
  id: ProviderKind;
  label: string;
  transport: ProviderTransportKind;
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
}

export interface RuntimeSettings {
  sandboxProfile: SandboxPermissionProfile;
  autoApproveToolRequests: boolean;
  toolPermissionRules: ToolPermissionRules;
  reasoningEffort: ReasoningEffort;
  toolProviderId: ProviderKind | null;
  toolModel: string | null;
  recentTurnsCount: number;
  updatedAt: string | null;
}

export interface SandboxProfileDefinition {
  id: SandboxPermissionProfile;
  label: string;
  summary: string;
  hostAccess: "guarded" | "broad";
  elevatedBehavior: string;
}

export interface ReasoningEffortDefinition {
  id: ReasoningEffort;
  label: string;
  summary: string;
}

export interface SandboxExecutionAccessDefinition {
  id: SandboxExecutionAccess;
  label: string;
  summary: string;
}

export function normalizeSandboxPermissionProfile(
  profile: string | null | undefined,
): SandboxPermissionProfile {
  if (profile === "high-privilege" || profile === "full-access") {
    return "full-access";
  }

  return "development";
}

export function normalizeReasoningEffort(
  effort: string | null | undefined,
): ReasoningEffort {
  switch (effort) {
    case "off":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return effort;
    default:
      return "medium";
  }
}

export function normalizeProviderKind(
  providerId: string | null | undefined,
): ProviderKind | null {
  switch (providerId) {
    case "minimax":
    case "gemini":
    case "moonshot":
    case "deepseek":
    case "zhipu":
    case "aihubmix":
    case "openai":
    case "anthropic":
    case "openrouter":
      return providerId;
    default:
      return null;
  }
}

export function normalizeAutoApproveToolRequests(
  value: string | number | boolean | null | undefined,
): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "off", "no"].includes(normalized)) {
      return false;
    }

    if (["true", "1", "on", "yes"].includes(normalized)) {
      return true;
    }
  }

  return true;
}

export const MIN_RECENT_TURNS_COUNT = 1;
export const MAX_RECENT_TURNS_COUNT = 20;

export function normalizeRecentTurnsCount(
  value: number | string | null | undefined,
): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseInt(value, 10)
      : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return 4;
  }

  return Math.max(MIN_RECENT_TURNS_COUNT, Math.min(MAX_RECENT_TURNS_COUNT, Math.round(parsed)));
}

export const sandboxProfileDefinitions: SandboxProfileDefinition[] = [
  {
    id: "development",
    label: "开发模式",
    summary: "默认使用受限的宿主机执行策略，适合日常开发与普通文件操作。",
    hostAccess: "guarded",
    elevatedBehavior: "允许少量越界动作通过单次 elevated 审批放行，执行后仍回到开发模式。",
  },
  {
    id: "full-access",
    label: "完全访问权限",
    summary: "当前会话直接按宿主机当前用户权限执行，不再附加开发模式的路径、命令或删除限制。",
    hostAccess: "broad",
    elevatedBehavior: "不再区分开发模式下的单次 elevated；整段会话默认按宿主用户完整权限执行。",
  },
];

export const sandboxExecutionAccessDefinitions: SandboxExecutionAccessDefinition[] = [
  {
    id: "standard",
    label: "标准执行",
    summary: "按当前 profile 的默认宿主机权限执行。",
  },
  {
    id: "elevated",
    label: "单次 Elevated",
    summary: "只作为开发模式里的偶发破例动作，不是常驻 profile。",
  },
];

export const reasoningEffortDefinitions: ReasoningEffortDefinition[] = [
  {
    id: "off",
    label: "关闭",
    summary: "禁用扩展思考，优先最短响应路径。",
  },
  {
    id: "low",
    label: "低",
    summary: "快速响应，适合简单问题与轻量执行。",
  },
  {
    id: "medium",
    label: "中",
    summary: "平衡速度与推理深度，适合大多数任务。",
  },
  {
    id: "high",
    label: "高",
    summary: "更深的分析与规划，适合复杂任务。",
  },
  {
    id: "xhigh",
    label: "超高",
    summary: "最强推理强度，适合最复杂的问题。",
  },
];

export const defaultRuntimeSettings: RuntimeSettings = {
  sandboxProfile: "full-access",
  autoApproveToolRequests: true,
  toolPermissionRules: {
    allow: [],
    deny: [],
    ask: [],
  },
  reasoningEffort: "medium",
  toolProviderId: null,
  toolModel: null,
  recentTurnsCount: 4,
  updatedAt: null,
};

export interface SkillDefinition {
  id: string;
  label: string;
  description: string;
  status: SkillStatus;
  mode: SkillMode;
  sourcePath: string;
  sourceUrl: string | null;
  allowedTools: string[];
}

export interface McpServerDefinition {
  id: string;
  label: string;
  description: string;
  author: string;
  transport: "builtin" | "stdio" | "http";
  status: McpServerStatus;
  capabilities: string[];
  tags: string[];
  verified: boolean;
  featured: boolean;
  homepageUrl: string | null;
  installStatus: McpInstallStatus;
  installSource: McpServerSource;
  installedAt: string | null;
}

export interface RuntimeScriptDefinition {
  id: string;
  label: string;
  description: string;
  runtime: "node-ts";
  status: RuntimeScriptStatus;
  usesSandbox: boolean;
  defaultArgs: string[];
}

export interface RuntimeQueueState {
  queuedSessionCount: number;
}

export interface RuntimeStats {
  sessionCount: number;
  messageCount: number;
  libraryItemCount: number;
  artifactCount: number;
  taskRunCount: number;
  memoryCount: number;
  sandboxRunCount: number;
}

export interface RuntimeCatalogSnapshot {
  runtimePresence: RuntimePresence;
  queue: RuntimeQueueState;
  stats: RuntimeStats;
  providers: ProviderConfig[];
  skills: SkillDefinition[];
  scripts: RuntimeScriptDefinition[];
  mcpServers: McpServerDefinition[];
  recentSandboxRuns: SandboxRun[];
}

export interface JobRunDetail {
  id: string;
  sessionId: string;
  kind: string;
  status: TaskStatus;
  title: string;
  detail: string;
  updatedAt: string;
}

export interface SandboxRun {
  id: string;
  primitive: SandboxPrimitive;
  status: SandboxRunStatus;
  targetPath: string | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  detail: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface ToolApproval {
  id: string;
  sessionId: string;
  toolCallId?: string | null;
  toolName: string;
  kind?: "command" | "question";
  title: string;
  detail: string;
  commandLine: string;
  command: string;
  args: string[];
  cwd: string;
  question?: {
    header: string;
    question: string;
    options: Array<{
      label: string;
      description?: string | null;
    }>;
    multiSelect?: boolean;
  } | null;
  decisionOption?: ToolApprovalDecisionOption | null;
  responseText?: string | null;
  status: ToolApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
}

function normalizeToolPermissionRuleToolName(value: unknown): ToolPermissionRuleToolName | null {
  switch (value) {
    case "read":
    case "write":
    case "edit":
    case "delete":
    case "bash":
    case "*":
      return value;
    default:
      return null;
  }
}

function normalizeToolPermissionRule(input: unknown): ToolPermissionRule | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const toolName = normalizeToolPermissionRuleToolName((input as { toolName?: unknown }).toolName);
  if (!toolName) {
    return null;
  }

  const pathPrefix = typeof (input as { pathPrefix?: unknown }).pathPrefix === "string"
    ? (input as { pathPrefix: string }).pathPrefix.trim() || undefined
    : undefined;
  const cwdPrefix = typeof (input as { cwdPrefix?: unknown }).cwdPrefix === "string"
    ? (input as { cwdPrefix: string }).cwdPrefix.trim() || undefined
    : undefined;
  const commandPrefix = typeof (input as { commandPrefix?: unknown }).commandPrefix === "string"
    ? (input as { commandPrefix: string }).commandPrefix.trim() || undefined
    : undefined;

  return {
    toolName,
    ...(pathPrefix ? { pathPrefix } : {}),
    ...(cwdPrefix ? { cwdPrefix } : {}),
    ...(commandPrefix ? { commandPrefix } : {}),
  };
}

function normalizeToolPermissionRuleList(input: unknown): ToolPermissionRule[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((rule) => normalizeToolPermissionRule(rule))
    .filter((rule): rule is ToolPermissionRule => Boolean(rule));
}

export function normalizeToolPermissionRules(input: unknown): ToolPermissionRules {
  if (!input || typeof input !== "object") {
    return {
      allow: [],
      deny: [],
      ask: [],
    };
  }

  const value = input as {
    allow?: unknown;
    deny?: unknown;
    ask?: unknown;
  };

  return {
    allow: normalizeToolPermissionRuleList(value.allow),
    deny: normalizeToolPermissionRuleList(value.deny),
    ask: normalizeToolPermissionRuleList(value.ask),
  };
}

export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  input: unknown;
  output?: unknown;
  error?: string;
  approvalOption?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionFocusState {
  sessionId: string;
  goal: string;
  constraints: string[];
  priorities: string[];
  nextStep: string;
  doneCriteria: string[];
  blockers: string[];
  updatedAt: string | null;
}

export interface SessionRollingSummary {
  sessionId: string;
  currentPhase: string;
  summary: string;
  completed: string[];
  remaining: string[];
  decisions: string[];
  summarizedTurnCount: number;
  updatedAt: string | null;
}

export interface SessionCompactionState {
  sessionId: string;
  checkpointSummary: string;
  compactedTurnCount: number;
  lastCompactedMessageId: string | null;
  consecutiveFailures: number;
  updatedAt: string | null;
}

export interface SessionSnapshot {
  session: Session;
  project: SessionProjectBinding | null;
  planMode: SessionPlanModeState;
  focusState: SessionFocusState;
  rollingSummary: SessionRollingSummary;
  compactionState: SessionCompactionState;
  messages: SessionMessage[];
  attachments: Attachment[];
  pendingToolApprovals: ToolApproval[];
  resolvedToolApprovals: ToolApproval[];
  jobs: JobRunDetail[];
  devices: DevicePresence[];
  runtimePresence: RuntimePresence;
  artifacts: StudyArtifact[];
  overview: ShellOverview;
  lastEventSeq: number;
}

export interface UserProfile {
  displayName: string | null;
  preferredLanguage: string | null;
  timezone: string | null;
  codeStyle: string | null;
  notes: string | null;
  updatedAt: string;
}

export const defaultUserProfile: UserProfile = {
  displayName: null,
  preferredLanguage: null,
  timezone: null,
  codeStyle: null,
  notes: null,
  updatedAt: new Date().toISOString(),
};

export type MemorySource = "auto" | "manual";
export type MemoryDurability = "permanent" | "temporary";
export type MemoryFactKind = "preference" | "constraint" | "decision" | "profile" | "account" | "workflow" | "other";
export type MemoryFactState = "active" | "superseded" | "retracted";
export type MemoryEmbeddingModel = "text-embedding-3-small" | "text-embedding-3-large";

export interface Memory {
  id: string;
  content: string;
  source: MemorySource;
  durability: MemoryDurability;
  projectId: string | null;
  sessionId: string | null;
  factKind: MemoryFactKind | null;
  factKey: string | null;
  factState: MemoryFactState;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  relatedTopics: string[];
}

export interface MemoryWithScore extends Memory {
  similarityScore: number;
}

export interface MemoryMetadata {
  memoryId: string;
  embeddingModel: MemoryEmbeddingModel;
  embeddingDimension: number;
  createdAt: string;
}

export interface MemoryConfig {
  enabled: boolean;
  queryRewrite: boolean;
  embeddingModel: MemoryEmbeddingModel;
  embeddingDimension: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  queryRewrite: false,
  embeddingModel: "text-embedding-3-small",
  embeddingDimension: 1536,
};

export interface MemoryStats {
  totalCount: number;
  autoCount: number;
  manualCount: number;
  permanentCount: number;
  temporaryCount: number;
  totalAccessCount: number;
  avgAccessCount: number;
  oldestMemory: string | null;
  newestMemory: string | null;
}

export interface CreateMemoryInput {
  content: string;
  source: MemorySource;
  durability: MemoryDurability;
  projectId?: string | null;
  sessionId?: string | null;
  factKind?: MemoryFactKind | null;
  factKey?: string | null;
  factState?: MemoryFactState;
  relatedTopics?: string[];
}

export interface UpdateMemoryInput {
  content?: string;
  durability?: MemoryDurability;
  factKind?: MemoryFactKind | null;
  factKey?: string | null;
  factState?: MemoryFactState;
  relatedTopics?: string[];
}

export const shellOverviewRoute = "/api/shell/overview";
export const primarySessionId = "session-primary";
