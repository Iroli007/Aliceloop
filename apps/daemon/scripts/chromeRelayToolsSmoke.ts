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
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-chrome-relay-tools-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;
  const relayUserData = mkdtempSync(join(tmpdir(), "aliceloop-relay-user-"));

  const pageServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/form") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<html><head><title>Relay Form</title></head><body><h1>Relay Form</h1><form action="/done" method="GET"><label>Name <input name="name" /></label><button type="submit">Submit</button></form></body></html>`);
      return;
    }

    if (url.pathname === "/done") {
      const name = url.searchParams.get("name") ?? "Unknown";
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<html><head><title>Relay Done</title></head><body><h1>Done</h1><p id="result">Hello ${name}</p></body></html>`);
      return;
    }

    if (url.pathname === "/long") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<html><head><title>Relay Long</title></head><body><h1>Relay Long</h1><div style="height: 2600px; background: linear-gradient(#fff, #ddd)">Scroll target</div></body></html>`);
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

  const [{ ChromeRelayService, createDefaultChromeRelayServiceOptions }, { ChromeRelayHttpServer }] = await Promise.all([
    import("../../desktop/src/main/chromeRelayService.ts"),
    import("../../desktop/src/main/chromeRelayHttpServer.ts"),
  ]);

  const relayService = new ChromeRelayService(createDefaultChromeRelayServiceOptions(relayUserData));
  const relayServer = new ChromeRelayHttpServer(relayService);
  await relayServer.start();
  const relayMeta = relayServer.getMeta();
  assert.ok(relayMeta?.browserRelay?.enabled);

  const [
    { createSession, heartbeatDevice },
    { createChromeRelayTools },
  ] = await Promise.all([
    import("../src/repositories/sessionRepository.ts"),
    import("../src/context/tools/chromeRelayTool.ts"),
  ]);

  const session = createSession("chrome relay tool smoke");
  heartbeatDevice({
    deviceId: "chrome-relay-tool-smoke",
    deviceType: "desktop",
    label: "Aliceloop Desktop Relay Tool Smoke",
    sessionId: session.id,
    capabilities: relayMeta,
  });

  const relayTools = createChromeRelayTools(session.id);
  const statusPayload = JSON.parse(await relayTools.chrome_relay_status.execute({}));
  assert.equal(statusPayload.ok, true, "chrome_relay_status should report relay health");

  const initialTabsPayload = JSON.parse(await relayTools.chrome_relay_list_tabs.execute({}));
  assert.deepEqual(initialTabsPayload.tabs, [], "fresh relay smoke should start with no attached tabs");

  const formUrl = `http://127.0.0.1:${address.port}/form`;
  const openPayload = JSON.parse(await relayTools.chrome_relay_open.execute({
    url: formUrl,
    waitUntil: "load",
  }));
  assert.ok(openPayload.tabId, "chrome_relay_open should create a tab");

  const tabsPayload = JSON.parse(await relayTools.chrome_relay_list_tabs.execute({}));
  assert.equal(tabsPayload.tabs.length, 1, "chrome_relay_list_tabs should include the new tab");

  const domPayload = JSON.parse(await relayTools.chrome_relay_read_dom.execute({}));
  const inputRef = domPayload.elements.find((element: { tag: string; ref: string }) => element.tag === "input")?.ref;
  const buttonRef = domPayload.elements.find((element: { tag: string; ref: string }) => element.tag === "button")?.ref;
  assert.ok(inputRef, "chrome_relay_read_dom should expose the form input");
  assert.ok(buttonRef, "chrome_relay_read_dom should expose the form button");

  const typedPayload = JSON.parse(await relayTools.chrome_relay_type.execute({
    ref: inputRef,
    text: "Relay Tools",
  }));
  assert.equal(typedPayload.backend, "desktop_chrome");

  const clickedPayload = JSON.parse(await relayTools.chrome_relay_click.execute({
    ref: buttonRef,
    waitUntil: "load",
  }));
  assert.match(clickedPayload.pageText, /Hello Relay Tools/, "chrome_relay_click should submit the form");

  const readablePayload = JSON.parse(await relayTools.chrome_relay_read.execute({}));
  assert.match(readablePayload.pageText, /Hello Relay Tools/, "chrome_relay_read should return readable page text");

  const evalPayload = JSON.parse(await relayTools.chrome_relay_eval.execute({
    expression: "document.querySelector('#result')?.textContent ?? ''",
  }));
  assert.equal(evalPayload.result, "Hello Relay Tools", "chrome_relay_eval should run page-side JavaScript");

  const backPayload = JSON.parse(await relayTools.chrome_relay_back.execute({ waitUntil: "load" }));
  assert.match(backPayload.pageText, /Relay Form/, "chrome_relay_back should return to the form page");

  const forwardPayload = JSON.parse(await relayTools.chrome_relay_forward.execute({ waitUntil: "load" }));
  assert.match(forwardPayload.pageText, /Hello Relay Tools/, "chrome_relay_forward should return to the done page");

  const navigatePayload = JSON.parse(await relayTools.chrome_relay_navigate.execute({
    url: `http://127.0.0.1:${address.port}/long`,
    waitUntil: "load",
  }));
  assert.match(navigatePayload.title, /Relay Long/, "chrome_relay_navigate should move the current tab");

  const scrollPayload = JSON.parse(await relayTools.chrome_relay_scroll.execute({
    direction: "down",
    amount: 700,
  }));
  assert.equal(scrollPayload.backend, "desktop_chrome", "chrome_relay_scroll should return a fresh snapshot");

  const screenshotPayload = JSON.parse(await relayTools.chrome_relay_screenshot.execute({ fullPage: true }));
  assert.ok(existsSync(screenshotPayload.path), "chrome_relay_screenshot should write an image file");

  const summary = {
    ok: true,
    tabId: openPayload.tabId,
    finalTitle: scrollPayload.title,
    screenshotPath: screenshotPayload.path,
  };

  console.log(JSON.stringify(summary, null, 2));

  pageServer.close();
  void relayServer.stop().catch(() => undefined);
  setTimeout(() => {
    process.exit(0);
  }, 0);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
