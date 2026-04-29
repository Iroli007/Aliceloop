import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-memory-files-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const {
    createMemory,
    deleteMemory,
    listMemoryProjectionRecords,
  } = await import("../../src/context/memory/memoryRepository");
  const {
    ensureMemoryFileProjection,
    findTopicMemoryManifests,
    readMemoryTopicFile,
    syncMemoryFileProtocol,
  } = await import("../../src/context/memory/memoryFileProtocol");
  const {
    buildProfileFactMemoryBlock,
  } = await import("../../src/context/memory/memoryContext");

  try {
    const first = await createMemory({
      title: "Chinese reply style",
      description: "Prefer concise Chinese answers",
      content: "Prefer concise answers in Chinese.",
      source: "manual",
      durability: "permanent",
      memoryType: "feedback",
      factKind: "preference",
      factKey: `reply-style-${randomUUID()}`,
      relatedTopics: ["language", "style"],
    });

    syncMemoryFileProtocol(listMemoryProjectionRecords());
    const firstTopic = readMemoryTopicFile(first.id);
    assert.equal(firstTopic?.id, first.id, "topic frontmatter should read back the memory id");
    assert.equal(firstTopic?.factState, "active", "new topic should be active");
    assert.equal(firstTopic?.content, first.content, "topic body should expose full content");
    assert(
      findTopicMemoryManifests("concise Chinese", 5).some((memory) => memory.id === first.id),
      "active topic manifest should be retrievable",
    );

    const second = await createMemory({
      title: "Chinese reply style",
      description: "Prefer direct Chinese answers",
      content: "Prefer direct answers in Chinese.",
      source: "manual",
      durability: "permanent",
      memoryType: "feedback",
      factKind: "preference",
      factKey: first.factKey,
      relatedTopics: ["language", "style"],
    });
    assert.notEqual(second.id, first.id, "changed fact content should create a new active memory");

    syncMemoryFileProtocol(listMemoryProjectionRecords());
    const supersededTopic = readMemoryTopicFile(first.id);
    assert.equal(supersededTopic?.factState, "superseded", "superseded memory should keep an archived topic file");
    assert(
      !findTopicMemoryManifests("concise Chinese", 5).some((memory) => memory.id === first.id),
      "superseded topic should not be retrieved as active context",
    );

    deleteMemory(second.id);
    syncMemoryFileProtocol(listMemoryProjectionRecords());
    const retractedTopic = readMemoryTopicFile(second.id);
    assert.equal(retractedTopic?.factState, "retracted", "retracted memory should keep an archived topic file");
    assert(
      !findTopicMemoryManifests("direct Chinese", 5).some((memory) => memory.id === second.id),
      "retracted topic should not be retrieved as active context",
    );

    const index = readFileSync(join(tempDataDir, "memory", "MEMORY.md"), "utf8");
    assert(index.includes("## Archived Memories"), "index should include an archived audit section");
    assert(index.includes("- state: superseded"), "index should expose superseded state");
    assert(index.includes("- state: retracted"), "index should expose retracted state");

    const third = await createMemory({
      title: "Projection repair smoke",
      description: "Project memory file projection can rebuild missing topics",
      content: "Project memory file projection should rebuild missing topic files from SQL.",
      source: "manual",
      durability: "permanent",
      memoryType: "project",
      factKind: "workflow",
      factKey: `projection-repair-${randomUUID()}`,
      relatedTopics: ["memory", "projection"],
    });
    syncMemoryFileProtocol(listMemoryProjectionRecords());
    const thirdTopicPath = join(tempDataDir, "memory", "topics", `${third.id}.md`);
    unlinkSync(thirdTopicPath);

    const repairedBlock = await buildProfileFactMemoryBlock("projection repair smoke", { limit: 5 });
    assert.equal(repairedBlock.timings.projectionRebuilt, 1, "retrieval should rebuild a missing MD projection from SQL");
    assert(existsSync(thirdTopicPath), "missing topic file should be recreated");
    assert(repairedBlock.content.includes(third.id), "retrieved memory block should include the repaired manifest");

    const currentProjection = ensureMemoryFileProjection(listMemoryProjectionRecords());
    assert.equal(currentProjection.rebuilt, false, "fresh projection should not rebuild again");
  } finally {
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
