import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillDefinition } from "@aliceloop/runtime-core";

interface BrowserSnapshotPayload {
  url: string;
  title: string;
  pageText: string;
  elements: Array<{
    ref: string;
    tag: string;
    value: string;
  }>;
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

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-skill-tools-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const [
    { createPermissionSandboxExecutor },
    { assertResolvableSkillTools, buildToolSet, listRequestedSkillToolNames },
    { BASE_TOOL_NAMES, resetSkillToolCache, resolveSkillTools },
    { loadContext },
    { createSession, createSessionMessage },
    { listActiveSkillDefinitions, listSkillDefinitions },
  ] = await Promise.all([
    import("../src/services/sandboxExecutor.ts"),
    import("../src/context/tools/toolRegistry.ts"),
    import("../src/context/tools/skillToolFactories.ts"),
    import("../src/context/index.ts"),
    import("../src/repositories/sessionRepository.ts"),
    import("../src/context/skills/skillLoader.ts"),
  ]);

  resetSkillToolCache();

  const sandbox = createPermissionSandboxExecutor({
    label: "skill-tools-smoke",
    extraReadRoots: [tempDataDir],
    extraWriteRoots: [tempDataDir],
    extraCwdRoots: [tempDataDir],
  });

  const skillCatalog = listSkillDefinitions();
  const availableCatalogSkills = listActiveSkillDefinitions();
  const plannedCatalogSkills = skillCatalog.filter((skill) => skill.status === "planned");

  assert(availableCatalogSkills.length > 0, "skill catalog should expose at least one available skill");
  assert(availableCatalogSkills.some((skill) => skill.id === "browser"), "browser should now be available");
  assert(availableCatalogSkills.some((skill) => skill.id === "coding-agent"), "coding-agent should remain available");
  assert(availableCatalogSkills.some((skill) => skill.id === "web-fetch"), "web-fetch should remain available");
  assert(availableCatalogSkills.some((skill) => skill.id === "web-search"), "web-search should now be available");
  assert.deepEqual(
    listRequestedSkillToolNames(availableCatalogSkills),
    [
      "browser_click",
      "browser_navigate",
      "browser_screenshot",
      "browser_snapshot",
      "browser_type",
      "coding_agent_run",
      "document_ingest",
      "review_coach",
      "web_fetch",
      "web_search",
    ],
    "requested active skill tool names should stay stable for the current catalog",
  );

  const runtimeScriptSkill: SkillDefinition = {
    id: "runtime-overview",
    label: "runtime-overview",
    description: "Run the runtime overview script",
    status: "available",
    mode: "task",
    sourcePath: "/tmp/runtime-overview/SKILL.md",
    sourceUrl: null,
    allowedTools: ["runtime_script_runtime_overview"],
  };

  const baseAndSkillTools = buildToolSet(sandbox, availableCatalogSkills);
  assert.equal(typeof baseAndSkillTools.grep, "object", "base grep tool should always be present");
  assert.equal(typeof baseAndSkillTools.bash, "object", "base bash tool should always be present");
  assert.equal(typeof baseAndSkillTools.browser_navigate, "object", "browser_navigate should be resolved from skill metadata");
  assert.equal(typeof baseAndSkillTools.browser_snapshot, "object", "browser_snapshot should be resolved from skill metadata");
  assert.equal(typeof baseAndSkillTools.browser_click, "object", "browser_click should be resolved from skill metadata");
  assert.equal(typeof baseAndSkillTools.browser_type, "object", "browser_type should be resolved from skill metadata");
  assert.equal(typeof baseAndSkillTools.browser_screenshot, "object", "browser_screenshot should be resolved from skill metadata");
  assert.equal(typeof baseAndSkillTools.coding_agent_run, "object", "coding agent tool should be resolved from skill metadata");
  assert.equal(typeof baseAndSkillTools.document_ingest, "object", "managed task tool should be resolved from skill metadata");
  assert.equal(typeof baseAndSkillTools.review_coach, "object", "review coach tool should be resolved from skill metadata");
  assert.equal(typeof baseAndSkillTools.web_fetch, "object", "web_fetch tool should be resolved from skill metadata");
  assert.equal(typeof baseAndSkillTools.web_search, "object", "web_search tool should be resolved from skill metadata");
  assert.equal("runtime_script_runtime_overview" in baseAndSkillTools, false, "runtime scripts should not load unless requested");
  for (const skill of availableCatalogSkills) {
    for (const toolName of skill.allowedTools) {
      assert.equal(
        typeof baseAndSkillTools[toolName],
        "object",
        `available skill ${skill.id} should resolve declared tool ${toolName}`,
      );
    }
  }

  const runtimeTools = buildToolSet(sandbox, [runtimeScriptSkill]);
  assert.equal(
    typeof runtimeTools.runtime_script_runtime_overview,
    "object",
    "runtime_script_* tools should resolve by prefix match when explicitly requested",
  );

