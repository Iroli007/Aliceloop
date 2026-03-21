import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-task-api-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const [{ createServer }, { listTaskRuns }] = await Promise.all([
    import("../src/server.ts"),
    import("../src/repositories/taskRunRepository.ts"),
  ]);

  const server = await createServer();
  await server.listen({ host: "127.0.0.1", port: 0 });

  try {
    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve server address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sourcePath = join(tempDataDir, "runtime-notes.txt");
    const scriptPath = join(tempDataDir, "echo-script.js");
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
        "第3章 Companion Sync",
        "把 snapshot、stream 和 heartbeat 的关系串起来，保持多端共享同一会话。",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(scriptPath, 'console.log("local-script-ok");\n', "utf8");

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
        cwd: tempDataDir,
      }),
    });
    assert.equal(localScriptResponse.status, 200, "script-runner task should be created");
    const localScriptPayload = (await localScriptResponse.json()) as { task?: { detail: string; taskType?: string } };

    const allTasksResponse = await fetch(`${baseUrl}/api/tasks?limit=10`);
    assert.equal(allTasksResponse.status, 200, "task list endpoint should respond");
    const allTasks = (await allTasksResponse.json()) as Array<{ id: string; taskType: string; status: string }>;

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

    const memoriesResponse = await fetch(`${baseUrl}/api/memories?limit=10`);
    assert.equal(memoriesResponse.status, 200, "memories endpoint should respond");
    const memoriesPayload = (await memoriesResponse.json()) as Array<{ id: string; title: string; source: string }>;
    const memoryDetailResponse = await fetch(`${baseUrl}/api/memories/${encodeURIComponent(memoriesPayload[0]?.id ?? "")}`);
    assert.equal(memoryDetailResponse.status, 200, "memory detail endpoint should respond");
    const memoryDetailPayload = (await memoryDetailResponse.json()) as { id: string; source: string };

    const skillsResponse = await fetch(`${baseUrl}/api/skills`);
    assert.equal(skillsResponse.status, 200, "skills endpoint should respond");
    const skillsPayload = (await skillsResponse.json()) as Array<{
      id: string;
      mode: string;
      sourcePath: string;
      allowedTools: string[];
    }>;
    const skillDetailResponse = await fetch(`${baseUrl}/api/skills/coding-agent`);
    assert.equal(skillDetailResponse.status, 200, "skill detail endpoint should respond");
    const skillDetailPayload = (await skillDetailResponse.json()) as {
      id: string;
      mode: string;
      sourcePath: string;
      allowedTools: string[];
    };
    const skillRunResponse = await fetch(`${baseUrl}/api/skills/coding-agent/run`, {
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
    assert(memoriesPayload.some((memory) => memory.source === "attention-index"), "ingest should distill an attention memory note");
    assert(memoriesPayload.some((memory) => memory.source === "review-coach"), "review-coach should create a memory note");
    assert.equal(memoryDetailPayload.source, "review-coach", "memory detail endpoint should resolve saved memory");
    assert(skillsPayload.some((skill) => skill.id === "coding-agent"), "skill catalog should include coding-agent");
    assert(skillsPayload.some((skill) => skill.id === "browser"), "skill catalog should include browser");
    assert.equal(skillDetailPayload.id, "coding-agent", "skill detail endpoint should resolve the requested skill");
    assert.equal(skillDetailPayload.mode, "instructional", "coding-agent should be an instructional skill");
    assert(skillDetailPayload.sourcePath.includes("apps/daemon/src/context/skills/coding-agent/SKILL.md"));
    assert(skillDetailPayload.allowedTools.includes("bash"));
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
    assert(runtimeScriptRunPayload.task?.detail?.includes("runtime-overview"), "runtime script run should capture script output");
    assert(providersPayload.some((provider) => provider.id === "aihubmix"), "provider list should include aihubmix");
    assert(providersPayload.some((provider) => provider.id === "minimax"), "provider list should include minimax");
    assert(runtimeCatalogPayload.providers.some((provider) => provider.id === "aihubmix"), "runtime catalog should include providers");
    assert(runtimeCatalogPayload.providers.some((provider) => provider.id === "minimax"), "runtime catalog should include minimax");
    assert(runtimeCatalogPayload.skills.some((skill) => skill.id === "coding-agent"), "runtime catalog should include skills");
    assert(runtimeCatalogPayload.scripts.some((script) => script.id === "runtime-overview"), "runtime catalog should include runtime scripts");
    assert(runtimeCatalogPayload.mcpServers.some((server) => server.id === "filesystem-bridge"), "runtime catalog should include mcp servers");
    assert(runtimeCatalogPayload.recentSandboxRuns.length > 0, "runtime catalog should include recent sandbox runs");
    assert(runtimeCatalogPayload.stats.sessionCount >= 1, "runtime catalog should include session stats");
    assert(runtimeCatalogPayload.stats.taskRunCount >= allTasks.length, "runtime catalog should include task stats");
    assert(runtimeCatalogPayload.stats.sandboxRunCount >= sandboxRuns.length, "runtime catalog should include sandbox stats");
    assert(runtimeCatalogPayload.queue.queuedSessionCount >= 0, "runtime catalog should include queue stats");
    assert(localScriptPayload.task?.detail?.includes("local-script-ok"), "script-runner should capture stdout");
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
    await server.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
