import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.ok, true, `GET ${url} should succeed`);
  return await response.json() as T;
}

async function sendJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.ok, true, `POST ${url} should succeed`);
  return await response.json() as T;
}

async function waitForAssistantReply(baseUrl: string, sessionId: string, expectedText: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snapshot = await getJson<{ messages: Array<{ role: string; content: string }> }>(
      `${baseUrl}/api/session/${encodeURIComponent(sessionId)}/snapshot`,
    );

    if (snapshot.messages.some((message) => message.role === "assistant" && message.content.includes(expectedText))) {
      return snapshot;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for local fallback assistant reply");
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-daemon-smoke-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;
  process.env.ALICELOOP_PROVIDER_KEYCHAIN_SERVICE = `Aliceloop Daemon Smoke ${Date.now()}`;
  process.env.ALICELOOP_SCHEDULER_POLL_MS = "100";

  let server: Awaited<ReturnType<typeof import("../src/server.ts").createServer>> | null = null;
  try {
    const { createServer } = await import("../src/server.ts");
    server = await createServer();
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve daemon address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const health = await getJson<{ ok: boolean; service: string; activeSkills: string[] }>(`${baseUrl}/health`);
    assert.equal(health.ok, true, "health should be ok");
    assert.equal(health.service, "aliceloop-daemon", "health should identify the daemon");
    assert(health.activeSkills.includes("web-search"), "core skill catalog should be loaded");

    const uniquePrompt = `daemon smoke ${Date.now()}`;
    const session = await sendJson<{ id: string }>(`${baseUrl}/api/sessions`, {
      title: "Daemon Main Smoke",
    });
    assert(session.id, "session creation should return an id");

    const messageResult = await sendJson<{ created: boolean; message: { id: string } }>(
      `${baseUrl}/api/session/${encodeURIComponent(session.id)}/messages`,
      {
        clientMessageId: `daemon-smoke-${Date.now()}`,
        content: uniquePrompt,
        role: "user",
        attachmentIds: [],
        deviceId: "daemon-smoke",
        deviceType: "desktop",
      },
    );
    assert.equal(messageResult.created, true, "user message should be created");
    assert(messageResult.message.id, "message response should include the message id");

    const snapshot = await waitForAssistantReply(baseUrl, session.id, "Aliceloop 的最小闭环是通的。");
    assert(
      snapshot.messages.some((message) => message.role === "user" && message.content.includes(uniquePrompt)),
      "snapshot should include the submitted user message",
    );

    const threads = await getJson<Array<{ id: string; latestMessagePreview: string | null }>>(`${baseUrl}/api/sessions`);
    assert(threads.some((thread) => thread.id === session.id), "session list should include the smoke session");

    const runtimeCatalog = await getJson<{
      stats: { sessionCount: number; messageCount: number };
      skills: Array<{ id: string }>;
    }>(`${baseUrl}/api/runtime/catalog?limit=5`);
    assert(runtimeCatalog.stats.sessionCount >= 1, "runtime catalog should expose session stats");
    assert(runtimeCatalog.stats.messageCount >= 2, "runtime catalog should expose message stats");
    assert(runtimeCatalog.skills.some((skill) => skill.id === "web-search"), "runtime catalog should expose skills");

    console.log(JSON.stringify({
      ok: true,
      sessionId: session.id,
      messageCount: snapshot.messages.length,
      skillCount: runtimeCatalog.skills.length,
    }, null, 2));
  } finally {
    delete process.env.ALICELOOP_DATA_DIR;
    delete process.env.ALICELOOP_PROVIDER_KEYCHAIN_SERVICE;
    delete process.env.ALICELOOP_SCHEDULER_POLL_MS;
    await server?.close().catch(() => undefined);
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
