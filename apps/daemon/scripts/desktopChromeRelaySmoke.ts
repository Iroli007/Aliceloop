import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function createSpeechDemoWav(outputDir: string) {
  const sayPath = "/usr/bin/say";
  const afconvertPath = "/usr/bin/afconvert";
  if (!existsSync(sayPath) || !existsSync(afconvertPath)) {
    return null;
  }

  const aiffPath = join(outputDir, "relay-demo.aiff");
  const wavPath = join(outputDir, "relay-demo.wav");
  const sayResult = spawnSync(sayPath, ["-o", aiffPath, "hello aliceloop relay"], {
    stdio: "pipe",
  });
  if (sayResult.status !== 0) {
    return null;
  }

  const convertResult = spawnSync(afconvertPath, ["-f", "WAVE", "-d", "LEI16@22050", aiffPath, wavPath], {
    stdio: "pipe",
  });
  if (convertResult.status !== 0 || !existsSync(wavPath)) {
    return null;
  }

  return {
    wavPath,
    wavData: readFileSync(wavPath),
  };
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-desktop-relay-smoke-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;
  const speechFixture = createSpeechDemoWav(tempDataDir);

  const relayUserData = mkdtempSync(join(tmpdir(), "aliceloop-relay-user-"));
  const [{ ChromeRelayService, createDefaultChromeRelayServiceOptions }, { ChromeRelayHttpServer }] = await Promise.all([
    import("../../desktop/src/main/chromeRelayService.ts"),
    import("../../desktop/src/main/chromeRelayHttpServer.ts"),
  ]);

  const pageServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/form") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body><h1>Relay Smoke</h1><form action="/done" method="GET"><label>Name <input name="name" /></label><button type="submit">Submit</button></form></body></html>`);
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
      response.end(`<!doctype html><html><head><title>Relay Article</title><meta property="article:published_time" content="2026-03-23T10:00:00.000Z"></head><body><nav>ignore nav</nav><main><h1>Relay Article</h1><p>This page was rendered through desktop chrome relay.</p></main></body></html>`);
      return;
    }

    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") ?? "";
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body><div class="result"><a class="result__a" href="http://127.0.0.1:${address.port}/article">Relay Search Result</a><div class="result__snippet">Query was ${q}</div></div></body></html>`);
      return;
    }

    if (url.pathname === "/media") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
<html>
  <body>
    <h1>Relay Media Demo</h1>
    <audio id="demo-audio" controls preload="auto" src="http://127.0.0.1:${address.port}/speech.wav"></audio>
    <button id="start-demo">Start demo</button>
    <div class="subtitle" aria-live="polite">准备播放</div>
    <script>
      const audio = document.getElementById("demo-audio");
      const button = document.getElementById("start-demo");
      const subtitle = document.querySelector(".subtitle");
      button.addEventListener("click", async () => {
        subtitle.textContent = "第一句：正在播放演示语音。";
        audio.currentTime = 0;
        try {
          await audio.play();
        } catch (error) {
          subtitle.textContent = "播放失败：" + String(error);
          return;
        }
        setTimeout(() => {
          subtitle.textContent = "第二句：hello aliceloop relay";
        }, 600);
      });
    </script>
  </body>
</html>`);
      return;
    }

    if (url.pathname === "/speech.wav" && speechFixture) {
      response.setHeader("content-type", "audio/wav");
      response.end(speechFixture.wavData);
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });
  await listen(pageServer);

  const address = pageServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind page server");
  }

  process.env.ALICELOOP_WEB_SEARCH_ENDPOINT = `http://127.0.0.1:${address.port}/search`;

  const relayService = new ChromeRelayService(createDefaultChromeRelayServiceOptions(relayUserData));
  const relayServer = new ChromeRelayHttpServer(relayService);
  const skipRelaySmoke = async (reason: string) => {
    await relayServer.stop().catch(() => {});
    pageServer.close();
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason,
    }, null, 2));
  };
  let relayBaseUrl: string;
  try {
    relayBaseUrl = await relayServer.start();
  } catch (error) {
    if (!isSkippableRelayLaunchError(error)) {
      throw error;
    }

    await skipRelaySmoke(error.message);
    return;
  }
  const relayMeta = relayServer.getMeta();

  assert.ok(relayBaseUrl);
  assert.ok(relayMeta?.browserRelay?.enabled);

  const [
    { createSession, heartbeatDevice, getSessionSnapshot },
    { getBrowserSession, setBrowserSessionPreference },
    { createBrowserTools },
    { createWebFetchTool },
    { createWebSearchTool },
  ] = await Promise.all([
    import("../src/repositories/sessionRepository.ts"),
    import("../src/context/tools/browserSessionRegistry.ts"),
    import("../src/context/tools/browserTool.ts"),
    import("../src/context/tools/webFetchTool.ts"),
    import("../src/context/tools/webSearchTool.ts"),
  ]);

  const session = createSession("desktop relay smoke");
  heartbeatDevice({
    deviceId: "desktop-relay-smoke",
    deviceType: "desktop",
    label: "Aliceloop Desktop Smoke",
    sessionId: session.id,
    capabilities: relayMeta,
  });

  const snapshot = getSessionSnapshot(session.id);
  assert.equal(snapshot.devices[0]?.capabilities?.browserRelay?.backend, "desktop_chrome");

  try {
    setBrowserSessionPreference(session.id, "desktop_chrome");
    const browserSession = getBrowserSession(session.id);
    browserSession.backend = "desktop_chrome";
    browserSession.relayBaseUrl = relayBaseUrl;
    browserSession.tabId = null;
    const browserTools = createBrowserTools(session.id);
    const formUrl = `http://127.0.0.1:${address.port}/form`;
    const navigatePayload = JSON.parse(await browserTools.browser_navigate.execute({ url: formUrl }));
    assert.equal(navigatePayload.backend, "desktop_chrome");
    const inputRef = navigatePayload.elements.find((element: { tag: string; ref: string }) => element.tag === "input")?.ref;
    const buttonRef = navigatePayload.elements.find((element: { tag: string; ref: string }) => element.tag === "button")?.ref;
    assert.ok(inputRef);
    assert.ok(buttonRef);

    const typedPayload = JSON.parse(await browserTools.browser_type.execute({ ref: inputRef, text: "Aliceloop" }));
    assert.equal(typedPayload.backend, "desktop_chrome");

    const clickedPayload = JSON.parse(await browserTools.browser_click.execute({ ref: buttonRef, waitUntil: "load" }));
    assert.equal(clickedPayload.backend, "desktop_chrome");
    assert.match(clickedPayload.pageText, /Hello Aliceloop/);

    const screenshotPayload = JSON.parse(await browserTools.browser_screenshot.execute({ fullPage: true }));
    assert.equal(screenshotPayload.backend, "desktop_chrome");
    assert.ok(existsSync(screenshotPayload.path));

    if (speechFixture) {
      const mediaUrl = `http://127.0.0.1:${address.port}/media`;
      const mediaNavigatePayload = JSON.parse(await browserTools.browser_navigate.execute({ url: mediaUrl }));
      const startButtonRef = mediaNavigatePayload.elements.find((element: { tag: string; ref: string; text: string }) => {
        return element.tag === "button" && /start demo/i.test(element.text);
      })?.ref;
      assert.ok(startButtonRef, "media page should expose a start button ref");

      const mediaProbePayload = JSON.parse(await browserTools.browser_media_probe.execute({}));
      assert.equal(mediaProbePayload.backend, "desktop_chrome");
      assert.ok(mediaProbePayload.playerRef, "media probe should detect the demo audio element");

      const watchStartPayload = JSON.parse(await browserTools.browser_video_watch_start.execute({
        goal: "听懂这个演示音频在说什么",
        clipSeconds: 4,
      }));
      assert.equal(watchStartPayload.ok, true, "watch start should succeed on the media page");
      assert.ok(watchStartPayload.watchId, "watch start should return a watch id");
      assert.equal(watchStartPayload.reused, false, "first watch start should create a fresh watch");

      const watchResumePayload = JSON.parse(await browserTools.browser_video_watch_start.execute({
        goal: "继续听这个演示音频",
        clipSeconds: 4,
      }));
      assert.equal(watchResumePayload.ok, true, "restarting watch on the same player should still succeed");
      assert.equal(watchResumePayload.reused, true, "same player should reuse the existing watch session");
      assert.equal(watchResumePayload.watchId, watchStartPayload.watchId, "same player should keep the same watch id");

      await browserTools.browser_click.execute({ ref: startButtonRef, waitUntil: "domcontentloaded" });
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const watchPollPayload = JSON.parse(await browserTools.browser_video_watch_poll.execute({}));
      assert.equal(watchPollPayload.ok, true, "watch poll should succeed");
      assert.equal(watchPollPayload.watchId, watchStartPayload.watchId, "poll without watchId should reuse the active watch");
      assert.match(JSON.stringify(watchPollPayload), /第二句|provider|字幕|静音模式/i, "watch poll should return structured watch evidence or explicit limitations");

      const watchStopPayload = JSON.parse(await browserTools.browser_video_watch_stop.execute({}));
      assert.equal(watchStopPayload.ok, true, "watch stop should succeed");
      assert.equal(watchStopPayload.watchId, watchStartPayload.watchId, "stop without watchId should stop the active watch");
      assert.ok(typeof watchStopPayload.rollingSummary === "string", "watch stop should return a final rolling summary");
    }

    const fetchOutput = await createWebFetchTool(session.id).web_fetch.execute({
      url: `http://127.0.0.1:${address.port}/article`,
      extractMain: true,
      maxLength: 5000,
    });
    assert.match(fetchOutput, /Fetch Backend: desktop_chrome/);
    assert.match(fetchOutput, /Relay Article/);

    const searchOutput = JSON.parse(await createWebSearchTool(session.id).web_search.execute({
      query: "relay smoke test",
      maxResults: 3,
      domains: [],
    }));
    assert.equal(searchOutput.backend, "desktop_chrome");
    assert.equal(searchOutput.results[0]?.title, "Relay Search Result");

    await relayServer.stop();
    let unavailableError: Error | null = null;
    try {
      await browserTools.browser_snapshot.execute({});
    } catch (error) {
      unavailableError = error instanceof Error ? error : new Error(String(error));
    }
    assert.ok(unavailableError);
    assert.match(unavailableError.message, /desktop_browser_unavailable/);

    pageServer.close();

    console.log(JSON.stringify({
      ok: true,
      relayBaseUrl,
      backend: navigatePayload.backend,
      searchBackend: searchOutput.backend,
      finalPageText: clickedPayload.pageText,
      screenshotPath: screenshotPayload.path,
      mediaFixture: Boolean(speechFixture),
      unavailableError: unavailableError.message,
    }, null, 2));
  } catch (error) {
    if (!isSkippableRelayLaunchError(error)) {
      throw error;
    }

    await skipRelaySmoke(error.message);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
