import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-assistant-events-integration-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const {
    createSession,
    createSessionMessage,
    listSessionEventsSince,
  } = await import("../../src/repositories/sessionRepository.ts");

  try {
    const session = createSession("Assistant Event Tools Smoke");
    const result = createSessionMessage({
      sessionId: session.id,
      clientMessageId: "assistant-event-tools-smoke",
      deviceId: "runtime-agent",
      role: "assistant",
      content: "Testing assistant event payload tool metadata.",
      attachmentIds: [],
      eventPayload: {
        skills: ["self-management", "skill-hub"],
        tools: ["bash"],
      },
    });

    assert.equal(result.created, true, "assistant message should be created");

    const events = listSessionEventsSince(session.id, 0);
    const assistantEvent = events.find((event) => event.type === "message.created");
    assert(assistantEvent, "assistant message.created event should exist");

    const payload = assistantEvent?.payload as { skills?: unknown; tools?: unknown; message?: unknown };
    assert.deepEqual(payload.skills, ["self-management", "skill-hub"], "assistant event should preserve routed skills");
    assert.deepEqual(payload.tools, ["bash"], "assistant event should preserve attached tools");

    console.log(JSON.stringify({
      ok: true,
      sessionId: session.id,
      eventTypes: events.map((event) => event.type),
      payload,
    }, null, 2));
  } finally {
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