  let unresolvedToolError: unknown = null;
  try {
    assertResolvableSkillTools([
      {
        id: "broken-skill",
        label: "broken-skill",
        description: "Broken smoke skill",
        status: "available",
        mode: "instructional",
        sourcePath: "/tmp/broken-skill/SKILL.md",
        sourceUrl: null,
        allowedTools: ["missing_tool_adapter"],
      },
    ]);
  } catch (error) {
    unresolvedToolError = error;
  }
  assert(unresolvedToolError instanceof Error, "unknown available tool adapters should fail fast during tool assembly");
  assert(
    unresolvedToolError.message.includes("missing_tool_adapter"),
    "fail-fast error should include the unresolved tool name",
  );

  const directResolved = resolveSkillTools(
    new Set(["browser_navigate", "browser_snapshot", "web_fetch", "web_search", "runtime_script_runtime_overview"]),
  );
  assert.equal(typeof directResolved.browser_navigate, "object", "resolveSkillTools should return requested browser_navigate");
  assert.equal(typeof directResolved.browser_snapshot, "object", "resolveSkillTools should return requested browser_snapshot");
  assert.equal(typeof directResolved.web_fetch, "object", "resolveSkillTools should return requested web_fetch");
  assert.equal(typeof directResolved.web_search, "object", "resolveSkillTools should return requested web_search");
  assert.equal(
    typeof directResolved.runtime_script_runtime_overview,
    "object",
    "resolveSkillTools should return requested runtime script tool",
  );

  const session = createSession("skill tools smoke");
  createSessionMessage({
    sessionId: session.id,
    clientMessageId: "skill-tools-smoke-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "Please inspect a docs URL and help with coding work.",
    attachmentIds: [],
  });

  const controller = new AbortController();
  const context = loadContext(session.id, controller.signal);
  assert.equal(typeof context.tools.read, "object", "loadContext should keep base tools");
  assert.equal(typeof context.tools.browser_navigate, "object", "available browser skill should attach browser_navigate to the live context");
  assert.equal(typeof context.tools.browser_snapshot, "object", "available browser skill should attach browser_snapshot to the live context");
  assert.equal(typeof context.tools.web_fetch, "object", "available web-fetch skill should attach web_fetch to the live context");
  assert.equal(typeof context.tools.web_search, "object", "available web-search skill should attach web_search to the live context");
  assert.equal(
    typeof context.tools.coding_agent_run,
    "object",
    "available coding-agent skill should attach coding_agent_run to the live context",
  );
  assert.equal(
    typeof context.tools.document_ingest,
    "object",
    "available managed-task tools should attach through live context assembly",
  );
  const plannedOnlyTools = new Set<string>();
  for (const skill of plannedCatalogSkills) {
    for (const toolName of skill.allowedTools) {
      if (BASE_TOOL_NAMES.has(toolName)) {
        continue;
      }

      const declaredByAvailableSkill = availableCatalogSkills.some((availableSkill) => {
        return availableSkill.allowedTools.includes(toolName);
      });
      if (!declaredByAvailableSkill) {
        plannedOnlyTools.add(toolName);
      }
    }
  }
  for (const toolName of plannedOnlyTools) {
    assert.equal(
      toolName in context.tools,
      false,
      `planned-only tool ${toolName} should not be injected into the live context`,
    );
  }

