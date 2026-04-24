import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pinchTabBrowserBackend } from "../../src/context/tools/pinchTabBrowserBackend";

async function main() {
  const session = {
    sessionId: "pinchtab-integration",
    backend: "pinchtab" as const,
    preferredBackend: "pinchtab" as const,
    tabId: null,
    relayBaseUrl: null,
  };

  const snapshot = await pinchTabBrowserBackend.snapshot(session);
  assert.equal(snapshot.backend, "pinchtab");
  assert.ok(typeof snapshot.url === "string");
  assert.ok(Array.isArray(snapshot.elements));

  const screenshot = await pinchTabBrowserBackend.screenshot(session, undefined, true, undefined);
  assert.equal(screenshot.backend, "pinchtab");
  assert.ok(existsSync(screenshot.path));

  const mediaProbe = await pinchTabBrowserBackend.mediaProbe(session);
  assert.equal(mediaProbe.backend, "pinchtab");

  console.log(JSON.stringify({
    ok: true,
    url: snapshot.url,
    title: snapshot.title,
    screenshotPath: screenshot.path,
    candidateCount: mediaProbe.candidates.length,
  }, null, 2));
}

void main();
