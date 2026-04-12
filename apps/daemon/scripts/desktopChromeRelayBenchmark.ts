import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

type BrowserSnapshotPayload = {
  backend?: string;
  elements?: Array<{ tag?: string; ref?: string }>;
  pageText?: string;
};

type BrowserScreenshotPayload = {
  backend?: string;
  path?: string;
};

type SearchPayload = {
  backend?: string;
  results?: Array<{ title?: string }>;
};

function stats(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);
  const avg = sum / values.length;
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return {
    count: values.length,
    minMs: round(sorted[0] ?? 0),
    medianMs: round(median),
    avgMs: round(avg),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

async function measure<T>(callback: () => Promise<T>) {
  const startedAt = performance.now();
  const result = await callback();
  return {
    durationMs: round(performance.now() - startedAt),
    result,
  };
}

async function repeat<T>(count: number, callback: () => Promise<T>) {
  const durations: number[] = [];
  let latest: T | null = null;
  for (let index = 0; index < count; index += 1) {
    const measured = await measure(callback);
    durations.push(measured.durationMs);
    latest = measured.result;
  }

  return {
    durations,
    summary: stats(durations),
    latest,
  };
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isSkippableRelayLaunchError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /Chrome exited before DevTools was ready|Timed out waiting for Chrome DevTools port|spawn .*ENOENT/i.test(error.message);
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-desktop-relay-bench-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;
  process.env.ALICELOOP_TRACE_TIMINGS = "0";

  const pageServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/form") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body><h1>Relay Bench</h1><form action="/done" method="GET"><label>Name <input name="name" /></label><button type="submit">Submit</button></form></body></html>`);
      return;
    }

    if (url.pathname === "/done") {
      const name = url.searchParams.get("name") ?? "Unknown";
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body><h1>Done</h1><p id="result">Hello ${name}</p></body></html>`);
      return;
    }

    if (url.pathname === "/article") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head><title>Relay Benchmark Article</title><meta property="article:published_time" content="2026-03-23T10:00:00.000Z"></head><body><nav>ignore nav</nav><main><h1>Relay Benchmark Article</h1><p>This page was rendered through the Aliceloop benchmark server.</p></main></body></html>`);
      return;
    }

    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") ?? "";
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body><div class="result"><a class="result__a" href="http://127.0.0.1:${address.port}/article">Relay Search Result</a><div class="result__snippet">Query was ${q}</div></div></body></html>`);
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });
  await listen(pageServer);

  const address = pageServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind benchmark page server");
  }

  process.env.ALICELOOP_WEB_SEARCH_ENDPOINT = `http://127.0.0.1:${address.port}/search`;

  const [
    { ChromeRelayService, createDefaultChromeRelayServiceOptions },
    { ChromeRelayHttpServer },
    { createSession, heartbeatDevice },
    { getBrowserSession, setBrowserSessionPreference },
    { createBrowserTools },
    { createWebFetchTool },
    { createWebSearchTool },
  ] = await Promise.all([
    import("../../desktop/src/main/chromeRelayService.ts"),
    import("../../desktop/src/main/chromeRelayHttpServer.ts"),
    import("../src/repositories/sessionRepository.ts"),
    import("../src/context/tools/browserSessionRegistry.ts"),
    import("../src/context/tools/browserTool.ts"),
    import("../src/context/tools/webFetchTool.ts"),
    import("../src/context/tools/webSearchTool.ts"),
  ]);

  const relayUserData = mkdtempSync(join(tmpdir(), "aliceloop-relay-bench-user-"));
  const relayService = new ChromeRelayService(createDefaultChromeRelayServiceOptions(relayUserData));
  const relayServer = new ChromeRelayHttpServer(relayService);
  const skipRelayBenchmark = async (reason: string) => {
    await relayServer.stop().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      pageServer.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve();
      });
    });
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason,
    }, null, 2));
  };
  let relayStart: Awaited<ReturnType<typeof measure<string>>>;
  try {
    relayStart = await measure(async () => relayServer.start());
  } catch (error) {
    if (!isSkippableRelayLaunchError(error)) {
      throw error;
    }

    await skipRelayBenchmark(error.message);
    return;
  }
  const relayBaseUrl = relayStart.result;
  const relayMeta = relayServer.getMeta();

  assert.ok(relayBaseUrl);
  assert.ok(relayMeta?.browserRelay?.enabled);

  const formUrl = `http://127.0.0.1:${address.port}/form`;
  const articleUrl = `http://127.0.0.1:${address.port}/article`;

  const desktopSession = createSession("desktop relay benchmark");
  heartbeatDevice({
    deviceId: "desktop-relay-benchmark",
    deviceType: "desktop",
    label: "Aliceloop Desktop Benchmark",
    sessionId: desktopSession.id,
    capabilities: relayMeta,
  });
  setBrowserSessionPreference(desktopSession.id, "desktop_chrome");
  const browserSession = getBrowserSession(desktopSession.id);
  browserSession.backend = "desktop_chrome";
  browserSession.relayBaseUrl = relayBaseUrl;
  browserSession.tabId = null;

  const desktopBrowserTools = createBrowserTools(desktopSession.id);
  const desktopFetchTool = createWebFetchTool(desktopSession.id).web_fetch;
  const desktopSearchTool = createWebSearchTool(desktopSession.id).web_search;

  try {
    const coldNavigate = await measure(async () => {
      const payload = JSON.parse(await desktopBrowserTools.browser_navigate.execute({ url: formUrl })) as BrowserSnapshotPayload;
      assert.equal(payload.backend, "desktop_chrome");
      return payload;
    });

    const inputRef = coldNavigate.result.elements?.find((element) => element.tag === "input")?.ref;
    const buttonRef = coldNavigate.result.elements?.find((element) => element.tag === "button")?.ref;
    assert.ok(inputRef);
    assert.ok(buttonRef);

    const warmNavigate = await repeat(3, async () => {
      const payload = JSON.parse(await desktopBrowserTools.browser_navigate.execute({ url: articleUrl })) as BrowserSnapshotPayload;
      assert.equal(payload.backend, "desktop_chrome");
      return payload;
    });

    const snapshotRuns = await repeat(3, async () => {
      const payload = JSON.parse(await desktopBrowserTools.browser_snapshot.execute({})) as BrowserSnapshotPayload;
      assert.equal(payload.backend, "desktop_chrome");
      return payload;
    });

    await desktopBrowserTools.browser_navigate.execute({ url: formUrl });
    const typeRuns = await repeat(3, async () => {
      await desktopBrowserTools.browser_navigate.execute({ url: formUrl });
      const payload = JSON.parse(await desktopBrowserTools.browser_type.execute({ ref: inputRef, text: "Aliceloop" })) as BrowserSnapshotPayload;
      assert.equal(payload.backend, "desktop_chrome");
      return payload;
    });

    const clickRuns = await repeat(3, async () => {
      await desktopBrowserTools.browser_navigate.execute({ url: formUrl });
      await desktopBrowserTools.browser_type.execute({ ref: inputRef, text: "Aliceloop" });
      const payload = JSON.parse(await desktopBrowserTools.browser_click.execute({ ref: buttonRef, waitUntil: "load" })) as BrowserSnapshotPayload;
      assert.equal(payload.backend, "desktop_chrome");
      assert.match(payload.pageText ?? "", /Hello Aliceloop/);
      return payload;
    });

    const screenshotRuns = await repeat(3, async () => {
      const payload = JSON.parse(await desktopBrowserTools.browser_screenshot.execute({ fullPage: true })) as BrowserScreenshotPayload;
      assert.equal(payload.backend, "desktop_chrome");
      assert.ok(payload.path && existsSync(payload.path));
      return payload;
    });

    const desktopFetchRuns = await repeat(3, async () => {
      const output = await desktopFetchTool.execute({
        url: articleUrl,
        extractMain: true,
        maxLength: 5000,
      });
      assert.match(output, /Fetch Backend: desktop_chrome/);
      return output;
    });

    const desktopSearchRuns = await repeat(3, async () => {
      const output = JSON.parse(await desktopSearchTool.execute({
        query: "relay benchmark",
        maxResults: 3,
        domains: [],
      })) as SearchPayload;
      assert.equal(output.backend, "desktop_chrome");
      return output;
    });

    heartbeatDevice({
      deviceId: "desktop-relay-benchmark",
      deviceType: "desktop",
      label: "Aliceloop Desktop Benchmark",
      sessionId: desktopSession.id,
      capabilities: {
        browserRelay: {
          ...relayMeta!.browserRelay!,
          healthy: false,
        },
      },
    });

    await relayServer.stop();
    await new Promise<void>((resolve, reject) => {
      pageServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    

    console.log(JSON.stringify({
      ok: true,
      relayStartMs: relayStart.durationMs,
      desktopChrome: {
        backend: "desktop_chrome",
        browserNavigateColdMs: coldNavigate.durationMs,
        browserNavigateWarm: warmNavigate.summary,
        browserSnapshotWarm: snapshotRuns.summary,
        browserTypeWarm: typeRuns.summary,
        browserClickWarm: clickRuns.summary,
        browserScreenshotWarm: screenshotRuns.summary,
        webFetch: desktopFetchRuns.summary,
        webSearch: desktopSearchRuns.summary,
      },
    }, null, 2));
  } catch (error) {
    if (!isSkippableRelayLaunchError(error)) {
      throw error;
    }

    await skipRelayBenchmark(error.message);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
