export type DocumentKind = "digital" | "hybrid" | "scanned";
export type SourceKind = "book" | "web" | "handout";
export type ArtifactKind = "study-page" | "topic-page" | "review-pack";
export type TaskStatus = "queued" | "running" | "done" | "failed";
export type TaskType =
  | "document-ingest"
  | "attachment-ingest"
  | "study-artifact"
  | "review-coach"
  | "script-runner";
export type MemoryKind = "attention-summary" | "learning-pattern" | "postmortem";
export type BlockKind = "outline" | "paragraph" | "figure-caption" | "table";
export type DeviceType = "desktop" | "mobile";
export type DeviceStatus = "online" | "offline";
export type SessionRole = "user" | "assistant" | "system";
export type SessionMessageStatus = "pending" | "acked" | "error";
export type AttachmentStatus = "ready" | "failed";
export type ProviderKind = "minimax" | "aihubmix" | "openai" | "anthropic" | "openrouter";
export type ProviderTransportKind = "auto" | "openai-compatible" | "anthropic";
export type SandboxPermissionProfile = "development" | "full-access";
export type LegacySandboxPermissionProfile = "restricted" | "high-privilege";
export type SandboxExecutionAccess = "standard" | "elevated";
export type SandboxPrimitive = "read" | "write" | "edit" | "delete" | "bash";
export type SandboxRunStatus = "running" | "done" | "failed" | "blocked";
export type ToolApprovalStatus = "pending" | "approved" | "rejected";
export type SkillStatus = "available" | "planned";
export type SkillMode = "instructional" | "task";
export type McpServerStatus = "available" | "planned";
export type McpInstallStatus = "not-installed" | "installed";
export type McpServerSource = "marketplace" | "manual";
export type RuntimeScriptStatus = "available" | "planned";
export type SessionEventType =
  | "message.created"
  | "message.acked"
  | "message.updated"
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
  | "tool.call.completed";

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

export interface MemoryNote {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  source: string;
  updatedAt: string;
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
  memories: MemoryNote[];
  taskRuns: TaskRun[];
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  latestMessagePreview: string | null;
  latestMessageAt: string | null;
}

export interface Attachment {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  storagePath: string;
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

export interface DevicePresence {
  deviceId: string;
  deviceType: DeviceType;
  label: string;
  status: DeviceStatus;
  lastSeenAt: string;
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
  updatedAt: string | null;
}

export interface SandboxProfileDefinition {
  id: SandboxPermissionProfile;
  label: string;
  summary: string;
  hostAccess: "guarded" | "broad";
  elevatedBehavior: string;
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

export const defaultRuntimeSettings: RuntimeSettings = {
  sandboxProfile: "development",
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
  toolName: string;
  title: string;
  detail: string;
  commandLine: string;
  command: string;
  args: string[];
  cwd: string;
  status: ToolApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface SessionSnapshot {
  session: Session;
  messages: SessionMessage[];
  attachments: Attachment[];
  pendingToolApprovals: ToolApproval[];
  jobs: JobRunDetail[];
  devices: DevicePresence[];
  runtimePresence: RuntimePresence;
  artifacts: StudyArtifact[];
  overview: ShellOverview;
  lastEventSeq: number;
}

export const shellOverviewRoute = "/api/shell/overview";
export const primarySessionId = "session-primary";