  const server = createServer((request, response) => {
    if (request.url === "/article") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end([
        "<html><body>",
        "<nav>site-nav</nav>",
        "<main>",
        "<h1>Skill Tool Smoke</h1>",
        "<p>This page verifies HTML extraction.</p>",
        "</main>",
        "<footer>footer-noise</footer>",
        "</body></html>",
      ].join(""));
      return;
    }

    if (request.url === "/json") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: true, source: "skill-tools-smoke" }));
      return;
    }

    if (request.url?.startsWith("/search?")) {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end([
        "<html><body>",
        '<div class="result"><a class="result__a" href="https://docs.example.com/runtime-core">Runtime Core Docs</a><div class="result__snippet">Official runtime core overview.</div></div>',
        '<div class="result"><a class="result__a" href="https://blog.example.com/runtime-loop">Runtime Loop Notes</a><div class="result__snippet">Secondary commentary about the runtime loop.</div></div>',
        "</body></html>",
      ].join(""));
      return;
    }

    if (request.url === "/browser") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end([
        "<html><head><title>Browser Smoke</title></head><body>",
        "<main>",
        "<h1>Browser Smoke</h1>",
        '<form method="GET" action="/browser/result">',
        '<label>Name <input id="name" name="name" placeholder="Type a value" /></label>',
        '<button type="submit">Submit Browser Smoke</button>',
        "</form>",
        "</main>",
        "</body></html>",
      ].join(""));
      return;
    }

    if (request.url?.startsWith("/browser/result?")) {
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end([
        "<html><head><title>Browser Result</title></head><body>",
        `<h1>Browser Result</h1><p id="result">Hello ${requestUrl.searchParams.get("name") ?? "unknown"}</p>`,
        '<a href="/browser">Back</a>',
        "</body></html>",
      ].join(""));
      return;
    }

    response.statusCode = 404;
    response.end("not-found");
  });

  await listen(server);

  let disposeBrowser: (() => Promise<void>) | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve smoke server address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const webFetchTool = baseAndSkillTools.web_fetch as any;
    const webSearchTool = baseAndSkillTools.web_search as any;
    process.env.ALICELOOP_WEB_SEARCH_ENDPOINT = `${baseUrl}/search`;

    const articleResult = String(
      await webFetchTool.execute({
        url: `${baseUrl}/article`,
        extractMain: true,
        maxLength: 5000,
      }),
    );
    assert(articleResult.includes("# Skill Tool Smoke"), "web_fetch should convert article heading into Markdown");
    assert(articleResult.includes("This page verifies HTML extraction."), "web_fetch should preserve main article text");
    assert.equal(articleResult.includes("site-nav"), false, "web_fetch should strip navigation noise");
    assert.equal(articleResult.includes("footer-noise"), false, "web_fetch should strip footer noise");

    const jsonResult = String(
      await webFetchTool.execute({
        url: `${baseUrl}/json`,
        extractMain: true,
        maxLength: 5000,
      }),
    );
    assert(jsonResult.includes("\"ok\":true"), "web_fetch should return JSON payloads as-is");

    const searchResult = JSON.parse(
      String(
        await webSearchTool.execute({
          query: "runtime core",
          maxResults: 5,
          domains: ["docs.example.com"],
        }),
      ),
    ) as { results: Array<{ title: string; url: string; snippet: string }> };
    assert.equal(searchResult.results.length > 0, true, "web_search should return search results");
    assert.equal(searchResult.results[0]?.title, "Runtime Core Docs", "web_search should parse result titles");
    assert.equal(searchResult.results[0]?.url, "https://docs.example.com/runtime-core", "web_search should parse result URLs");
    assert(searchResult.results[0]?.snippet.includes("Official runtime core overview."), "web_search should parse result snippets");

    const browserNavigateTool = baseAndSkillTools.browser_navigate as any;
    const browserSnapshotTool = baseAndSkillTools.browser_snapshot as any;
    const browserTypeTool = baseAndSkillTools.browser_type as any;
    const browserClickTool = baseAndSkillTools.browser_click as any;
    const browserScreenshotTool = baseAndSkillTools.browser_screenshot as any;
    disposeBrowser = browserNavigateTool.__dispose;

    const browserLanding = JSON.parse(
      String(
        await browserNavigateTool.execute({
          url: `${baseUrl}/browser`,
          waitUntil: "domcontentloaded",
        }),
      ),
    ) as BrowserSnapshotPayload;
    assert.equal(browserLanding.title, "Browser Smoke", "browser_navigate should load the browser smoke page");
    const nameInputRef = browserLanding.elements.find((element) => element.tag === "input")?.ref;
    const submitButtonRef = browserLanding.elements.find((element) => element.tag === "button")?.ref;
    assert(nameInputRef, "browser snapshot should include an input ref");
    assert(submitButtonRef, "browser snapshot should include a submit button ref");

    const browserTyped = JSON.parse(
      String(
        await browserTypeTool.execute({
          ref: nameInputRef,
          text: "Skill Smoke",
        }),
      ),
    ) as BrowserSnapshotPayload;
    assert(
      browserTyped.elements.some((element) => element.ref === nameInputRef && element.value === "Skill Smoke"),
      "browser_type should update the input value",
    );

    const browserResult = JSON.parse(
      String(
        await browserClickTool.execute({
          ref: submitButtonRef,
          waitUntil: "load",
        }),
      ),
    ) as BrowserSnapshotPayload;
    assert(browserResult.url.includes("/browser/result?name=Skill+Smoke"), "browser_click should submit the form");
    assert(browserResult.pageText.includes("Hello Skill Smoke"), "browser_click should return the destination snapshot");

    const browserRefreshed = JSON.parse(
      String(
        await browserSnapshotTool.execute({
          maxTextLength: 500,
          maxElements: 10,
        }),
      ),
    ) as BrowserSnapshotPayload;
    assert.equal(browserRefreshed.title, "Browser Result", "browser_snapshot should read the current page");

    const screenshotPath = join(tempDataDir, "browser-skill-smoke.png");
    const browserScreenshot = JSON.parse(
      String(
        await browserScreenshotTool.execute({
          outputPath: screenshotPath,
        }),
      ),
    ) as { path: string; url: string };
    assert.equal(browserScreenshot.path, screenshotPath, "browser_screenshot should return the saved path");
    assert.equal(existsSync(screenshotPath), true, "browser_screenshot should write the PNG file");
  } finally {
    delete process.env.ALICELOOP_WEB_SEARCH_ENDPOINT;
    await disposeBrowser?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        tempDataDir,
        contextToolNames: Object.keys(context.tools).sort(),
        toolNames: Object.keys(baseAndSkillTools).sort(),
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
