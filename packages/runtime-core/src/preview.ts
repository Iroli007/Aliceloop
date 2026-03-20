import type { SessionSnapshot, SessionThreadSummary, ShellOverview } from "./domain";
import { primarySessionId } from "./domain";

export const previewShellOverview: ShellOverview = {
  library: [
    {
      id: "runtime-notes",
      title: "Aliceloop Runtime Notes",
      sourceKind: "handout",
      documentKind: "digital",
      sourcePath: "/Library/Projects/Aliceloop/runtime-notes.md",
      createdAt: "2026-03-17T07:00:00.000Z",
      updatedAt: "2026-03-17T07:22:00.000Z",
      lastAttentionLabel: "第 3 节 · Session Stream",
    },
    {
      id: "companion-sync-workshop",
      title: "Companion Sync Workshop",
      sourceKind: "handout",
      documentKind: "hybrid",
      sourcePath: "/Library/Projects/Aliceloop/companion-sync.pdf",
      createdAt: "2026-03-16T18:00:00.000Z",
      updatedAt: "2026-03-16T20:10:00.000Z",
      lastAttentionLabel: "移动端同步",
    },
  ],
  artifacts: [
    {
      id: "artifact-runtime-summary",
      libraryItemId: "runtime-notes",
      kind: "study-page",
      title: "Runtime 结构整理页",
      summary: "聚焦 session、sandbox、artifact 和 memory 的关系，适合快速回看和后续实现前定位。",
      body:
        "1. Session、queue 和 events 组成 runtime 的真相层，负责持续状态和多端同步。\n2. Sandbox 只提供 read、grep、glob、write、edit、bash 六个执行原子命令，skills 通过它做副作用操作。\n3. Artifact、memory 和 tasks 是提交层结果，不该和底层执行 ABI 混在一起。",
      relatedLibraryTitle: "Aliceloop Runtime Notes",
      updatedAt: "2026-03-17T07:23:00.000Z",
      updatedAtLabel: "刚刚更新",
    },
    {
      id: "artifact-review-pack",
      libraryItemId: "runtime-notes",
      kind: "review-pack",
      title: "Runtime 排障清单",
      summary: "汇总启动、桥接、上传和同步链路的检查项，方便联调时快速排查。",
      body:
        "联调时优先检查三件事：\n1. 确认 preload、IPC 和 renderer 桥已经注入成功。\n2. 确认 daemon 健康检查、心跳和会话快照都能正常返回。\n3. 确认文件上传、文件夹上传和附件索引写入走的是同一条链路。",
      relatedLibraryTitle: "Aliceloop Runtime Notes",
      updatedAt: "2026-03-17T07:24:00.000Z",
      updatedAtLabel: "刚刚更新",
    },
  ],
  attention: {
    id: "primary",
    currentLibraryItemId: "runtime-notes",
    currentLibraryTitle: "Aliceloop Runtime Notes",
    currentSectionKey: "section-03",
    currentSectionLabel: "第 3 节 · Session Stream",
    focusSummary: "最近连续回到 session stream、sandbox 边界和 artifact 提交这几个实现点。",
    concepts: ["session", "sandbox", "artifact", "memory"],
    updatedAt: "2026-03-17T07:24:00.000Z",
    events: [
      {
        id: "event-1",
        libraryItemId: "runtime-notes",
        sectionKey: "section-03",
        conceptKey: "session-stream",
        reason: "最近 24 小时反复回到同一段同步协议设计。",
        weight: 0.95,
        occurredAt: "2026-03-17T07:24:00.000Z",
      },
      {
        id: "event-2",
        libraryItemId: "runtime-notes",
        sectionKey: "section-04",
        conceptKey: "sandbox-boundary",
        reason: "用户连续追问沙箱和 runtime core 的边界。",
        weight: 0.91,
        occurredAt: "2026-03-17T07:22:00.000Z",
      },
    ],
  },
  memories: [
    {
      id: "memory-1",
      kind: "attention-summary",
      title: "近期关注重心",
      content: "用户最近主要围绕 runtime core、provider 接入和 companion 同步的边界来回切换。",
      source: "attention-index",
      updatedAt: "2026-03-17T07:25:00.000Z",
    },
    {
      id: "memory-2",
      kind: "learning-pattern",
      title: "稳定混淆点",
      content: "遇到 runtime 设计问题时，优先给分层图和最小执行边界，而不是先展开大而全的流程图。",
      source: "behavior-distillation",
      updatedAt: "2026-03-17T07:25:00.000Z",
    },
  ],
  taskRuns: [
    {
      id: "task-1",
      sessionId: null,
      taskType: "document-ingest",
      status: "done",
      title: "解析 Runtime 设计笔记目录与章节边界",
      detail: "目录、章节边界和首批导航块已经落到本地索引。",
      updatedAt: "2026-03-17T07:20:00.000Z",
      updatedAtLabel: "7 分钟前",
    },
    {
      id: "task-2",
      sessionId: null,
      taskType: "study-artifact",
      status: "running",
      title: "生成 Runtime 结构整理页",
      detail: "正在把 session、sandbox 和 artifact 的边界整理成可回看的结构化正文。",
      updatedAt: "2026-03-17T07:24:00.000Z",
      updatedAtLabel: "正在运行",
    },
  ],
};

export const previewSessionSnapshot: SessionSnapshot = {
  session: {
    id: primarySessionId,
    title: "共享伴随会话",
    createdAt: "2026-03-17T07:18:00.000Z",
    updatedAt: "2026-03-17T07:18:00.000Z",
  },
  messages: [],
  attachments: [],
  pendingToolApprovals: [],
  jobs: [],
  devices: [],
  runtimePresence: {
    online: false,
    hostDeviceId: null,
    hostLabel: null,
    lastHeartbeatAt: null,
  },
  artifacts: previewShellOverview.artifacts,
  overview: previewShellOverview,
  lastEventSeq: 0,
};

export const previewSessionThreads: SessionThreadSummary[] = [
  {
    id: previewSessionSnapshot.session.id,
    title: previewSessionSnapshot.session.title,
    createdAt: previewSessionSnapshot.session.createdAt,
    updatedAt: previewSessionSnapshot.session.updatedAt,
    messageCount: previewSessionSnapshot.messages.length,
    latestMessagePreview: previewSessionSnapshot.messages.at(-1)?.content ?? null,
    latestMessageAt: previewSessionSnapshot.messages.at(-1)?.createdAt ?? null,
  },
];
