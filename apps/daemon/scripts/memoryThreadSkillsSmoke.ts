import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function flattenSystemPrompt(
  systemPrompt: string | Array<{ role: "system"; content: string }>,
) {
  return Array.isArray(systemPrompt)
    ? systemPrompt.map((message) => message.content).join("\n\n")
    : systemPrompt;
}

function cleanupKeychainSecret(serviceName: string) {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    execFileSync("security", [
      "delete-generic-password",
      "-a",
      "provider:openai",
      "-s",
      serviceName,
    ], {
      stdio: "ignore",
    });
  } catch {
    // Missing secret is fine for smoke cleanup.
  }
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-memory-thread-skills-"));
  const keychainService = `Aliceloop Memory Thread Skills ${randomUUID()}`;
  process.env.ALICELOOP_DATA_DIR = tempDataDir;
  process.env.ALICELOOP_PROVIDER_KEYCHAIN_SERVICE = keychainService;
  process.env.OPENAI_API_KEY = "";
  process.env.OPENAI_BASE_URL = "";

  try {
    const [
      { loadContext },
      { createSession, createSessionMessage },
      { createProjectDirectory },
      { createMemory },
      { resetSkillCatalogCache, selectRelevantSkillDefinitions },
    ] = await Promise.all([
      import("../src/context/index.ts"),
      import("../src/repositories/sessionRepository.ts"),
      import("../src/repositories/projectRepository.ts"),
      import("../src/context/memory/memoryRepository.ts"),
      import("../src/context/skills/skillLoader.ts"),
    ]);

    resetSkillCatalogCache();

    const memorySkills = selectRelevantSkillDefinitions("你还记得这个项目的回答风格偏好吗？");
    assert(
      memorySkills.some((skill) => skill.id === "memory-management"),
      "project recall should keep routing memory-management",
    );

    const threadSkills = selectRelevantSkillDefinitions("帮我列一下最近的线程列表");
    assert.deepEqual(
      threadSkills.map((skill) => skill.id),
      ["thread-management"],
      "explicit thread administration should stay focused on thread-management",
    );

    const alphaProject = createProjectDirectory({
      name: "Skill Smoke Alpha",
      path: join(tempDataDir, "skill-smoke-alpha"),
    });
    const betaProject = createProjectDirectory({
      name: "Skill Smoke Beta",
      path: join(tempDataDir, "skill-smoke-beta"),
    });

    await createMemory({
      content: "这个项目偏好简洁回答风格，默认用中文。",
      source: "manual",
      durability: "permanent",
      projectId: alphaProject.id,
      relatedTopics: ["回答风格", "中文", "简洁", "你还记得这个项目的回答风格偏好吗"],
    });
    await createMemory({
      content: "这个项目偏好详细回答风格，默认用英文。",
      source: "manual",
      durability: "permanent",
      projectId: betaProject.id,
      relatedTopics: ["回答风格", "英文", "详细", "你还记得这个项目的回答风格偏好吗"],
    });

    const scopedMemorySession = createSession({
      title: "scoped memory skill smoke",
      projectId: alphaProject.id,
    });
    createSessionMessage({
      sessionId: scopedMemorySession.id,
      clientMessageId: "scoped-memory-user-1",
      deviceId: "desktop-smoke",
      role: "user",
      content: "你还记得这个项目的回答风格偏好吗？",
      attachmentIds: [],
    });

    const scopedMemoryContext = await loadContext(scopedMemorySession.id, new AbortController().signal);
    const scopedMemoryPrompt = flattenSystemPrompt(scopedMemoryContext.systemPrompt);
    assert(
      scopedMemoryContext.routedSkillIds.includes("memory-management"),
      "scoped recall turns should still route memory-management",
    );
    assert.deepEqual(
      scopedMemoryContext.firstStepToolChoice,
      { type: "tool", toolName: "bash" },
      "memory-management turns should keep the original bash-first workflow",
    );
    assert.match(
      scopedMemoryPrompt,
      /这个项目偏好简洁回答风格，默认用中文。/u,
      "memory-management should still inject the matching project-scoped memory into context",
    );
    assert.doesNotMatch(
      scopedMemoryPrompt,
      /这个项目偏好详细回答风格，默认用英文。/u,
      "memory-management should not leak another project's scoped memory into context",
    );

    const threadManagementSession = createSession("thread management bash smoke");
    createSessionMessage({
      sessionId: threadManagementSession.id,
      clientMessageId: "thread-management-user-1",
      deviceId: "desktop-smoke",
      role: "user",
      content: "帮我列一下最近的线程列表",
      attachmentIds: [],
    });

    const threadManagementContext = await loadContext(threadManagementSession.id, new AbortController().signal);
    assert(
      threadManagementContext.routedSkillIds.includes("thread-management"),
      "explicit thread administration should continue routing thread-management",
    );
    assert.equal(
      threadManagementContext.routedSkillIds.includes("memory-management"),
      false,
      "thread-management turns should stay separate from memory-management",
    );
    assert.deepEqual(
      threadManagementContext.firstStepToolChoice,
      { type: "tool", toolName: "bash" },
      "thread-management turns should keep the original bash-first CLI workflow",
    );
    assert.equal(typeof threadManagementContext.tools.bash, "object", "thread-management turns should keep bash attached");
    assert.equal(typeof threadManagementContext.tools.read, "object", "thread-management turns should keep read attached");
    assert.equal(typeof threadManagementContext.tools.write, "object", "thread-management turns should keep write attached");
  } finally {
    cleanupKeychainSecret(keychainService);
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
