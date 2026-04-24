import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const daemonWorkspace = resolve(workspaceRoot, "apps/daemon");
const desktopWorkspace = resolve(workspaceRoot, "apps/desktop");

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForHealth(baseUrl, timeoutMs = 20_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Daemon not ready yet.
    }

    await delay(200);
  }

  throw new Error(`Timed out waiting for daemon health at ${baseUrl}`);
}

async function waitForCondition(predicate, timeoutMs, label) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for condition: ${label}`);
}

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `GET ${url} should succeed`);
  return await response.json();
}

async function startBuiltDaemon(env) {
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: daemonWorkspace,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => {
    stdout.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  return {
    stdout,
    stderr,
    stop: async () => {
      if (child.killed || child.exitCode !== null) {
        return;
      }

      child.kill("SIGINT");
      await new Promise((resolvePromise) => {
        child.once("exit", () => resolvePromise());
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, 5_000);
      });
    },
  };
}

function runBuild() {
  execFileSync("npm", ["run", "build", "--workspace", "@aliceloop/desktop"], {
    cwd: workspaceRoot,
    stdio: "ignore",
  });
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), "aliceloop-desktop-ui-smoke-"));
  const daemonDataDir = join(tempRoot, "daemon-data");
  const desktopUserDataDir = join(tempRoot, "desktop-user-data");
  const screenshotPath = join(tempRoot, "desktop-ui-smoke.png");
  const daemonPort = 3065;
  const daemonBaseUrl = `http://127.0.0.1:${daemonPort}`;
  const uniquePrompt = `desktop ui smoke ${Date.now()}`;
  const fallbackReply = [
    "已收到你的消息，Aliceloop 的最小闭环是通的。",
    `我收到的是：${uniquePrompt}`,
    "当前还没有配置可用的模型网关，所以这里先返回本地组装的 assistant 回复。配置 API key 后，这里会切换成真实模型生成。",
  ].join("\n\n");
  const providerKeychainService = `Aliceloop Desktop UI Smoke ${randomUUID()}`;
  let daemon = null;
  let electronApp = null;
  let failure = null;

  try {
    runBuild();

    daemon = await startBuiltDaemon({
      ALICELOOP_DAEMON_HOST: "127.0.0.1",
      ALICELOOP_DAEMON_PORT: String(daemonPort),
      ALICELOOP_DATA_DIR: daemonDataDir,
      ALICELOOP_PROVIDER_KEYCHAIN_SERVICE: providerKeychainService,
      ALICELOOP_SCHEDULER_POLL_MS: "100",
    });

    await waitForHealth(daemonBaseUrl);

    electronApp = await electron.launch({
      executablePath: electronPath,
      args: [resolve(desktopWorkspace, "dist/main/index.js")],
      cwd: desktopWorkspace,
      env: {
        ...process.env,
        ALICELOOP_DAEMON_URL: daemonBaseUrl,
        ALICELOOP_DESKTOP_USER_DATA_DIR: desktopUserDataDir,
      },
    });

    const window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 1280, height: 900 });
    await window.waitForLoadState("domcontentloaded");
    await window.locator(".shell").waitFor({ state: "visible" });
    await window.locator(".sidebar__new-chat").waitFor({ state: "visible" });
    await window.locator(".composer__input--field").waitFor({ state: "visible" });
    await window.locator(".composer__send").waitFor({ state: "visible" });
    await window.getByText("Daemon 未连接").waitFor({ state: "hidden" }).catch(() => undefined);

    const threadsBeforeSend = await getJson(`${daemonBaseUrl}/api/sessions`);
    const existingThreadIds = new Set(threadsBeforeSend.map((thread) => thread.id));
    await window.locator(".sidebar__new-chat").dispatchEvent("click");

    const composerInput = window.locator(".composer__input--field");
    await composerInput.click();
    await composerInput.type(uniquePrompt);
    await window.waitForFunction((value) => {
      const input = document.querySelector(".composer__input--field");
      return input instanceof HTMLTextAreaElement && input.value === value;
    }, uniquePrompt);
    await window.waitForFunction(() => {
      const button = document.querySelector(".composer__send");
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await composerInput.press("Enter");

    await window.locator(".workspace__message--user").getByText(uniquePrompt, { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    await window.getByText("Aliceloop 的最小闭环是通的。", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    await window.screenshot({ path: screenshotPath });

    const threads = await getJson(`${daemonBaseUrl}/api/sessions`);
    const matchingThread = threads.find((thread) => {
      return typeof thread.latestMessagePreview === "string" && thread.latestMessagePreview.includes(uniquePrompt);
    });
    assert(matchingThread, "sent message should create a persisted thread");
    assert(!existingThreadIds.has(matchingThread.id), "new chat first message should create a new thread instead of updating a previous one");

    const snapshot = await getJson(`${daemonBaseUrl}/api/session/${encodeURIComponent(matchingThread.id)}/snapshot`);
    assert(snapshot.messages.some((message) => message.role === "user" && message.content.includes(uniquePrompt)), "snapshot should include the user message");
    assert(snapshot.messages.some((message) => message.role === "assistant" && message.content.includes(fallbackReply)), "snapshot should include the local fallback assistant reply");

    console.log(JSON.stringify({
      ok: true,
      daemonBaseUrl,
      sessionId: matchingThread.id,
      screenshotPath,
      messageCount: snapshot.messages.length,
    }, null, 2));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure && daemon) {
      console.error("[desktop-ui-smoke] daemon stdout");
      console.error(daemon.stdout.join(""));
      console.error("[desktop-ui-smoke] daemon stderr");
      console.error(daemon.stderr.join(""));
    }

    await electronApp?.close().catch(() => undefined);
    await daemon?.stop().catch(() => undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
