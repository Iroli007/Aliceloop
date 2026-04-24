import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

interface StartedDaemon {
  stop: () => Promise<void>;
  stdout: string[];
  stderr: string[];
}

async function waitForHealth(baseUrl: string, timeoutMs = 15_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return await response.json() as { activeSkills: string[]; service: string };
      }
    } catch {
      // Daemon not ready yet.
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }

  throw new Error(`Timed out waiting for daemon health at ${baseUrl}`);
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  throw new Error(`Timed out waiting for condition: ${label}`);
}

async function startBuiltDaemon(env: NodeJS.ProcessEnv): Promise<StartedDaemon> {
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: resolve(process.cwd()),
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk) => {
    stdout.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  const stop = async () => {
    if (child.killed || child.exitCode !== null) {
      return;
    }

    child.kill("SIGINT");
    await new Promise<void>((resolvePromise) => {
      child.once("exit", () => resolvePromise());
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 5_000);
    });
  };

  return { stop, stdout, stderr };
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
    // Missing secret is fine.
  }
}

async function getJson<T>(url: string) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `GET ${url} should succeed`);
  return await response.json() as T;
}

async function sendJson<T>(url: string, method: "POST" | "PUT" | "DELETE", body?: unknown) {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) as T : null;
  return {
    status: response.status,
    ok: response.ok,
    json,
  };
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-memory-smoke-"));
  const keychainService = `Aliceloop Memory Smoke ${randomUUID()}`;
  const basePort = 3055;
  const baseUrl = `http://127.0.0.1:${basePort}`;
  let daemon: StartedDaemon | null = null;

  try {
    const commonEnv = {
      ALICELOOP_DAEMON_PORT: String(basePort),
      ALICELOOP_DAEMON_HOST: "127.0.0.1",
      ALICELOOP_DATA_DIR: tempDataDir,
      ALICELOOP_PROVIDER_KEYCHAIN_SERVICE: keychainService,
      ALICELOOP_SCHEDULER_POLL_MS: "100",
    };

    daemon = await startBuiltDaemon(commonEnv);
    const health = await waitForHealth(baseUrl);
    assert.equal(health.service, "aliceloop-daemon", "daemon should report service name");
    assert(health.activeSkills.includes("web-search"), "built daemon should load skills from source tree");

    const config = await getJson<{
      enabled: boolean;
      maxRetrievalCount: number;
      queryRewrite: boolean;
    }>(`${baseUrl}/api/memory/config`);
    assert.equal(config.enabled, true, "memory should default to enabled");
    assert.equal(config.maxRetrievalCount, 8, "memory retrieval count should default to 8");

    const created = await sendJson<{
      id: string;
      content: string;
      accessCount: number;
    }>(`${baseUrl}/api/memory/entries`, "POST", {
      content: "The Aliceloop daemon uses Fastify for its HTTP server.",
      source: "manual",
      durability: "permanent",
      relatedTopics: ["fastify", "server"],
    });
    assert.equal(created.status, 201, "semantic memory creation should succeed");
    assert(created.json?.id, "semantic memory creation should return an id");

    const search = await getJson<Array<{ id: string; similarityScore: number }>>(
      `${baseUrl}/api/memory/search?q=${encodeURIComponent("fastify server")}&limit=5`,
    );
    assert.equal(search[0]?.id, created.json?.id, "semantic memory search should find the created memory");

    const typedFact = {
      content: "Prefer concise answers in Chinese.",
      source: "manual",
      durability: "permanent",
      factKind: "preference",
      factKey: "reply-style",
      factState: "active",
      relatedTopics: ["language", "style"],
    };
    const factCreated = await sendJson<{
      id: string;
      content: string;
      factKind: string | null;
      factKey: string | null;
      factState: string;
    }>(`${baseUrl}/api/memory/entries`, "POST", typedFact);
    assert.equal(factCreated.status, 201, "typed fact creation should succeed");
    assert.equal(factCreated.json?.factState, "active", "new typed fact should start active");

    const factDuplicate = await sendJson<{
      id: string;
      factState: string;
    }>(`${baseUrl}/api/memory/entries`, "POST", typedFact);
    assert.equal(factDuplicate.status, 201, "duplicate typed fact should still return a record");
    assert.equal(factDuplicate.json?.id, factCreated.json?.id, "same key and content should reuse the active fact");

    const factSuperseding = await sendJson<{
      id: string;
      factState: string;
    }>(`${baseUrl}/api/memory/entries`, "POST", {
      ...typedFact,
      content: "Prefer direct answers in Chinese.",
    });
    assert.equal(factSuperseding.status, 201, "superseding typed fact should succeed");
    assert.notEqual(factSuperseding.json?.id, factCreated.json?.id, "changed content should create a new active fact");

    const supersededRow = await getJson<{ id: string; factState: string }>(`${baseUrl}/api/memory/entries/${factCreated.json?.id}`);
    assert.equal(supersededRow.factState, "superseded", "previous active fact should be superseded");

    const retract = await sendJson<{ ok: boolean }>(`${baseUrl}/api/memory/entries/${factSuperseding.json?.id}`, "DELETE");
    assert.equal(retract.status, 200, "typed fact delete should succeed");

    const retractedRow = await getJson<{ id: string; factState: string }>(`${baseUrl}/api/memory/entries/${factSuperseding.json?.id}`);
    assert.equal(retractedRow.factState, "retracted", "deleted typed fact should be retracted");

    const activeMemories = await getJson<Array<{ id: string; factState: string }>>(
      `${baseUrl}/api/memory/entries?limit=20`,
    );
    assert(
      activeMemories.every((memory) => memory.factState === "active"),
      "memory listing should default to active records only",
    );

    const updatedConfig = await sendJson<{ maxRetrievalCount: number; queryRewrite: boolean }>(
      `${baseUrl}/api/memory/config`,
      "PUT",
      {
        maxRetrievalCount: 3,
        queryRewrite: true,
      },
    );
    assert.equal(updatedConfig.status, 200, "memory config update should succeed");
    assert.equal(updatedConfig.json?.maxRetrievalCount, 3, "memory config should persist updates");

    const rebuild = await fetch(`${baseUrl}/api/memory/rebuild`, { method: "POST" });
    assert.equal(rebuild.status, 409, "rebuild should report missing embedding provider when not configured");

    await daemon.stop();
    daemon = await startBuiltDaemon(commonEnv);
    await waitForHealth(baseUrl);

    const restartConfig = await getJson<{ queryRewrite: boolean }>(`${baseUrl}/api/memory/config`);
    assert.equal(restartConfig.queryRewrite, true, "config should survive daemon restart");

    const providerUpdate = await sendJson<{ enabled: boolean }>(`${baseUrl}/api/providers/openai`, "PUT", {
      baseUrl: "http://127.0.0.1:65535/v1",
      model: "gpt-4.1-mini",
      apiKey: "dummy-memory-smoke-key",
      enabled: true,
    });
    assert.equal(providerUpdate.status, 200, "provider update should succeed for smoke");

    const messageResponse = await sendJson<{
      created: boolean;
      message: { id: string };
    }>(`${baseUrl}/api/session/session-primary/messages`, "POST", {
      clientMessageId: `memory-smoke-${randomUUID()}`,
      content: "Please use the Fastify server memory and answer briefly.",
      deviceId: "memory-smoke-desktop",
      deviceType: "desktop",
    });
    assert.equal(messageResponse.status, 200, "session message should be accepted");
    assert.equal(messageResponse.json?.created, true, "session message should be created");

    let snapshot = await getJson<{
      jobs: Array<{ status: string; title: string; detail: string }>;
      messages: Array<{ role: string; content: string }>;
    }>(`${baseUrl}/api/session/session-primary/snapshot`);
    await waitForCondition(async () => {
      snapshot = await getJson<{
        jobs: Array<{ status: string; title: string; detail: string }>;
        messages: Array<{ role: string; content: string }>;
      }>(`${baseUrl}/api/session/session-primary/snapshot`);

      return snapshot.jobs.some((job) => job.status === "failed")
        && snapshot.messages.some((message) => message.role === "system" && message.content.includes("Agent error"));
    }, 30_000, "provider failure snapshot state");

    assert(
      snapshot.jobs.some((job) => job.status === "failed"),
      "bad provider path should fail gracefully without crashing the daemon",
    );
    assert(
      snapshot.messages.some((message) => message.role === "system" && message.content.includes("Agent error")),
      "failed provider run should record a runtime notice",
    );
  } finally {
    await daemon?.stop();
    cleanupKeychainSecret(keychainService);
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
