import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function listen(server: ReturnType<typeof createHttpServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-task-api-"));
  const workspaceRoot = join(tempDataDir, "workspaces", "default");
  process.env.ALICELOOP_DATA_DIR = tempDataDir;
  process.env.ALICELOOP_SCHEDULER_POLL_MS = "100";

  const [{ createServer }, { listTaskRuns }] = await Promise.all([
    import("../src/server.ts"),
    import("../src/repositories/taskRunRepository.ts"),
  ]);

  const server = await createServer();
  await server.listen({ host: "127.0.0.1", port: 0 });
  const imageBackend = createHttpServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/images/generations") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        created: Date.now(),
        data: [
          {
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=",
            revised_prompt: "API smoke revised prompt",
            mime_type: "image/png",
          },
        ],
      }));
      return;
    }

    response.statusCode = 404;
    response.end("not-found");
  });
  await listen(imageBackend);

  try {
    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve server address");
    }
    const imageBackendAddress = imageBackend.address();
    if (!imageBackendAddress || typeof imageBackendAddress === "string") {
      throw new Error("Failed to resolve image backend address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;
    mkdirSync(workspaceRoot, { recursive: true });
    const sourcePath = join(workspaceRoot, "runtime-notes.txt");
    const scriptPath = join(workspaceRoot, "echo-script.js");
    writeFileSync(
      sourcePath,
      [
        "# Aliceloop Runtime Notes",
        "",
        "第1章 Runtime Core",
        "Session、queue 和 events 负责持续状态，不能和副作用执行混在一起。",
        "",
        "第2章 Sandbox",
        "Sandbox 层只暴露 read、grep、glob、write、edit、bash 这六个最小执行 ABI，skills 通过它们做副作用操作。",
        "",
        "第3章 Session Sync",
        "把 snapshot、stream 和 heartbeat 的关系串起来，保持多端共享同一会话。",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(scriptPath, 'console.log("local-script-ok");\n', "utf8");

    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.status, 200, "health endpoint should respond");
    const healthPayload = (await healthResponse.json()) as {
      ok: boolean;
      service: string;
      activeSkills: string[];
      activeSkillAdapters: string[];
    };

    const recallSessionResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Recall API Smoke Session",
      }),
    });
    assert.equal(recallSessionResponse.status, 200, "session create endpoint should respond");
    const recallSessionPayload = (await recallSessionResponse.json()) as { id: string };

    const recallMessageResponse = await fetch(`${baseUrl}/api/session/${encodeURIComponent(recallSessionPayload.id)}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientMessageId: "task-api-recall-1",
        content: "Historical needle only appears in this older recall message.",
        role: "user",
        deviceId: "task-api-desktop",
        deviceType: "desktop",
      }),
    });
    assert.equal(recallMessageResponse.status, 200, "older recall message should be created");

    const recallPreviewResponse = await fetch(`${baseUrl}/api/session/${encodeURIComponent(recallSessionPayload.id)}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientMessageId: "task-api-recall-2",
        content: "Newest preview text is unrelated to the needle.",
        role: "user",
        deviceId: "task-api-desktop",
        deviceType: "desktop",
      }),
    });
    assert.equal(recallPreviewResponse.status, 200, "newer preview message should be created");

    const providerUpdateResponse = await fetch(`${baseUrl}/api/providers/openai`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${imageBackendAddress.port}/v1`,
        enabled: true,
      }),
    });
    assert.equal(providerUpdateResponse.status, 200, "provider update endpoint should accept local image backend config");

    const imageOutputPath = join(tempDataDir, "api-image-smoke.png");
    const imageGenerateResponse = await fetch(`${baseUrl}/api/images/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Generate a tiny API smoke image.",
        providerId: "openai",
        outputPath: imageOutputPath,
      }),
    });
    assert.equal(imageGenerateResponse.status, 200, "image generate endpoint should succeed");
    const imageGeneratePayload = (await imageGenerateResponse.json()) as {
      providerId: string;
      outputPath: string;
      mimeType: string;
      revisedPrompt: string | null;
      byteSize: number;
    };
    assert.equal(imageGeneratePayload.providerId, "openai", "image generate should preserve the requested provider");
    assert.equal(imageGeneratePayload.mimeType, "image/png", "image generate should preserve mime metadata");
    assert.equal(imageGeneratePayload.outputPath, imageOutputPath, "image generate should write to the requested output path");
    assert.equal(existsSync(imageOutputPath), true, "image generate should persist the output file");
    assert(imageGeneratePayload.byteSize > 0, "image generate should return the generated byte size");

    const ingestResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        taskType: "document-ingest",
        title: "Runtime Notes 摘录",
        sourcePath,
        sourceKind: "book",
        documentKind: "digital",
      }),
    });
    assert.equal(ingestResponse.status, 200, "document-ingest task should be created");
    const ingestPayload = (await ingestResponse.json()) as {
      libraryItem?: { id: string };
      sections?: Array<{ key: string }>;
      contentBlocks?: Array<{ content: string }>;
    };
    assert(ingestPayload.libraryItem?.id, "document-ingest should return a library item");

    const reviewResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        taskType: "review-coach",
      }),
    });
    assert.equal(reviewResponse.status, 200, "review-coach task should be created");

    const localScriptResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        taskType: "script-runner",
        title: "运行测试脚本",
        command: "node",
        args: [scriptPath],
        cwd: workspaceRoot,
      }),
    });
    assert.equal(localScriptResponse.status, 200, "script-runner task should be created");
    const localScriptPayload = (await localScriptResponse.json()) as { task?: { detail: string; taskType?: string } };

    const cronSessionResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Scheduler API Smoke Session",
      }),
    });
    assert.equal(cronSessionResponse.status, 200, "session creation for scheduler smoke should succeed");
    const cronSessionPayload = (await cronSessionResponse.json()) as { id: string };

    const reactionMessageResponse = await fetch(`${baseUrl}/api/session/${encodeURIComponent(cronSessionPayload.id)}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientMessageId: "api-reaction-smoke-1",
        content: "Use this message for reaction smoke coverage.",
        role: "user",
        attachmentIds: [],
        deviceId: "api-smoke-desktop",
        deviceType: "desktop",
      }),
    });
    assert.equal(reactionMessageResponse.status, 200, "seed reaction message should be created");
    const reactionMessagePayload = (await reactionMessageResponse.json()) as { message?: { id: string } };
    assert(reactionMessagePayload.message?.id, "reaction smoke should return the seeded message id");

    const reactionAddResponse = await fetch(
      `${baseUrl}/api/session/${encodeURIComponent(cronSessionPayload.id)}/messages/${encodeURIComponent(reactionMessagePayload.message!.id)}/reactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          emoji: "🔥",
          deviceId: "api-smoke-desktop",
        }),
      },
    );
    assert.equal(reactionAddResponse.status, 200, "reaction add endpoint should succeed");
    const reactionAddPayload = (await reactionAddResponse.json()) as {
      created: boolean;
      reaction: { emoji: string; deviceId: string } | null;
      reactions: Array<{ emoji: string }>;
    };
    assert.equal(reactionAddPayload.created, true, "reaction add should create a new reaction");
    assert.equal(reactionAddPayload.reaction?.emoji, "🔥", "reaction add should echo the added emoji");

    const reactionListResponse = await fetch(
      `${baseUrl}/api/session/${encodeURIComponent(cronSessionPayload.id)}/messages/${encodeURIComponent(reactionMessagePayload.message!.id)}/reactions`,
    );
    assert.equal(reactionListResponse.status, 200, "reaction list endpoint should respond");
    const reactionListPayload = (await reactionListResponse.json()) as Array<{ emoji: string; deviceId: string }>;
    assert(reactionListPayload.some((reaction) => reaction.emoji === "🔥"), "reaction list should include the stored emoji");

    const reactionDeleteResponse = await fetch(
      `${baseUrl}/api/session/${encodeURIComponent(cronSessionPayload.id)}/messages/${encodeURIComponent(reactionMessagePayload.message!.id)}/reactions?emoji=${encodeURIComponent("🔥")}&deviceId=${encodeURIComponent("api-smoke-desktop")}`,
      {
        method: "DELETE",
      },
    );
    assert.equal(reactionDeleteResponse.status, 200, "reaction delete endpoint should succeed");
    const reactionDeletePayload = (await reactionDeleteResponse.json()) as { removed: boolean; reactions: Array<{ emoji: string }> };
    assert.equal(reactionDeletePayload.removed, true, "reaction delete should report a removal");
    assert.equal(reactionDeletePayload.reactions.some((reaction) => reaction.emoji === "🔥"), false, "reaction delete should remove the emoji");

    const cronRunAt = new Date(Date.now() + 1200).toISOString();
    const cronCreateResponse = await fetch(`${baseUrl}/api/cron`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "API scheduler smoke",
        schedule: cronRunAt,
        prompt: "Write a short scheduled reminder for the API smoke test.",
        sessionId: cronSessionPayload.id,
      }),
    });
    assert.equal(cronCreateResponse.status, 200, "cron create endpoint should succeed");
    const cronCreatePayload = (await cronCreateResponse.json()) as { id: string; status: string; sessionId: string | null };
    assert.equal(cronCreatePayload.status, "active", "cron create should return an active schedule");
    assert.equal(cronCreatePayload.sessionId, cronSessionPayload.id, "cron create should keep the selected session");

    const cronListResponse = await fetch(`${baseUrl}/api/cron`);
    assert.equal(cronListResponse.status, 200, "cron list endpoint should respond");
    const cronListPayload = (await cronListResponse.json()) as Array<{ id: string; schedule: string }>;
    assert(cronListPayload.some((job) => job.id === cronCreatePayload.id), "cron list should include the created schedule");

    const planCreateResponse = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "API planning smoke",
        goal: "Keep planning separated from execution.",
        steps: ["Draft scope", "Approve plan", "Archive plan"],
        sessionId: cronSessionPayload.id,
      }),
    });
    assert.equal(planCreateResponse.status, 200, "plan create endpoint should succeed");
    const planCreatePayload = (await planCreateResponse.json()) as { id: string; status: string; steps: string[] };
    assert.equal(planCreatePayload.status, "draft", "plan create should start as draft");
    assert.equal(planCreatePayload.steps.length, 3, "plan create should preserve steps");

    const planListResponse = await fetch(`${baseUrl}/api/plans?status=draft&limit=10`);
    assert.equal(planListResponse.status, 200, "plan list endpoint should respond");
    const planListPayload = (await planListResponse.json()) as Array<{ id: string; status: string }>;
    assert(planListPayload.some((plan) => plan.id === planCreatePayload.id), "plan list should include the new draft plan");

    const planApproveResponse = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(planCreatePayload.id)}/approve`, {
      method: "POST",
    });
    assert.equal(planApproveResponse.status, 200, "plan approve endpoint should succeed");
    const planApprovePayload = (await planApproveResponse.json()) as { id: string; status: string; approvedAt: string | null };
    assert.equal(planApprovePayload.status, "approved", "plan approve should mark the plan approved");
    assert(planApprovePayload.approvedAt, "plan approve should stamp approvedAt");

    const trackedTaskResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        taskType: "tracked-task",
        title: "CLI migration follow-up",
        detail: "Track the remaining skill activation work.",
        steps: ["Implement CLI", "Verify smoke", "Flip task skill"],
      }),
    });
    assert.equal(trackedTaskResponse.status, 200, "tracked-task should be created");
    const trackedTaskPayload = (await trackedTaskResponse.json()) as { id: string; taskType: string; status: string; detail: string };
    assert.equal(trackedTaskPayload.taskType, "tracked-task", "tracked-task should return the manual task type");

    const trackedTaskPatchResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(trackedTaskPayload.id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        step: 2,
        stepStatus: "done",
        status: "running",
      }),
    });
    assert.equal(trackedTaskPatchResponse.status, 200, "tracked-task patch should succeed");
    const trackedTaskPatchedPayload = (await trackedTaskPatchResponse.json()) as { status: string; detail: string };
    assert.equal(trackedTaskPatchedPayload.status, "running", "tracked-task patch should update status");
    assert(trackedTaskPatchedPayload.detail.includes("- [x] Verify smoke"), "tracked-task patch should update the selected step");

    const trackedTaskDoneResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(trackedTaskPayload.id)}/done`, {
      method: "POST",
    });
    assert.equal(trackedTaskDoneResponse.status, 200, "tracked-task done endpoint should succeed");
    const trackedTaskDonePayload = (await trackedTaskDoneResponse.json()) as { status: string; detail: string };
    assert.equal(trackedTaskDonePayload.status, "done", "tracked-task done endpoint should mark the task done");
    assert(trackedTaskDonePayload.detail.includes("- [x] Flip task skill"), "tracked-task done should complete remaining steps");

    const allTasksResponse = await fetch(`${baseUrl}/api/tasks?limit=10`);
    assert.equal(allTasksResponse.status, 200, "task list endpoint should respond");
    const allTasks = (await allTasksResponse.json()) as Array<{ id: string; taskType: string; status: string }>;

    let schedulerTriggered = false;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const cronSnapshotResponse = await fetch(`${baseUrl}/api/session/${encodeURIComponent(cronSessionPayload.id)}/snapshot`);
      assert.equal(cronSnapshotResponse.status, 200, "scheduler target session snapshot should respond");
      const cronSnapshotPayload = (await cronSnapshotResponse.json()) as { messages: Array<{ content: string }> };
      if (cronSnapshotPayload.messages.some((message) => message.content.includes("[Scheduled task: API scheduler smoke]"))) {
        schedulerTriggered = true;
        break;
      }
    }
    assert.equal(schedulerTriggered, true, "scheduler should inject a scheduled prompt into the target session");

    const cronDeleteResponse = await fetch(`${baseUrl}/api/cron/${encodeURIComponent(cronCreatePayload.id)}`, {
      method: "DELETE",
    });
    assert.equal(cronDeleteResponse.status, 200, "cron delete endpoint should succeed");

    const planArchiveResponse = await fetch(`${baseUrl}/api/plans/${encodeURIComponent(planCreatePayload.id)}/archive`, {
      method: "POST",
    });
    assert.equal(planArchiveResponse.status, 200, "plan archive endpoint should succeed");
    const planArchivePayload = (await planArchiveResponse.json()) as { status: string };
    assert.equal(planArchivePayload.status, "archived", "plan archive should mark the plan archived");

    const filteredTasksResponse = await fetch(`${baseUrl}/api/tasks?taskType=review-coach&status=done&limit=10`);
    assert.equal(filteredTasksResponse.status, 200, "filtered task list endpoint should respond");
    const filteredTasks = (await filteredTasksResponse.json()) as Array<{ taskType: string; status: string }>;

    const structureResponse = await fetch(`${baseUrl}/api/library/${ingestPayload.libraryItem.id}/structure`);
    assert.equal(structureResponse.status, 200, "library structure endpoint should respond");
    const structurePayload = (await structureResponse.json()) as {
      structure: { id: string };
      sections: Array<{ key: string; title: string }>;
    };

    const blocksResponse = await fetch(`${baseUrl}/api/library/${ingestPayload.libraryItem.id}/blocks`);
    assert.equal(blocksResponse.status, 200, "library blocks endpoint should respond");
    const blocksPayload = (await blocksResponse.json()) as Array<{ content: string }>;
    const artifactsResponse = await fetch(`${baseUrl}/api/artifacts?limit=10`);
    assert.equal(artifactsResponse.status, 200, "artifacts endpoint should respond");
    const artifactsPayload = (await artifactsResponse.json()) as Array<{ id: string; title: string }>;
    const artifactDetailResponse = await fetch(`${baseUrl}/api/artifacts/${encodeURIComponent(artifactsPayload[0]?.id ?? "")}`);
    assert.equal(artifactDetailResponse.status, 200, "artifact detail endpoint should respond");
    const artifactDetailPayload = (await artifactDetailResponse.json()) as { id: string; title: string };

    const searchResponse = await fetch(
      `${baseUrl}/api/library/search?q=${encodeURIComponent("sandbox")}&libraryItemId=${ingestPayload.libraryItem.id}&limit=10`,
    );
    assert.equal(searchResponse.status, 200, "library search endpoint should respond");
    const searchPayload = (await searchResponse.json()) as Array<{ content: string }>;

    const attentionResponse = await fetch(`${baseUrl}/api/attention`);
    assert.equal(attentionResponse.status, 200, "attention endpoint should respond");
    const attentionPayload = (await attentionResponse.json()) as { currentLibraryItemId: string | null; concepts: string[] };

    const archiveResponse = await fetch(`${baseUrl}/api/memory/archive`, { method: "POST" });
    assert.equal(archiveResponse.status, 200, "memory archive endpoint should respond");
    const archivePayload = (await archiveResponse.json()) as { projectCount: number; sessionCount: number };
    const projectBindingResponse = await fetch(`${baseUrl}/api/session/${encodeURIComponent(recallSessionPayload.id)}/project`);
    assert.equal(projectBindingResponse.status, 200, "session project endpoint should respond");
    const projectBindingPayload = (await projectBindingResponse.json()) as { transcriptMarkdownPath: string | null };
    assert(projectBindingPayload.transcriptMarkdownPath, "project-backed session should expose transcript path");
    appendFileSync(projectBindingPayload.transcriptMarkdownPath, "\nInjected archive-only API token: API-ARCHIVE-ONLY-SENTINEL\n", "utf8");
    const threadSearchResponse = await fetch(`${baseUrl}/api/threads/search?q=${encodeURIComponent("recall message")}&limit=10`);
    assert.equal(threadSearchResponse.status, 200, "thread search endpoint should respond");
    const threadSearchPayload = (await threadSearchResponse.json()) as Array<{
      id: string;
      latestMessagePreview: string | null;
      matchedPreview: string | null;
      matchedMessageCreatedAt: string | null;
    }>;
    const archiveOnlyThreadSearchResponse = await fetch(`${baseUrl}/api/threads/search?q=${encodeURIComponent("API-ARCHIVE-ONLY-SENTINEL")}&limit=10`);
    assert.equal(archiveOnlyThreadSearchResponse.status, 200, "archive-backed thread search should respond");
    const archiveOnlyThreadSearchPayload = (await archiveOnlyThreadSearchResponse.json()) as Array<{
      id: string;
      matchedPreview: string | null;
    }>;

    const skillsResponse = await fetch(`${baseUrl}/api/skills`);
    assert.equal(skillsResponse.status, 200, "skills endpoint should respond");
    const skillsPayload = (await skillsResponse.json()) as Array<{
      id: string;
      mode: string;
      sourcePath: string;
      allowedTools: string[];
    }>;
    const skillDetailResponse = await fetch(`${baseUrl}/api/skills/browser`);
    assert.equal(skillDetailResponse.status, 200, "skill detail endpoint should respond");
    const skillDetailPayload = (await skillDetailResponse.json()) as {
      id: string;
      mode: string;
      sourcePath: string;
      allowedTools: string[];
    };
    const webSearchSkillDetailResponse = await fetch(`${baseUrl}/api/skills/web-search`);
    assert.equal(webSearchSkillDetailResponse.status, 200, "web-search skill detail endpoint should respond");
    const webSearchSkillDetailPayload = (await webSearchSkillDetailResponse.json()) as {
      id: string;
      status: string;
      sourcePath: string;
      allowedTools: string[];
    };
    const webFetchSkillDetailResponse = await fetch(`${baseUrl}/api/skills/web-fetch`);
    assert.equal(webFetchSkillDetailResponse.status, 200, "web-fetch skill detail endpoint should respond");
    const webFetchSkillDetailPayload = (await webFetchSkillDetailResponse.json()) as {
      id: string;
      status: string;
      sourcePath: string;
      allowedTools: string[];
    };
    const skillRunResponse = await fetch(`${baseUrl}/api/skills/browser/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(skillRunResponse.status, 409, "instructional skills should not expose run semantics");
    const skillRunPayload = (await skillRunResponse.json()) as { error?: string; detail?: string };

    const mcpServersResponse = await fetch(`${baseUrl}/api/mcp/servers`);
    assert.equal(mcpServersResponse.status, 200, "mcp server endpoint should respond");
    const mcpServersPayload = (await mcpServersResponse.json()) as Array<{ id: string; status: string }>;
    const mcpServerDetailResponse = await fetch(`${baseUrl}/api/mcp/servers/filesystem-bridge`);
    assert.equal(mcpServerDetailResponse.status, 200, "mcp server detail endpoint should respond");
    const mcpServerDetailPayload = (await mcpServerDetailResponse.json()) as { id: string; capabilities: string[] };
    const mcpInstallResponse = await fetch(`${baseUrl}/api/mcp/servers/fetch/install`, { method: "POST" });
    assert.equal(mcpInstallResponse.status, 200, "mcp install endpoint should respond");
    const mcpInstallPayload = (await mcpInstallResponse.json()) as { id: string; installStatus: string };
    const mcpUninstallResponse = await fetch(`${baseUrl}/api/mcp/servers/fetch/install`, { method: "DELETE" });
    assert.equal(mcpUninstallResponse.status, 200, "mcp uninstall endpoint should respond");
    const mcpUninstallPayload = (await mcpUninstallResponse.json()) as { id: string; installStatus: string };
    const runtimeScriptsResponse = await fetch(`${baseUrl}/api/runtime/scripts`);
    assert.equal(runtimeScriptsResponse.status, 200, "runtime scripts endpoint should respond");
    const runtimeScriptsPayload = (await runtimeScriptsResponse.json()) as Array<{ id: string; runtime: string }>;
    const runtimeScriptDetailResponse = await fetch(`${baseUrl}/api/runtime/scripts/runtime-overview`);
    assert.equal(runtimeScriptDetailResponse.status, 200, "runtime script detail endpoint should respond");
    const runtimeScriptDetailPayload = (await runtimeScriptDetailResponse.json()) as { id: string; runtime: string };
    const runtimeScriptRunResponse = await fetch(`${baseUrl}/api/runtime/scripts/runtime-overview/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "通过 runtime script 入口运行 overview",
        args: ["--smoke"],
      }),
    });
    assert.equal(runtimeScriptRunResponse.status, 200, "runtime script run endpoint should execute named script");
    const runtimeScriptRunPayload = (await runtimeScriptRunResponse.json()) as { task?: { taskType?: string; detail?: string } };

    const providersResponse = await fetch(`${baseUrl}/api/providers`);
    assert.equal(providersResponse.status, 200, "providers endpoint should respond");
    const providersPayload = (await providersResponse.json()) as Array<{ id: string }>;
    const runtimeCatalogResponse = await fetch(`${baseUrl}/api/runtime/catalog?limit=5`);
    assert.equal(runtimeCatalogResponse.status, 200, "runtime catalog endpoint should respond");
    const runtimeCatalogPayload = (await runtimeCatalogResponse.json()) as {
      runtimePresence: { online: boolean; hostDeviceId: string | null };
      queue: { queuedSessionCount: number };
      stats: {
        sessionCount: number;
        messageCount: number;
        libraryItemCount: number;
        artifactCount: number;
        taskRunCount: number;
        memoryCount: number;
        sandboxRunCount: number;
      };
      providers: Array<{ id: string }>;
      skills: Array<{ id: string }>;
      scripts: Array<{ id: string }>;
      mcpServers: Array<{ id: string }>;
      recentSandboxRuns: Array<{ id: string }>;
    };

    const sandboxRunsResponse = await fetch(`${baseUrl}/api/runtime/sandbox-runs?limit=20`);
    assert.equal(sandboxRunsResponse.status, 200, "sandbox runs endpoint should respond");
    const sandboxRuns = (await sandboxRunsResponse.json()) as Array<{ id: string; primitive: string; status: string; targetPath: string | null }>;
    const sandboxRunDetailResponse = await fetch(`${baseUrl}/api/runtime/sandbox-runs/${encodeURIComponent(sandboxRuns[0]?.id ?? "")}`);
    assert.equal(sandboxRunDetailResponse.status, 200, "sandbox run detail endpoint should respond");
    const sandboxRunDetailPayload = (await sandboxRunDetailResponse.json()) as { id: string; primitive: string };

    assert(allTasks.some((task) => task.taskType === "document-ingest"), "task list should include document-ingest");
    assert(allTasks.some((task) => task.taskType === "review-coach"), "task list should include review-coach");
    assert(allTasks.some((task) => task.taskType === "script-runner"), "task list should include script-runner");
    assert(filteredTasks.length > 0, "filtered task list should not be empty");
    assert(filteredTasks.every((task) => task.taskType === "review-coach"), "taskType filter should be honored");
    assert(filteredTasks.every((task) => task.status === "done"), "status filter should be honored");
    assert(filteredTasks.length >= 1, "filtered task list should include at least one review-coach result");
    assert(
      listTaskRuns({ taskType: "review-coach", status: "done" }).length >= filteredTasks.length,
      "repository view should stay aligned with filtered task results",
    );
    assert(structurePayload.sections.length >= 3, "ingest should produce multiple sections");
    assert(blocksPayload.some((block) => block.content.toLowerCase().includes("sandbox")), "blocks should contain source text");
    assert(artifactsPayload.length > 0, "artifacts endpoint should expose seeded artifacts");
    assert.equal(artifactDetailPayload.id, artifactsPayload[0]?.id, "artifact detail endpoint should resolve requested artifact");
    assert(searchPayload.length > 0, "FTS search should return matching blocks");
    assert.equal(attentionPayload.currentLibraryItemId, ingestPayload.libraryItem.id, "attention should focus the latest ingested library");
    assert(attentionPayload.concepts.length > 0, "attention should expose inferred concepts");
    assert(archivePayload.projectCount >= 1, "memory archive should report project transcript exports");
    assert(archivePayload.sessionCount >= 1, "memory archive should report synced sessions");
    assert(threadSearchPayload.some((thread) => thread.id === recallSessionPayload.id), "thread search should match message body content");
    assert(
      threadSearchPayload.some((thread) => thread.id === recallSessionPayload.id && thread.matchedPreview?.includes("older recall message")),
      "thread search should return matched preview text from the hit message",
    );
    assert(
      threadSearchPayload.some((thread) => thread.id === recallSessionPayload.id && thread.latestMessagePreview?.includes("unrelated")),
      "thread search should preserve the latest preview separately from matched preview",
    );
    assert(
      threadSearchPayload.some((thread) => thread.id === recallSessionPayload.id && thread.matchedMessageCreatedAt),
      "thread search should expose matched message timestamps",
    );
    assert(
      archiveOnlyThreadSearchPayload.some((thread) => thread.id === recallSessionPayload.id && thread.matchedPreview?.includes("API-ARCHIVE-ONLY-SENTINEL")),
      "thread search should prioritize transcript archive content when it exists only in exported markdown",
    );
    assert.equal(healthPayload.ok, true, "health payload should mark daemon as healthy");
    assert.equal(healthPayload.service, "aliceloop-daemon", "health payload should include service id");
    assert(healthPayload.activeSkills.includes("skill-hub"), "health payload should expose active skill-hub skill");
    assert(healthPayload.activeSkills.includes("skill-search"), "health payload should expose active skill-search skill");
    assert(healthPayload.activeSkills.includes("send-file"), "health payload should expose active send-file skill");
    assert(healthPayload.activeSkills.includes("image-gen"), "health payload should expose active image-gen skill");
    assert(healthPayload.activeSkills.includes("reactions"), "health payload should expose active reactions skill");
    assert(healthPayload.activeSkills.includes("system-info"), "health payload should expose active system-info skill");
    assert(healthPayload.activeSkills.includes("web-fetch"), "health payload should expose active web-fetch skill");
    assert(healthPayload.activeSkills.includes("web-search"), "health payload should expose active web-search skill");
    assert(healthPayload.activeSkills.includes("tasks"), "health payload should expose the activated tasks skill");
    assert(healthPayload.activeSkillAdapters.includes("web_fetch"), "health payload should expose active web-fetch adapter");
    assert(healthPayload.activeSkillAdapters.includes("web_search"), "health payload should expose active web-search adapter");
    assert(skillsPayload.some((skill) => skill.id === "browser"), "skill catalog should include browser");
    assert(skillsPayload.some((skill) => skill.id === "skill-hub"), "skill catalog should include skill-hub");
    assert(skillsPayload.some((skill) => skill.id === "skill-search"), "skill catalog should include skill-search");
    assert(skillsPayload.some((skill) => skill.id === "send-file"), "skill catalog should include send-file");
    assert(skillsPayload.some((skill) => skill.id === "image-gen"), "skill catalog should include image-gen");
    assert(skillsPayload.some((skill) => skill.id === "reactions"), "skill catalog should include reactions");
    assert(skillsPayload.some((skill) => skill.id === "system-info"), "skill catalog should include system-info");
    assert(skillsPayload.some((skill) => skill.id === "web-fetch"), "skill catalog should include web-fetch");
    assert(skillsPayload.some((skill) => skill.id === "web-search"), "skill catalog should include web-search");
    assert(skillsPayload.some((skill) => skill.id === "browser"), "skill catalog should include browser");
    assert(skillsPayload.some((skill) => skill.id === "tasks"), "skill catalog should include tasks");
    assert.equal(healthPayload.activeSkills.includes("scheduler"), false, "health payload should not expose removed scheduler skill");
    assert.equal(skillsPayload.some((skill) => skill.id === "scheduler"), false, "skill catalog should not include removed scheduler skill");
    assert.equal(skillsPayload.some((skill) => skill.id === "notebook"), false, "skill catalog should not include removed notebook skill");
    assert.equal(skillDetailPayload.id, "browser", "skill detail endpoint should resolve the requested skill");
    assert.equal(skillDetailPayload.mode, "instructional", "browser should be an instructional skill");
    assert(skillDetailPayload.sourcePath.includes("skills/browser/SKILL.md"));
    assert(skillDetailPayload.allowedTools.includes("bash"), "browser instructional skill should declare bash");
    assert(skillDetailPayload.allowedTools.includes("read"), "browser instructional skill should declare read");
    assert.equal(skillDetailPayload.allowedTools.includes("browser_navigate"), false, "browser instructional skill should not claim native browser adapters");
    assert.equal(webSearchSkillDetailPayload.id, "web-search", "web-search detail endpoint should resolve the requested skill");
    assert.equal(webSearchSkillDetailPayload.status, "available", "web-search should now be marked available");
    assert(webSearchSkillDetailPayload.sourcePath.includes("skills/web-search/SKILL.md"));
    assert(webSearchSkillDetailPayload.allowedTools.includes("web_search"));
    assert.equal(webSearchSkillDetailPayload.allowedTools.includes("web_fetch"), true, "web-search should explicitly allow follow-up page fetches");
    assert.equal(webFetchSkillDetailPayload.id, "web-fetch", "web-fetch detail endpoint should resolve the requested skill");
    assert.equal(webFetchSkillDetailPayload.status, "available", "web-fetch should now be marked available");
    assert(webFetchSkillDetailPayload.sourcePath.includes("skills/web-fetch/SKILL.md"));
    assert(webFetchSkillDetailPayload.allowedTools.includes("web_fetch"));
    assert.equal(skillRunPayload.error, "skill_not_runnable", "instructional skill run should reject execution");
    assert(mcpServersPayload.length > 0, "mcp server catalog should expose planned entries");
    assert.equal(mcpServerDetailPayload.id, "filesystem-bridge", "mcp server detail endpoint should resolve requested server");
    assert(mcpServerDetailPayload.capabilities.includes("read"), "mcp server detail should include capabilities");
    assert.equal(mcpInstallPayload.id, "fetch", "mcp install should return requested server");
    assert.equal(mcpInstallPayload.installStatus, "installed", "mcp install should mark server as installed");
    assert.equal(mcpUninstallPayload.id, "fetch", "mcp uninstall should return requested server");
    assert.equal(mcpUninstallPayload.installStatus, "not-installed", "mcp uninstall should clear installed state");
    assert(runtimeScriptsPayload.some((script) => script.id === "runtime-overview"), "runtime scripts should expose named scripts");
    assert.equal(runtimeScriptDetailPayload.runtime, "node-ts", "runtime script detail should expose runtime kind");
    assert.equal(runtimeScriptRunPayload.task?.taskType, "script-runner", "runtime script run should dispatch through script-runner");
    assert(runtimeScriptRunPayload.task?.detail?.trim().length, "runtime script run should return task detail");
    assert(providersPayload.some((provider) => provider.id === "aihubmix"), "provider list should include aihubmix");
    assert(providersPayload.some((provider) => provider.id === "minimax"), "provider list should include minimax");
    assert(runtimeCatalogPayload.providers.some((provider) => provider.id === "aihubmix"), "runtime catalog should include providers");
    assert(runtimeCatalogPayload.providers.some((provider) => provider.id === "minimax"), "runtime catalog should include minimax");
    assert(runtimeCatalogPayload.skills.some((skill) => skill.id === "browser"), "runtime catalog should include browser");
    assert(runtimeCatalogPayload.skills.some((skill) => skill.id === "web-fetch"), "runtime catalog should include web-fetch");
    assert(runtimeCatalogPayload.scripts.some((script) => script.id === "runtime-overview"), "runtime catalog should include runtime scripts");
    assert(runtimeCatalogPayload.mcpServers.some((server) => server.id === "filesystem-bridge"), "runtime catalog should include mcp servers");
    assert(runtimeCatalogPayload.recentSandboxRuns.length > 0, "runtime catalog should include recent sandbox runs");
    assert(runtimeCatalogPayload.stats.sessionCount >= 1, "runtime catalog should include session stats");
    assert(runtimeCatalogPayload.stats.taskRunCount >= allTasks.length, "runtime catalog should include task stats");
    assert(runtimeCatalogPayload.stats.sandboxRunCount >= sandboxRuns.length, "runtime catalog should include sandbox stats");
    assert(runtimeCatalogPayload.queue.queuedSessionCount >= 0, "runtime catalog should include queue stats");
    assert(localScriptPayload.task?.detail?.includes("local-script-ok"), "script-runner should capture stdout");
    assert(allTasks.some((task) => task.taskType === "tracked-task"), "task list should include tracked-task entries");
    const trackedTaskDeleteResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(trackedTaskPayload.id)}`, {
      method: "DELETE",
    });
    assert.equal(trackedTaskDeleteResponse.status, 200, "tracked-task delete should succeed");
    assert(
      sandboxRuns.some((run) => run.primitive === "read" && run.status === "done" && run.targetPath === sourcePath),
      "document-ingest should read the source file through the sandbox",
    );
    assert(
      sandboxRuns.some((run) => run.primitive === "bash" && run.status === "done"),
      "script-runner should execute through sandbox bash",
    );
    assert.equal(sandboxRunDetailPayload.id, sandboxRuns[0]?.id, "sandbox run detail endpoint should resolve requested run");

    console.log(
      JSON.stringify(
        {
          ok: true,
          tempDataDir,
          totalTasks: allTasks.length,
          filteredTasks: filteredTasks.length,
          sectionCount: structurePayload.sections.length,
          blockCount: blocksPayload.length,
          skillCount: skillsPayload.length,
          providerCount: providersPayload.length,
          runtimeCatalogProviders: runtimeCatalogPayload.providers.length,
          sandboxRuns: sandboxRuns.length,
        },
        null,
        2,
      ),
    );
  } finally {
    delete process.env.ALICELOOP_SCHEDULER_POLL_MS;
    await new Promise((resolve, reject) => imageBackend.close((error) => (error ? reject(error) : resolve(undefined))));
    await server.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
