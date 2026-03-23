import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
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

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-desktop-relay-smoke-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

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
  const relayBaseUrl = await relayServer.start();
  const relayMeta = relayServer.getMeta();

  assert.ok(relayBaseUrl);
  assert.ok(relayMeta?.browserRelay?.enabled);

  const [
    { createSession, heartbeatDevice, getSessionSnapshot },
    { createBrowserTools },
    { createWebFetchTool },
    { createWebSearchTool },
  ] = await Promise.all([
    import("../src/repositories/sessionRepository.ts"),
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
    unavailableError: unavailableError.message,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
