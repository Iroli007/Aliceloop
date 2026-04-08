import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    { buildToolSet },
    { BASE_TOOL_NAMES, resetSkillToolCache, resolveSkillTools },
    { loadContext },
    { appendSessionEvent, createAttachment, createSession, createSessionMessage },
    { buildSessionContextFragments },
    { createViewImageTool },
    {
      buildSkillContextBlock,
      getSkillDefinition,
      listActiveSkillDefinitions,
      listSkillDefinitions,
      resetSkillCatalogCache,
      selectRelevantSkillDefinitions,
    },
    { routeToolNamesForTurn },
  ] = await Promise.all([
    import("../src/services/sandboxExecutor.ts"),
    import("../src/context/tools/toolRegistry.ts"),
    import("../src/context/tools/skillToolFactories.ts"),
    import("../src/context/index.ts"),
    import("../src/repositories/sessionRepository.ts"),
    import("../src/context/session/sessionContext.ts"),
    import("../src/context/tools/viewImageTool.ts"),
    import("../src/context/skills/skillLoader.ts"),
    import("../src/context/tools/toolRouter.ts"),
  ]);

  resetSkillToolCache();
  resetSkillCatalogCache();

  const sandbox = createPermissionSandboxExecutor({
    label: "skill-tools-smoke",
    extraReadRoots: [tempDataDir],
    extraWriteRoots: [tempDataDir],
    extraCwdRoots: [tempDataDir],
  });

  let skillCatalog = listSkillDefinitions();
  let availableCatalogSkills = listActiveSkillDefinitions();
  let plannedCatalogSkills = skillCatalog.filter((skill) => skill.status === "planned");
  assert.equal(
    listSkillDefinitions(),
    skillCatalog,
    "skill catalog should reuse cached parsed definitions when the skill fingerprints are unchanged",
  );
  assert.equal(
    listActiveSkillDefinitions(),
    availableCatalogSkills,
    "active skill catalog should reuse the cached available-skill slice when fingerprints are unchanged",
  );
  const skillHubDefinition = getSkillDefinition("skill-hub");
  assert(skillHubDefinition, "skill-hub should resolve from the cached skill catalog");
  assert.equal(
    skillHubDefinition,
    skillCatalog.find((skill) => skill.id === "skill-hub") ?? null,
    "getSkillDefinition should resolve by id from the cached catalog",
  );
  const originalSkillHubStats = statSync(skillHubDefinition.sourcePath);
  const touchedSkillHubTime = new Date(originalSkillHubStats.mtimeMs + 60_000);
  utimesSync(skillHubDefinition.sourcePath, touchedSkillHubTime, touchedSkillHubTime);
  const invalidatedSkillCatalog = listSkillDefinitions();
  assert.notEqual(
    invalidatedSkillCatalog,
    skillCatalog,
    "skill catalog should invalidate when a SKILL.md timestamp changes",
  );
  utimesSync(skillHubDefinition.sourcePath, originalSkillHubStats.atime, originalSkillHubStats.mtime);
  resetSkillCatalogCache();
  skillCatalog = listSkillDefinitions();
  availableCatalogSkills = listActiveSkillDefinitions();
  plannedCatalogSkills = skillCatalog.filter((skill) => skill.status === "planned");

  for (const skill of skillCatalog) {
    const source = readFileSync(skill.sourcePath, "utf8");
    const lines = source.split(/\r?\n/);
    assert.equal(lines[0]?.trim(), "---", `${skill.id} should start with YAML frontmatter`);

    const seenKeys = new Set<string>();
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "---") {
        break;
      }

      const keyValueMatch = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
      if (!keyValueMatch) {
        continue;
      }

      const key = keyValueMatch[1];
      assert.equal(
        seenKeys.has(key),
        false,
        `${skill.id} should not repeat frontmatter key ${key}`,
      );
      seenKeys.add(key);
    }
  }

  assert(availableCatalogSkills.length > 0, "skill catalog should expose at least one available skill");
  assert(skillCatalog.some((skill) => skill.id === "skill-hub"), "skill-hub should be present in the catalog");
  assert(skillCatalog.some((skill) => skill.id === "skill-search"), "skill-search should be present in the catalog");
  assert(skillCatalog.some((skill) => skill.id === "task-delegation"), "task-delegation should be present in the catalog");
  assert(skillCatalog.some((skill) => skill.id === "music-listener"), "music-listener should be present in the catalog");
  assert(skillCatalog.some((skill) => skill.id === "video-reader"), "video-reader should be present in the catalog");
  assert(skillCatalog.some((skill) => skill.id === "twitter-media"), "twitter-media should be present in the catalog");
  assert(skillCatalog.some((skill) => skill.id === "xiaohongshu"), "xiaohongshu should be present in the catalog");
  assert(skillCatalog.some((skill) => skill.id === "selfie"), "selfie should be present in the catalog");
  assert(skillCatalog.every((skill) => skill.id !== "travel"), "travel should no longer be present in the catalog");
  assert(availableCatalogSkills.some((skill) => skill.id === "skill-hub"), "skill-hub should be active");
  assert(availableCatalogSkills.some((skill) => skill.id === "skill-search"), "skill-search should be active");
  assert(availableCatalogSkills.some((skill) => skill.id === "task-delegation"), "task-delegation should be active");
  assert(availableCatalogSkills.some((skill) => skill.id === "twitter-media"), "twitter-media should be active");
  assert(availableCatalogSkills.some((skill) => skill.id === "xiaohongshu"), "xiaohongshu should be active");
  assert(availableCatalogSkills.some((skill) => skill.id === "music-listener"), "music-listener should be active");
  assert(availableCatalogSkills.some((skill) => skill.id === "video-reader"), "video-reader should be active");
  assert(plannedCatalogSkills.some((skill) => skill.id === "selfie"), "selfie should remain planned until image references are supported");
  assert(availableCatalogSkills.some((skill) => skill.id === "web-fetch"), "web-fetch should remain available");
  assert(availableCatalogSkills.some((skill) => skill.id === "web-search"), "web-search should now be available");
  const ruleOnlyRouting = selectRelevantSkillDefinitions("继续");
  assert(
    ruleOnlyRouting.some((skill) => skill.id === "continue"),
    "rule-only continuation turns should still route the continue skill",
  );
  const smallTalkRouting = selectRelevantSkillDefinitions("你就是a姐");
  assert.equal(
    smallTalkRouting.length,
    0,
    "plain chat should not pull in unrelated skills",
  );
  const researchRuleRouting = selectRelevantSkillDefinitions("帮我调查张雪峰");
  assert(
    researchRuleRouting.some((skill) => skill.id === "web-search"),
    "high-confidence research turns should still route web-search",
  );
  const historyRouting = selectRelevantSkillDefinitions("我昨天晚上跟你说啥呢来着");
  assert(
    historyRouting.some((skill) => skill.id === "memory-management"),
    "episodic history recall should route memory-management",
  );
  const todayHistoryRouting = selectRelevantSkillDefinitions("今天我们做了什么呀");
  assert(
    todayHistoryRouting.some((skill) => skill.id === "memory-management"),
    "same-day recall should route memory-management instead of dropping into research",
  );
  assert.equal(
    todayHistoryRouting.some((skill) => skill.id === "web-search"),
    false,
    "same-day recall should not misroute to web-search just because the query contains 今天",
  );
  const threadAdminRouting = selectRelevantSkillDefinitions("帮我列一下最近的线程列表");
  assert(
    threadAdminRouting.some((skill) => skill.id === "thread-management"),
    "explicit thread administration should still route thread-management",
  );
  assert.equal(
    threadAdminRouting.every((skill) => skill.id === "thread-management"),
    true,
    "explicit thread administration should stay focused on thread-management",
  );
  const technicalThreadSkills = selectRelevantSkillDefinitions("Node worker thread 为什么卡住了");
  assert.equal(
    technicalThreadSkills.some((skill) => skill.id === "memory-management" || skill.id === "thread-management"),
    false,
    "plain technical thread questions should not misroute into recall or thread administration skills",
  );
  const memoryRouting = selectRelevantSkillDefinitions("记住我以后喜欢简洁回答");
  assert(
    memoryRouting.some((skill) => skill.id === "memory-management"),
    "profile/fact memory writes should route memory-management",
  );
  const selfRouting = selectRelevantSkillDefinitions("把 reasoning 改成 high");
  assert.equal(
    selfRouting.every((skill) => skill.id === "self-management"),
    true,
    "runtime setting edits should stay focused on self-management",
  );
  const fileRouting = selectRelevantSkillDefinitions("帮我找一下 Downloads 里最近 7 天的 PDF");
  assert.equal(
    fileRouting.every((skill) => skill.id === "file-manager"),
    true,
    "local file search should stay focused on file-manager",
  );
  assert.deepEqual(
    routeToolNamesForTurn("帮我查一下东莞今天天气，给我最新结果。"),
    ["web_search"],
    "tool router should attach research tools from query intent rather than from skill metadata",
  );
  assert.deepEqual(
    routeToolNamesForTurn("今天我们做了什么呀"),
    [],
    "same-day recall should not attach web_search purely because the query contains 今天",
  );
  assert(
    routeToolNamesForTurn("帮我调查峰哥亡命天涯这个人").includes("web_search"),
    "tool router should route explicit research queries to web_search",
  );
  assert.deepEqual(
    routeToolNamesForTurn("fetch"),
    ["web_fetch"],
    "tool router should treat a bare fetch command as an explicit web_fetch request",
  );
  assert.deepEqual(
    routeToolNamesForTurn("search"),
    ["web_search"],
    "tool router should treat a bare search command as an explicit web_search request",
  );
  assert.deepEqual(
    routeToolNamesForTurn("帮我看看这张图里写了什么"),
    ["view_image"],
    "tool router should attach the image understanding tool from visual-inspection intent",
  );
  assert(
    routeToolNamesForTurn("打开浏览器访问这个页面，点击按钮并截图。").includes("browser_snapshot"),
    "tool router should attach browser tools from browser intent",
  );
  const baseAndSkillTools = buildToolSet(sandbox, []);
  assert.equal("time_now" in baseAndSkillTools, false, "time_now should not be part of the always-on base toolset");
  assert.equal("weather_now" in baseAndSkillTools, false, "weather_now should not be part of the always-on base toolset");
  assert.equal("grep" in baseAndSkillTools, false, "base grep tool should not be injected when no skill or tool route requests it");
  assert.equal("bash" in baseAndSkillTools, false, "base bash tool should not be injected when no skill or tool route requests it");
  assert.equal("browser_navigate" in baseAndSkillTools, false, "browser tools should not be injected into the default toolset");
  assert.equal("document_ingest" in baseAndSkillTools, false, "document_ingest should not be injected into the default toolset");
  assert.equal("review_coach" in baseAndSkillTools, false, "review_coach should not be injected into the default toolset");
  assert.equal("web_fetch" in baseAndSkillTools, false, "web_fetch should not be injected into the default toolset");
  assert.equal("web_search" in baseAndSkillTools, false, "web_search should not be injected into the default toolset");
  assert.equal("view_image" in baseAndSkillTools, false, "view_image should not be injected into the default toolset");
  assert.equal("use_skill" in baseAndSkillTools, true, "use_skill should always be available as the skill entry point");

  const bareFetchSession = createSession("bare fetch smoke");
  createSessionMessage({
    sessionId: bareFetchSession.id,
    clientMessageId: "bare-fetch-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "fetch",
    attachmentIds: [],
  });
  const bareFetchController = new AbortController();
  const bareFetchContext = await loadContext(bareFetchSession.id, bareFetchController.signal);
  assert.equal(
    typeof bareFetchContext.tools.web_fetch,
    "object",
    "bare fetch commands should attach the web_fetch tool",
  );
  assert.deepEqual(
    bareFetchContext.firstStepToolChoice,
    { type: "tool", toolName: "web_fetch" },
    "bare fetch commands should bias the first step toward web_fetch",
  );

  const directResolved = resolveSkillTools(
    new Set([
      "browser_find",
      "browser_navigate",
      "browser_snapshot",
      "browser_wait",
      "browser_media_probe",
      "browser_scroll",
      "browser_video_watch_start",
      "browser_video_watch_poll",
      "browser_video_watch_stop",
      "web_fetch",
      "web_search",
      "view_image",
      "task_delegation",
      "task_output",
    ]),
  );
  assert.equal(typeof directResolved.browser_find, "object", "resolveSkillTools should return requested browser_find");
  assert.equal(typeof directResolved.browser_navigate, "object", "resolveSkillTools should return requested browser_navigate");
  assert.equal(typeof directResolved.browser_snapshot, "object", "resolveSkillTools should return requested browser_snapshot");
  assert.equal(typeof directResolved.browser_wait, "object", "resolveSkillTools should return requested browser_wait");
  assert.equal(typeof directResolved.browser_media_probe, "object", "resolveSkillTools should return requested browser_media_probe");
  assert.equal(typeof directResolved.browser_scroll, "object", "resolveSkillTools should return requested browser_scroll");
  assert.equal(typeof directResolved.browser_video_watch_start, "object", "resolveSkillTools should return requested browser_video_watch_start");
  assert.equal(typeof directResolved.browser_video_watch_poll, "object", "resolveSkillTools should return requested browser_video_watch_poll");
  assert.equal(typeof directResolved.browser_video_watch_stop, "object", "resolveSkillTools should return requested browser_video_watch_stop");
  assert.equal(typeof directResolved.web_fetch, "object", "resolveSkillTools should return requested web_fetch");
  assert.equal(typeof directResolved.web_search, "object", "resolveSkillTools should return requested web_search");
  assert.equal(typeof directResolved.view_image, "object", "resolveSkillTools should return requested view_image");
  assert.equal(typeof directResolved.task_delegation, "object", "resolveSkillTools should return requested task_delegation");
  assert.equal(typeof directResolved.task_output, "object", "resolveSkillTools should return requested task_output");

  const session = createSession("skill tools smoke");
  createSessionMessage({
    sessionId: session.id,
    clientMessageId: "skill-tools-smoke-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "普通闲聊，随便打个招呼就行。",
    attachmentIds: [],
  });

  const sessionContextFragments = buildSessionContextFragments(session.id);
  assert.equal(
    sessionContextFragments.timings.snapshotReads,
    1,
    "session context aggregation should read the session snapshot exactly once per build",
  );
  assert.equal(
    sessionContextFragments.latestUserQuery,
    "普通闲聊，随便打个招呼就行。",
    "session context aggregation should preserve the latest user query",
  );
  assert.equal(
    sessionContextFragments.messages.length,
    1,
    "session context aggregation should preserve the current message window",
  );
  assert.equal(
    sessionContextFragments.projectBinding?.sessionId,
    session.id,
    "session context aggregation should expose the current project binding from the same snapshot",
  );
  assert.equal(
    sessionContextFragments.attachmentRoots.defaultCwd,
    sessionContextFragments.projectBinding?.projectPath ?? null,
    "session context aggregation should derive attachment sandbox roots from the same snapshot",
  );

  const controller = new AbortController();
  const context = await loadContext(session.id, controller.signal);
  const contextSystemPrompt = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.map((message) => message.content).join("\n\n")
    : context.systemPrompt;
  assert.equal(context.timings.sessionContextAggregated, 1, "loadContext should use the aggregated session context path");
  assert.equal(context.timings.sessionSnapshotReads, 1, "loadContext should only read one session snapshot per turn");
  assert.equal(context.timings.projectBindingAggregated, 1, "loadContext should reuse the project binding from the aggregated session context");
  assert.equal(context.timings.attachmentRootsAggregated, 1, "loadContext should reuse attachment roots from the aggregated session context");
  assert.equal("time_now" in context.tools, false, "generic turns should not inject time_now");
  assert.equal("weather_now" in context.tools, false, "generic turns should not inject weather_now");
  assert.equal("read" in context.tools, false, "generic turns should not inject base tools when nothing requests them");
  assert.equal("browser_navigate" in context.tools, false, "generic turns should not inject browser tools");
  assert.equal("web_fetch" in context.tools, false, "generic turns should not inject web tools");
  assert.equal("web_search" in context.tools, false, "generic turns should not inject web tools");
  assert.equal("view_image" in context.tools, false, "generic turns should not inject image tools");
  assert.equal("document_ingest" in context.tools, false, "generic turns should not inject document_ingest");
  assert.equal("use_skill" in context.tools, true, "live context should always expose use_skill as the skill entry point");
  assert.equal(context.firstStepToolChoice, undefined, "generic turns should not force an initial tool");
  assert.match(
    contextSystemPrompt,
    /Select skills from metadata only when they materially help the task\./i,
    "system prompt should encode the architecture rule that skills are selected instruction blocks rather than workflow routers",
  );
  assert.match(
    contextSystemPrompt,
    /No extra local skill was selected for this turn\./i,
    "system prompt should clarify when no selected skill guidance is attached for the current turn",
  );
  assert.match(
    contextSystemPrompt,
    /call `use_skill` with its exact skill id before continuing/i,
    "system prompt should instruct the model to call use_skill instead of emitting raw skill tags",
  );

  const forcedThreadContext = await loadContext(session.id, controller.signal, {
    additionalSelectedSkillIds: ["thread-management"],
  });
  assert(
    forcedThreadContext.routedSkillIds.includes("thread-management"),
    "forced selected skills should be attached to the next context pass",
  );
  for (const allowedTool of getSkillDefinition("thread-management")?.allowedTools ?? []) {
    assert(
      allowedTool in forcedThreadContext.tools,
      `forced selected thread-management should attach allowed tool ${allowedTool}`,
    );
  }

  const imageSession = createSession("image attachment smoke");
  const imagePath = join(tempDataDir, "view-image-smoke.png");
  writeFileSync(
    imagePath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAGgwJ/l4r0WQAAAABJRU5ErkJggg==", "base64"),
  );
  const imageAttachment = createAttachment({
    sessionId: imageSession.id,
    fileName: "view-image-smoke.png",
    mimeType: "image/png",
    byteSize: statSync(imagePath).size,
    storagePath: imagePath,
    originalPath: imagePath,
  }).attachment;
  createSessionMessage({
    sessionId: imageSession.id,
    clientMessageId: "skill-tools-smoke-user-image-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "这四个字是？",
    attachmentIds: [imageAttachment.id],
  });

  const imageToolResult = await (createViewImageTool(imageSession.id).view_image as unknown as {
    execute: (input: { imagePath: string; prompt?: string }) => Promise<string>;
  }).execute({
    imagePath,
    prompt: "识别这张图是否是有效图片，并简单说明能否读取。",
  });
  const parsedImageToolResult = JSON.parse(imageToolResult) as {
    imagePath?: string;
    prompt?: string;
    summary?: string | null;
    observations?: unknown[];
    limitations?: unknown[];
  };
  assert.equal(
    parsedImageToolResult.imagePath,
    imagePath,
    "view_image tool should return the resolved image path",
  );
  assert.equal(
    parsedImageToolResult.prompt,
    "识别这张图是否是有效图片，并简单说明能否读取。",
    "view_image tool should echo the supplied prompt",
  );
  assert.equal(
    Array.isArray(parsedImageToolResult.limitations),
    true,
    "view_image tool should return a limitations array",
  );

  const imageSessionContextFragments = buildSessionContextFragments(imageSession.id);
  assert.equal(
    imageSessionContextFragments.recentConversationFocus.latestUserHasImageAttachment,
    true,
    "session context aggregation should detect binary image attachments on the latest user message",
  );

  const imageContext = await loadContext(imageSession.id, controller.signal);
  assert.equal(
    "view_image" in imageContext.tools,
    true,
    "image attachment turns should surface the view_image tool in the live context",
  );
  assert.equal(
    imageContext.firstStepToolChoice?.toolName,
    "view_image",
    "image attachment turns should prefer view_image as the initial tool",
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

  const researchToolSet = buildToolSet(
    sandbox,
    selectRelevantSkillDefinitions("帮我查一下东莞今天天气，给我最新结果。"),
    {
      query: "帮我查一下东莞今天天气，给我最新结果。",
    },
  );
  assert.equal(typeof researchToolSet.web_search, "object", "research turns should inject web_search");
  assert.equal("bash" in researchToolSet, true, "research turns should inject bash when the routed web-search skill explicitly asks for it");
  assert.equal("web_fetch" in researchToolSet, true, "research turns should inject web_fetch when the routed web-search skill declares it");
  assert.equal("browser_navigate" in researchToolSet, false, "research turns should not inject browser tools by default");

  const imageToolSet = buildToolSet(
    sandbox,
    [],
    {
      hasImageAttachment: true,
    },
  );
  assert.equal(typeof imageToolSet.view_image, "object", "image attachment turns should inject view_image");
  assert.equal("web_search" in imageToolSet, false, "image attachment turns should not inject unrelated research tools");

  const browserToolSet = buildToolSet(
    sandbox,
    selectRelevantSkillDefinitions("打开浏览器访问这个页面，点击按钮并截图。"),
    {
      query: "打开浏览器访问这个页面，点击按钮并截图。",
    },
  );
  assert.equal(typeof browserToolSet.browser_navigate, "object", "browser turns should inject browser_navigate");
  assert.equal(typeof browserToolSet.browser_snapshot, "object", "browser turns should inject browser_snapshot");
  assert.equal(typeof browserToolSet.view_image, "object", "browser turns should inject view_image for screenshot inspection");
  assert.equal(typeof browserToolSet.browser_find, "object", "browser turns should inject browser_find");
  assert.equal(typeof browserToolSet.browser_wait, "object", "browser turns should inject browser_wait");
  assert.equal(typeof browserToolSet.browser_click, "object", "browser turns should inject browser_click");
  assert.equal(typeof browserToolSet.browser_type, "object", "browser turns should inject browser_type");
  assert.equal(typeof browserToolSet.browser_scroll, "object", "browser turns should inject browser_scroll");
  assert.equal(typeof browserToolSet.browser_screenshot, "object", "browser turns should inject browser_screenshot");
  assert.equal(typeof browserToolSet.browser_media_probe, "object", "browser turns should inject browser_media_probe");
  assert.equal(typeof browserToolSet.browser_video_watch_start, "object", "browser turns should inject browser_video_watch_start");
  assert.equal(typeof browserToolSet.browser_video_watch_poll, "object", "browser turns should inject browser_video_watch_poll");
  assert.equal(typeof browserToolSet.browser_video_watch_stop, "object", "browser turns should inject browser_video_watch_stop");

  const researchSkills = selectRelevantSkillDefinitions("帮我查一下东莞今天天气，给我最新结果。");
  assert.deepEqual(
    researchSkills.map((skill) => skill.id).sort(),
    ["web-search"],
    "fact verification turns should route to web-search first",
  );
  const researchSkillBlock = buildSkillContextBlock(researchSkills);
  assert.match(
    researchSkillBlock,
    /Selected skills for this turn:/,
    "skill block should list the selected skills instead of the entire catalog",
  );
  assert.match(
    researchSkillBlock,
    /web-search:/i,
    "research skill block should surface the web-search skill",
  );
  assert.equal(
    researchSkillBlock.includes("browser:"),
    false,
    "research skill block should not include unrelated skills",
  );
  assert.match(
    researchSkillBlock,
    /web_search as the default first step/i,
    "research skill block should describe the search-first priority for fact verification turns",
  );
  assert.match(
    researchSkillBlock,
    /Research memory rule: keep a running evidence ledger/i,
    "research skill block should explain that search results are an evidence ledger, not a final answer",
  );
  const capabilityDiscoverySkills = selectRelevantSkillDefinitions("我有哪些 skills？为什么没有 browser_click，Browser Relay 开关还开着吗？");
  assert.equal(
    capabilityDiscoverySkills.some((skill) => skill.id === "skill-hub"),
    true,
    "browser capability diagnostics should route skill catalog discovery",
  );
  assert.equal(
    capabilityDiscoverySkills.some((skill) => skill.id === "skill-search"),
    true,
    "browser capability diagnostics should route local skill search",
  );
  const fileCapabilitySkills = selectRelevantSkillDefinitions("怎么测试你的文件管理能力？");
  assert.equal(
    fileCapabilitySkills.some((skill) => skill.id === "file-manager"),
    true,
    "file capability questions should keep the concrete file-manager skill in the selected set",
  );
  assert.equal(
    fileCapabilitySkills.some((skill) => skill.id === "skill-hub"),
    true,
    "file capability questions should still include discovery support through skill-hub",
  );
  assert.equal(
    fileCapabilitySkills.some((skill) => skill.id === "skill-search"),
    true,
    "file capability questions should still include discovery support through skill-search",
  );
  const genericCapabilitySkills = selectRelevantSkillDefinitions("你有哪些能力？");
  assert.equal(
    genericCapabilitySkills.some((skill) => skill.id === "skill-hub"),
    true,
    "generic capability questions should still surface skill-hub",
  );
  assert.equal(
    genericCapabilitySkills.some((skill) => skill.id === "skill-search"),
    true,
    "generic capability questions should still surface skill-search",
  );

  const socialFeedToolSet = buildToolSet(
    sandbox,
    selectRelevantSkillDefinitions("去刷推特和抖音，看看主页、视频和帖子。"),
    {
      query: "去刷推特和抖音，看看主页、视频和帖子。",
    },
  );
  assert.equal(typeof socialFeedToolSet.browser_navigate, "object", "social feed turns should inject browser_navigate");
  assert.equal(typeof socialFeedToolSet.browser_snapshot, "object", "social feed turns should inject browser_snapshot");
  assert.equal(typeof socialFeedToolSet.view_image, "object", "social feed turns should inject view_image for screenshot inspection");
  assert.equal(typeof socialFeedToolSet.browser_find, "object", "social feed turns should inject browser_find");
  assert.equal(typeof socialFeedToolSet.browser_wait, "object", "social feed turns should inject browser_wait");
  assert.equal(typeof socialFeedToolSet.browser_click, "object", "social feed turns should inject browser_click");
  assert.equal(typeof socialFeedToolSet.browser_type, "object", "social feed turns should inject browser_type");
  assert.equal(typeof socialFeedToolSet.browser_scroll, "object", "social feed turns should inject browser_scroll");
  assert.equal(typeof socialFeedToolSet.browser_screenshot, "object", "social feed turns should inject browser_screenshot");
  assert.equal(typeof socialFeedToolSet.browser_media_probe, "object", "social feed turns should inject browser_media_probe");
  assert.equal(typeof socialFeedToolSet.browser_video_watch_start, "object", "social feed turns should inject browser_video_watch_start");
  assert.equal(typeof socialFeedToolSet.browser_video_watch_poll, "object", "social feed turns should inject browser_video_watch_poll");
  assert.equal(typeof socialFeedToolSet.browser_video_watch_stop, "object", "social feed turns should inject browser_video_watch_stop");

  const memorySkillTools = buildToolSet(
    sandbox,
    selectRelevantSkillDefinitions("记住我以后喜欢简洁回答"),
    {
      query: "记住我以后喜欢简洁回答",
    },
  );
  assert.equal(typeof memorySkillTools.bash, "object", "memory turns should continue using bash for CLI-driven memory access");
  assert.equal(typeof memorySkillTools.read, "object", "memory turns should include read when the routed skill declares it");
  assert.equal(typeof memorySkillTools.write, "object", "memory turns should include write when the routed skill declares it");
  assert.equal("memory_search" in memorySkillTools, false, "memory turns should not inject bespoke memory tools");
  const memorySession = createSession("memory bash first-step smoke");
  createSessionMessage({
    sessionId: memorySession.id,
    clientMessageId: "memory-bash-first-step-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "记住我以后喜欢简洁回答",
    attachmentIds: [],
  });
  const memoryContext = await loadContext(memorySession.id, new AbortController().signal);
  assert.deepEqual(
    memoryContext.firstStepToolChoice,
    { type: "tool", toolName: "bash" },
    "memory turns should bias the first step toward bash when the routed skill is CLI-driven",
  );

  const historySkillTools = buildToolSet(
    sandbox,
    selectRelevantSkillDefinitions("我昨天晚上跟你说啥呢来着"),
    {
      query: "我昨天晚上跟你说啥呢来着",
    },
  );
  assert.equal(typeof historySkillTools.bash, "object", "history recall turns should continue using bash for CLI-driven memory access");
  assert.equal(typeof historySkillTools.read, "object", "history recall turns should include read when the routed skill declares it");
  assert.equal(typeof historySkillTools.write, "object", "history recall turns should include write when the routed skill declares it");
  assert.equal("memory_search" in historySkillTools, false, "history recall turns should not inject bespoke memory tools");
  const historySession = createSession("history bash first-step smoke");
  createSessionMessage({
    sessionId: historySession.id,
    clientMessageId: "history-bash-first-step-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "我昨天晚上跟你说啥呢来着",
    attachmentIds: [],
  });
  const historyContext = await loadContext(historySession.id, new AbortController().signal);
  assert.deepEqual(
    historyContext.firstStepToolChoice,
    { type: "tool", toolName: "bash" },
    "episodic history turns should bias the first step toward bash when the routed memory skill is CLI-driven",
  );

  const videoWatchSkills = selectRelevantSkillDefinitions("继续看这个视频后面讲了什么，顺便听听他说了什么。");
  assert.equal(videoWatchSkills.some((skill) => skill.id === "browser"), true, "web playback follow-ups should route browser");
  assert.equal(videoWatchSkills.some((skill) => skill.id === "video-reader"), false, "web playback follow-ups should no longer route file-based video-reader");
  assert.equal(videoWatchSkills.some((skill) => skill.id === "music-listener"), false, "web playback follow-ups should no longer route file-based music-listener");

  const creatorMetricSkills = selectRelevantSkillDefinitions("病院坂saki现在多少粉丝来着");
  assert.deepEqual(
    creatorMetricSkills.map((skill) => skill.id).sort(),
    ["web-search"],
    "creator metric questions should route to web-search first",
  );

  const continuationSession = createSession("continuation focus smoke");
  createSessionMessage({
    sessionId: continuationSession.id,
    clientMessageId: "continuation-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "帮我调查摩的司机徐师傅，站粉丝数量搞错了。",
    attachmentIds: [],
  });
  createSessionMessage({
    sessionId: continuationSession.id,
    clientMessageId: "continuation-user-2",
    deviceId: "desktop-smoke",
    role: "user",
    content: "B站内容才是准的，查一下3月22日的情况。",
    attachmentIds: [],
  });
  createSessionMessage({
    sessionId: continuationSession.id,
    clientMessageId: "continuation-assistant-1",
    deviceId: "desktop-smoke",
    role: "assistant",
    content: "我先按 B 站和时间点继续查。",
    attachmentIds: [],
  });
  createSessionMessage({
    sessionId: continuationSession.id,
    clientMessageId: "continuation-user-3",
    deviceId: "desktop-smoke",
    role: "user",
    content: "你查",
    attachmentIds: [],
  });
  const continuationSearchOutput = JSON.stringify({
    query: "摩的司机徐师傅 B站 3月22日",
    effectiveQuery: "摩的司机徐师傅 B站 3月22日",
    sources: [
      {
        citationIndex: 1,
        title: "摩的司机徐师傅的个人空间-哔哩哔哩",
        url: "https://space.bilibili.com/3493117728656046",
        domain: "bilibili.com",
        sourceType: "platform",
      },
      {
        citationIndex: 2,
        title: "摩的司机徐师傅的抖音主页",
        url: "https://www.douyin.com/user/testdouyin",
        domain: "douyin.com",
        sourceType: "platform",
      },
      {
        citationIndex: 3,
        title: "摩的司机徐师傅 / X",
        url: "https://x.com/testcreator",
        domain: "x.com",
        sourceType: "platform",
      },
    ],
  }, null, 2);
  appendSessionEvent(continuationSession.id, "tool.call.started", {
    toolCallId: "continuation-search-1",
    toolName: "web_search",
    inputPreview: "{\"query\":\"摩的司机徐师傅 B站 3月22日\"}",
    backend: "desktop_chrome",
  });
  appendSessionEvent(continuationSession.id, "tool.state.change", {
    toolCallId: "continuation-search-1",
    toolName: "web_search",
    status: "done",
    input: {
      query: "摩的司机徐师傅 B站 3月22日",
      max_results: 10,
    },
    output: continuationSearchOutput,
  });
  appendSessionEvent(continuationSession.id, "tool.call.completed", {
    toolCallId: "continuation-search-1",
    toolName: "web_search",
    success: true,
    resultPreview: "{\"results\":[{\"url\":\"https://space.bilibili.com/3493117728656046\"}]}",
    durationMs: 122,
    backend: "desktop_chrome",
  });
  const continuationFetchOutput = [
    "Source URL: https://space.bilibili.com/3493117728656046",
    "Source Domain: space.bilibili.com",
    "Retrieved At: 2026-03-24T00:00:00.000Z",
    "Fetch Backend: desktop_chrome",
    "Page Title: 摩的司机徐师傅的个人空间-哔哩哔哩",
    "",
    "---",
    "",
    "# 摩的司机徐师傅",
    "粉丝 112.5 万",
    "视频 42",
  ].join("\n");
  appendSessionEvent(continuationSession.id, "tool.call.started", {
    toolCallId: "continuation-fetch-1",
    toolName: "web_fetch",
    inputPreview: "{\"url\":\"https://space.bilibili.com/3493117728656046\"}",
    backend: "desktop_chrome",
  });
  appendSessionEvent(continuationSession.id, "tool.state.change", {
    toolCallId: "continuation-fetch-1",
    toolName: "web_fetch",
    status: "done",
    input: {
      url: "https://space.bilibili.com/3493117728656046",
    },
    output: continuationFetchOutput,
  });
  appendSessionEvent(continuationSession.id, "tool.call.completed", {
    toolCallId: "continuation-fetch-1",
    toolName: "web_fetch",
    success: true,
    resultPreview: "B站主页，粉丝与视频列表实时展示。",
    durationMs: 84,
    backend: "desktop_chrome",
  });

  const continuationContext = await loadContext(continuationSession.id, controller.signal);
  const continuationSystemPrompt = Array.isArray(continuationContext.systemPrompt)
    ? continuationContext.systemPrompt.map((message) => message.content).join("\n\n")
    : continuationContext.systemPrompt;
  assert.match(
    continuationSystemPrompt,
    /## Latest Turn/,
    "loadContext should add a latest-turn block for short continuation turns",
  );
  assert.match(
    continuationSystemPrompt,
    /continuation-like/i,
    "latest-turn block should explicitly mark short follow-up turns",
  );
  assert.match(
    continuationSystemPrompt,
    /<latest_assistant_reply>[\s\S]*我先按 B 站和时间点继续查。[\s\S]*<\/latest_assistant_reply>/u,
    "latest-turn block should keep the immediate assistant reply visible",
  );
  assert.match(
    continuationSystemPrompt,
    /<resolved_current_request>[\s\S]*Current concrete target: B站内容才是准的，查一下3月22日的情况。[\s\S]*Latest user follow-up: 你查/u,
    "latest-turn block should expand a short follow-up into a concrete work item",
  );
  assert.match(
    continuationSystemPrompt,
    /## Research Memory/u,
    "research memory block should remain available for continuation-style investigations",
  );
  assert.match(
    continuationSystemPrompt,
    /## Active Turn/u,
    "active turn block should still anchor the latest user message",
  );
  assert.match(
    continuationSystemPrompt,
    /## Recent Tool Activity/,
    "loadContext should surface recent tool activity for ongoing research threads",
  );
  assert.match(
    continuationSystemPrompt,
    /web_search · via desktop_chrome · completed · 122ms .*摩的司机徐师傅 B站 3月22日/i,
    "recent tool activity block should include the recent search trace",
  );
  assert.match(
    continuationSystemPrompt,
    /web_fetch · via desktop_chrome · completed · 84ms .*space\.bilibili\.com/i,
    "recent tool activity block should include the recent fetch trace",
  );
  assert.match(
    continuationSystemPrompt,
    /## Research Memory/,
    "loadContext should add a research memory ledger for investigation turns",
  );
  assert.match(
    continuationSystemPrompt,
    /Next fetch target: https:\/\/www\.douyin\.com\/user\/testdouyin/,
    "research memory ledger should point at the strongest unfetched candidate URL",
  );
  assert.match(
    continuationSystemPrompt,
    /Fetched evidence:[\s\S]*摩的司机徐师傅的个人空间-哔哩哔哩/,
    "research memory ledger should retain the already fetched upstream page",
  );
  assert.match(
    continuationSystemPrompt,
    /User: 你查/,
    "continuation focus block should include the short follow-up itself",
  );

  const researchCarryoverGuardSession = createSession("research carryover guard smoke");
  createSessionMessage({
    sessionId: researchCarryoverGuardSession.id,
    clientMessageId: "research-guard-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "帮我调查张雪峰。",
    attachmentIds: [],
  });
  const researchCarryoverSeedContext = await loadContext(researchCarryoverGuardSession.id, controller.signal);
  assert.equal(
    typeof researchCarryoverSeedContext.tools.web_search,
    "object",
    "research seed turns should still route web_search",
  );
  createSessionMessage({
    sessionId: researchCarryoverGuardSession.id,
    clientMessageId: "research-guard-user-2",
    deviceId: "desktop-smoke",
    role: "user",
    content: "你变得我好卡",
    attachmentIds: [],
  });
  const researchCarryoverGuardContext = await loadContext(researchCarryoverGuardSession.id, controller.signal);
  const researchCarryoverGuardPrompt = Array.isArray(researchCarryoverGuardContext.systemPrompt)
    ? researchCarryoverGuardContext.systemPrompt.map((message) => message.content).join("\n\n")
    : researchCarryoverGuardContext.systemPrompt;
  assert.equal(
    "web_search" in researchCarryoverGuardContext.tools,
    false,
    "plain complaint follow-ups should not inherit research web_search routing",
  );
  assert.equal(
    researchCarryoverGuardContext.routedSkillIds.includes("web-search"),
    false,
    "plain complaint follow-ups should not carry the research skill into the next turn",
  );
  assert.doesNotMatch(
    researchCarryoverGuardPrompt,
    /continuation-style follow-up/i,
    "plain complaint follow-ups should not be labeled as continuation turns",
  );

  const researchDeepeningSession = createSession("research deepening fetch smoke");
  createSessionMessage({
    sessionId: researchDeepeningSession.id,
    clientMessageId: "research-deepening-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "他们有过很经典的故事啊，这你都不会查吗",
    attachmentIds: [],
  });
  appendSessionEvent(researchDeepeningSession.id, "tool.call.started", {
    toolCallId: "research-deepening-search-1",
    toolName: "web_search",
    inputPreview: "{\"query\":\"火播君 小米粥 故事 经典\"}",
    backend: "desktop_chrome",
  });
  appendSessionEvent(researchDeepeningSession.id, "tool.state.change", {
    toolCallId: "research-deepening-search-1",
    toolName: "web_search",
    status: "done",
    input: {
      query: "火播君 小米粥 故事 经典",
      max_results: 10,
    },
    output: JSON.stringify({
      query: "火播君 小米粥 故事 经典",
      effectiveQuery: "火播君 小米粥 故事 经典",
      sources: [
        {
          citationIndex: 1,
          title: "病院坂saki和火播君的故事 - 萌娘百科",
          url: "https://zh.moegirl.org.cn/test",
          domain: "zh.moegirl.org.cn",
          sourceType: "wiki",
        },
      ],
    }, null, 2),
  });
  appendSessionEvent(researchDeepeningSession.id, "tool.call.completed", {
    toolCallId: "research-deepening-search-1",
    toolName: "web_search",
    success: true,
    resultPreview: "{\"results\":[{\"url\":\"https://zh.moegirl.org.cn/test\"}]}",
    durationMs: 96,
    backend: "desktop_chrome",
  });
  createSessionMessage({
    sessionId: researchDeepeningSession.id,
    clientMessageId: "research-deepening-user-2",
    deviceId: "desktop-smoke",
    role: "user",
    content: "让你深度研究一下你都懒！！！",
    attachmentIds: [],
  });
  const researchDeepeningContext = await loadContext(researchDeepeningSession.id, controller.signal);
  assert.equal(
    typeof researchDeepeningContext.tools.web_search,
    "object",
    "deepening a research follow-up should keep web_search available",
  );
  assert.equal(
    typeof researchDeepeningContext.tools.web_fetch,
    "object",
    "deepening a research follow-up after search evidence should also attach web_fetch",
  );
  assert(
    researchDeepeningContext.routedSkillIds.includes("web-fetch"),
    "deepening a research follow-up after search evidence should route the web-fetch skill",
  );
  assert.deepEqual(
    researchDeepeningContext.firstStepToolChoice,
    { type: "tool", toolName: "web_fetch" },
    "deepening a research follow-up after search evidence should bias the first step toward web_fetch",
  );

  const researchStatusUpdateSession = createSession("research status update smoke");
  createSessionMessage({
    sessionId: researchStatusUpdateSession.id,
    clientMessageId: "research-status-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "帮我调查峰哥亡命天涯这个人",
    attachmentIds: [],
  });
  appendSessionEvent(researchStatusUpdateSession.id, "tool.call.started", {
    toolCallId: "research-status-search-1",
    toolName: "web_search",
    inputPreview: "{\"query\":\"峰哥亡命天涯\"}",
    backend: "desktop_chrome",
  });
  appendSessionEvent(researchStatusUpdateSession.id, "tool.state.change", {
    toolCallId: "research-status-search-1",
    toolName: "web_search",
    status: "done",
    input: {
      query: "峰哥亡命天涯",
      max_results: 10,
    },
    output: JSON.stringify({
      query: "峰哥亡命天涯",
      effectiveQuery: "峰哥亡命天涯",
      sources: [
        {
          citationIndex: 1,
          title: "刚刚，峰哥亡命天涯全平台又被禁止关注了，发生了什么？有回归的风险吗？",
          url: "https://www.zhihu.com/question/1972731289636463313",
          domain: "www.zhihu.com",
          sourceType: "community",
        },
      ],
    }, null, 2),
  });
  appendSessionEvent(researchStatusUpdateSession.id, "tool.call.completed", {
    toolCallId: "research-status-search-1",
    toolName: "web_search",
    success: true,
    resultPreview: "{\"results\":[{\"url\":\"https://www.zhihu.com/question/1972731289636463313\"}]}",
    durationMs: 97,
    backend: "desktop_chrome",
  });
  createSessionMessage({
    sessionId: researchStatusUpdateSession.id,
    clientMessageId: "research-status-user-2",
    deviceId: "desktop-smoke",
    role: "user",
    content: "现在什么情况",
    attachmentIds: [],
  });
  const researchStatusUpdateContext = await loadContext(researchStatusUpdateSession.id, controller.signal);
  assert.equal(
    typeof researchStatusUpdateContext.tools.web_search,
    "object",
    "status-update follow-ups should keep web_search available",
  );
  assert.equal(
    typeof researchStatusUpdateContext.tools.web_fetch,
    "object",
    "status-update follow-ups after evidence should also attach web_fetch",
  );
  assert(
    researchStatusUpdateContext.routedSkillIds.includes("web-fetch"),
    "status-update follow-ups after evidence should route the web-fetch skill",
  );
  assert(
    researchStatusUpdateContext.firstStepToolChoice?.type === "tool"
      && ["web_fetch", "web_search"].includes(researchStatusUpdateContext.firstStepToolChoice.toolName),
    "status-update follow-ups after evidence should still bias the first step toward a research tool",
  );

  const twitterContinuationSession = createSession("twitter continuation smoke");
  createSessionMessage({
    sessionId: twitterContinuationSession.id,
    clientMessageId: "twitter-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "看下这个 x.com 链接里的人都在吵什么。",
    attachmentIds: [],
  });
  createSessionMessage({
    sessionId: twitterContinuationSession.id,
    clientMessageId: "twitter-assistant-1",
    deviceId: "desktop-smoke",
    role: "assistant",
    content: "我先看推文内容和媒体。",
    attachmentIds: [],
  });
  createSessionMessage({
    sessionId: twitterContinuationSession.id,
    clientMessageId: "twitter-user-2",
    deviceId: "desktop-smoke",
    role: "user",
    content: "继续",
    attachmentIds: [],
  });
  const twitterContinuationContext = await loadContext(twitterContinuationSession.id, controller.signal);
  const twitterContinuationPrompt = Array.isArray(twitterContinuationContext.systemPrompt)
    ? twitterContinuationContext.systemPrompt.map((message) => message.content).join("\n\n")
    : twitterContinuationContext.systemPrompt;
  assert.equal(
    typeof twitterContinuationContext.tools.web_search,
    "object",
    "twitter continuation turns should preserve research tools through the research group",
  );
  assert.equal(
    "web_fetch" in twitterContinuationContext.tools,
    true,
    "twitter continuation turns should preserve fetch when the routed social/research skills still need page-reading capability",
  );
  const browserContinuationSession = createSession("browser continuation smoke");
  createSessionMessage({
    sessionId: browserContinuationSession.id,
    clientMessageId: "browser-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "打开浏览器去 B 站登录页，我来扫码。",
    attachmentIds: [],
  });
  createSessionMessage({
    sessionId: browserContinuationSession.id,
    clientMessageId: "browser-assistant-1",
    deviceId: "desktop-smoke",
    role: "assistant",
    content: "我先打开登录页并准备截图。",
    attachmentIds: [],
  });
  appendSessionEvent(browserContinuationSession.id, "tool.call.started", {
    toolCallId: "browser-flow-1",
    toolName: "browser_navigate",
    inputPreview: "{\"url\":\"https://passport.bilibili.com/login\"}",
    backend: "desktop_chrome",
  });
  appendSessionEvent(browserContinuationSession.id, "tool.call.completed", {
    toolCallId: "browser-flow-1",
    toolName: "browser_navigate",
    success: true,
    resultPreview: "{\"url\":\"https://passport.bilibili.com/login\"}",
    durationMs: 155,
    backend: "desktop_chrome",
  });
  createSessionMessage({
    sessionId: browserContinuationSession.id,
    clientMessageId: "browser-user-2",
    deviceId: "desktop-smoke",
    role: "user",
    content: "继续",
    attachmentIds: [],
  });
  const browserContinuationContext = await loadContext(browserContinuationSession.id, controller.signal);
  const browserContinuationPrompt = Array.isArray(browserContinuationContext.systemPrompt)
    ? browserContinuationContext.systemPrompt.map((message) => message.content).join("\n\n")
    : browserContinuationContext.systemPrompt;
  assert.equal(
    typeof browserContinuationContext.tools.browser_navigate,
    "object",
    "browser continuation turns should preserve browser_navigate through sticky browser capability routing",
  );
  assert.equal(
    typeof browserContinuationContext.tools.browser_snapshot,
    "object",
    "browser continuation turns should preserve browser_snapshot through sticky browser capability routing",
  );
  assert.match(
    browserContinuationPrompt,
    /Recent Tool Activity[\s\S]*browser_navigate · via desktop_chrome · completed/i,
    "browser continuation context should retain recent browser tool momentum",
  );

  const timeSession = createSession("time verification smoke");
  createSessionMessage({
    sessionId: timeSession.id,
    clientMessageId: "time-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "现在几点？",
    attachmentIds: [],
  });

  const timeContext = await loadContext(timeSession.id, controller.signal);
  assert.equal("time_now" in timeContext.tools, false, "time questions should not inject a dedicated time tool");
  assert.equal("weather_now" in timeContext.tools, false, "time questions should not inject weather tools");
  const timeSkills = selectRelevantSkillDefinitions("现在几点？");
  assert.equal(
    timeSkills.some((skill) => skill.id === "system-info"),
    true,
    "current time questions should route the system-info skill",
  );
  const timeSkillBlock = buildSkillContextBlock(timeSkills);
  assert.match(
    timeSkillBlock,
    /system-info:/i,
    "current time questions should surface the system-info skill in the routed skill block",
  );
  const timeSystemPrompt = Array.isArray(timeContext.systemPrompt)
    ? timeContext.systemPrompt.map((message) => message.content).join("\n\n")
    : timeContext.systemPrompt;
  assert.match(
    timeSystemPrompt,
    /Required action for this turn: verify it before replying\. Use the routed `system-info` skill first; it can call `bash` with an exact local time command such as `date`/i,
    "active turn block should force system-info-backed date verification for current time questions",
  );

  const timeChallengeSession = createSession("time challenge smoke");
  createSessionMessage({
    sessionId: timeChallengeSession.id,
    clientMessageId: "time-user-2",
    deviceId: "desktop-smoke",
    role: "user",
    content: "今天不是23号吗？",
    attachmentIds: [],
  });
  const timeChallengeContext = await loadContext(timeChallengeSession.id, controller.signal);
  const timeChallengeSkills = selectRelevantSkillDefinitions("今天不是23号吗？");
  assert.equal(
    timeChallengeSkills.some((skill) => skill.id === "system-info"),
    true,
    "date challenge questions should route the system-info skill",
  );
  const timeChallengePrompt = Array.isArray(timeChallengeContext.systemPrompt)
    ? timeChallengeContext.systemPrompt.map((message) => message.content).join("\n\n")
    : timeChallengeContext.systemPrompt;
  assert.match(
    timeChallengePrompt,
    /Required action for this turn: verify it before replying\. Use the routed `system-info` skill first; it can call `bash` with an exact local time command such as `date`/i,
    "active turn block should force system-info-backed date verification for date challenge questions too",
  );

  const weatherSession = createSession("weather verification smoke");
  createSessionMessage({
    sessionId: weatherSession.id,
    clientMessageId: "weather-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "东莞今天天气怎么样？",
    attachmentIds: [],
  });
  const weatherContext = await loadContext(weatherSession.id, controller.signal);
  assert.equal(typeof weatherContext.tools.web_search, "object", "weather questions should inject web_search");
  assert.equal("web_fetch" in weatherContext.tools, true, "weather questions should inject web_fetch when the routed research skill declares it");
  assert.equal("time_now" in weatherContext.tools, false, "weather questions should not inject time tools");
  const weatherSystemPrompt = Array.isArray(weatherContext.systemPrompt)
    ? weatherContext.systemPrompt.map((message) => message.content).join("\n\n")
    : weatherContext.systemPrompt;
  assert.match(
    weatherSystemPrompt,
    /Required action for this turn: verify it before replying\. Use `web_search` to find a fresh weather source, then `web_fetch` if needed/i,
    "active turn block should force web verification for weather questions",
  );

  const creatorMetricSession = createSession("creator metric verification smoke");
  createSessionMessage({
    sessionId: creatorMetricSession.id,
    clientMessageId: "creator-metric-user-1",
    deviceId: "desktop-smoke",
    role: "user",
    content: "病院坂saki现在多少粉丝来着",
    attachmentIds: [],
  });
  const creatorMetricContext = await loadContext(creatorMetricSession.id, controller.signal);
  assert.equal(typeof creatorMetricContext.tools.web_search, "object", "creator metric turns should inject web_search");
  assert.equal("web_fetch" in creatorMetricContext.tools, true, "creator metric turns should inject web_fetch when the routed research skill declares it");
  const creatorMetricPrompt = Array.isArray(creatorMetricContext.systemPrompt)
    ? creatorMetricContext.systemPrompt.map((message) => message.content).join("\n\n")
    : creatorMetricContext.systemPrompt;
  assert.match(
    creatorMetricPrompt,
    /Required action for this turn: start with `web_search` before replying\. If the snippets and source links are enough, answer from them; otherwise call `web_fetch` on the strongest candidate source/i,
    "active turn block should keep creator metric verification search-first and fetch-lazy",
  );
  assert.match(
    creatorMetricPrompt,
    /Baidu Baike has extremely low priority/i,
    "active turn block should explicitly de-prioritize Baidu Baike for creator metric verification turns",
  );

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
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      const query = requestUrl.searchParams.get("q") ?? "";
      if (query.includes("病院坂saki")) {
        response.setHeader("content-type", "text/html; charset=utf-8");
        if (/(B站|bilibili|抖音|douyin|推特|twitter)/u.test(query)) {
          response.end([
            "<html><body>",
            '<div class="result"><a class="result__a" href="https://space.bilibili.com/999999999">病院坂saki的个人空间-哔哩哔哩</a><div class="result__snippet">B站主页，粉丝与投稿实时展示。</div></div>',
            '<div class="result"><a class="result__a" href="https://www.douyin.com/user/byouinsakii">病院坂saki 的抖音主页</a><div class="result__snippet">抖音主页，展示粉丝和作品。</div></div>',
            '<div class="result"><a class="result__a" href="https://x.com/byouinsaki">病院坂saki / X</a><div class="result__snippet">X 主页，展示关注者和动态。</div></div>',
            '<div class="result"><a class="result__a" href="https://baike.baidu.com/item/%E7%97%85%E9%99%A2%E5%9D%82saki/123456">病院坂saki_百度百科</a><div class="result__snippet">截至2025年4月的旧资料。</div></div>',
            "</body></html>",
          ].join(""));
          return;
        }

        response.end([
          "<html><body>",
          '<div class="result"><a class="result__a" href="https://baike.baidu.com/item/%E7%97%85%E9%99%A2%E5%9D%82saki/123456">病院坂saki_百度百科</a><div class="result__snippet">截至2025年4月的旧资料。</div></div>',
          "</body></html>",
        ].join(""));
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (query.includes("摩的司机徐师傅") || query.includes("B站") || query.includes("粉丝")) {
        response.end([
          "<html><body>",
          '<div class="result"><a class="result__a" href="https://baike.baidu.com/item/%E6%91%A9%E7%9A%84%E5%8F%B8%E6%9C%BA%E5%BE%90%E5%B8%88%E5%82%85/65934547">摩的司机徐师傅_百度百科</a><div class="result__snippet">截至2025年4月，粉丝112.5万。</div></div>',
          '<div class="result"><a class="result__a" href="https://space.bilibili.com/3493117728656046">摩的司机徐师傅的个人空间-哔哩哔哩</a><div class="result__snippet">B站主页，粉丝与视频列表实时展示。</div></div>',
          '<div class="result"><a class="result__a" href="https://www.mcndata.cn/details/3493117728656046">MCN DATA - 摩的司机徐师傅</a><div class="result__snippet">第三方监测数据，可作补充参考。</div></div>',
          "</body></html>",
        ].join(""));
        return;
      }
      if (query.includes("抖音") || query.includes("douyin") || query.includes("推特") || query.includes("twitter")) {
        response.end([
          "<html><body>",
          '<div class="result"><a class="result__a" href="https://www.douyin.com/user/testdouyin">测试创作者的抖音主页</a><div class="result__snippet">抖音主页，展示粉丝和作品。</div></div>',
          '<div class="result"><a class="result__a" href="https://x.com/testcreator">Test Creator / X</a><div class="result__snippet">X 主页，展示关注者和动态。</div></div>',
          '<div class="result"><a class="result__a" href="https://zh.wikipedia.org/wiki/Test_Creator">Test Creator - Wikipedia</a><div class="result__snippet">人物背景资料。</div></div>',
          "</body></html>",
        ].join(""));
        return;
      }

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
    const webFetchToolSet = buildToolSet(
      sandbox,
      selectRelevantSkillDefinitions("读取这个网页的原文内容。"),
      {
        query: "读取这个网页的原文内容。",
      },
    );
    const webFetchTool = webFetchToolSet.web_fetch as any;
    const webSearchTool = researchToolSet.web_search as any;
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
    assert(articleResult.includes("Source URL: "), "web_fetch should stamp HTML pages with source metadata");
    assert.equal(articleResult.includes("site-nav"), false, "web_fetch should strip navigation noise");
    assert.equal(articleResult.includes("footer-noise"), false, "web_fetch should strip footer noise");

    const jsonResult = String(
      await webFetchTool.execute({
        url: `${baseUrl}/json`,
        extractMain: true,
        maxLength: 5000,
      }),
    );
    assert(jsonResult.includes("Source URL: "), "web_fetch should stamp JSON payloads with source metadata");
    assert(jsonResult.includes("\"ok\":true"), "web_fetch should preserve JSON payload content");

    const searchResult = JSON.parse(
      String(
        await webSearchTool.execute({
          query: "runtime core",
          maxResults: 5,
          domains: ["docs.example.com"],
        }),
      ),
    ) as {
      results: Array<{ title: string; url: string; snippet: string }>;
      sources?: Array<{ title: string; url: string }>;
    };
    assert.equal(searchResult.results.length > 0, true, "web_search should return search results");
    assert.equal(searchResult.results[0]?.title, "Runtime Core Docs", "web_search should parse result titles");
    assert.equal(searchResult.results[0]?.url, "https://docs.example.com/runtime-core", "web_search should parse result URLs");
    assert(searchResult.results[0]?.snippet.includes("Official runtime core overview."), "web_search should parse result snippets");
    assert.equal(searchResult.sources?.length > 0, true, "web_search should include source links for citation");

    const metricSearchResult = JSON.parse(
      String(
        await webSearchTool.execute({
          query: "摩的司机徐师傅 B站 粉丝 最新",
          maxResults: 5,
        }),
      ),
    ) as {
      effectiveDomains?: string[];
      results: Array<{ domain: string; sourceType: string }>;
    };
    assert.equal(
      metricSearchResult.effectiveDomains?.includes("bilibili.com"),
      true,
      "web_search should auto-scope bilibili metric queries to bilibili.com",
    );
    assert.equal(
      metricSearchResult.results.some((result) => result.domain === "baike.baidu.com"),
      false,
      "web_search should suppress encyclopedia results for fresh platform metric queries when better sources exist",
    );
    assert.equal(
      metricSearchResult.results[0]?.domain,
      "space.bilibili.com",
      "web_search should prioritize the primary platform page for bilibili metric queries",
    );

    const multiPlatformSearchResult = JSON.parse(
      String(
        await webSearchTool.execute({
          query: "测试创作者 抖音 推特 粉丝 最新",
          maxResults: 5,
        }),
      ),
    ) as {
      effectiveDomains?: string[];
      results: Array<{ domain: string }>;
    };
    assert.equal(
      multiPlatformSearchResult.effectiveDomains?.includes("douyin.com"),
      true,
      "web_search should track Douyin as a preferred primary domain when the query mentions 抖音",
    );
    assert.equal(
      multiPlatformSearchResult.effectiveDomains?.includes("x.com"),
      true,
      "web_search should track X as a preferred primary domain when the query mentions 推特/Twitter",
    );
    assert.equal(
      multiPlatformSearchResult.results.some((result) => result.domain.includes("wikipedia.org")),
      false,
      "web_search should suppress wiki results for fresh multi-platform metric queries when primary platform results exist",
    );

    const ngaSearchResult = JSON.parse(
      String(
        await webSearchTool.execute({
          query: "去 NGA 看这个角色的讨论帖子",
          maxResults: 5,
        }),
      ),
    ) as {
      effectiveDomains?: string[];
    };
    assert.equal(
      ngaSearchResult.effectiveDomains?.includes("nga.178.com"),
      true,
      "web_search should auto-scope NGA queries to nga.178.com",
    );
    assert.equal(
      ngaSearchResult.effectiveDomains?.includes("bbs.nga.cn"),
      true,
      "web_search should auto-scope NGA queries to bbs.nga.cn",
    );

    const moegirlSearchResult = JSON.parse(
      String(
        await webSearchTool.execute({
          query: "去萌娘百科看看这个词条",
          maxResults: 5,
        }),
      ),
    ) as {
      effectiveDomains?: string[];
    };
    assert.equal(
      moegirlSearchResult.effectiveDomains?.includes("mzh.moegirl.org.cn"),
      true,
      "web_search should auto-scope 萌娘百科 queries to mzh.moegirl.org.cn",
    );
    assert.equal(
      moegirlSearchResult.effectiveDomains?.includes("zh.moegirl.org.cn"),
      true,
      "web_search should auto-scope 萌娘百科 queries to zh.moegirl.org.cn",
    );

    const creatorMetricSearchResult = JSON.parse(
      String(
        await webSearchTool.execute({
          query: "病院坂saki现在多少粉丝来着",
          maxResults: 5,
        }),
      ),
    ) as {
      effectiveQuery?: string;
      results: Array<{ domain: string }>;
    };
    assert.match(
      creatorMetricSearchResult.effectiveQuery ?? "",
      /B站 .*抖音 .*推特/u,
      "web_search should expand generic creator metric queries toward primary platforms",
    );
    assert.equal(
      creatorMetricSearchResult.results.some((result) => result.domain === "baike.baidu.com"),
      false,
      "web_search should suppress Baidu Baike when primary platform results become available for creator metric queries",
    );
    assert.deepEqual(
      creatorMetricSearchResult.results.slice(0, 3).map((result) => result.domain),
      ["space.bilibili.com", "www.douyin.com", "x.com"],
      "web_search should prioritize primary platform pages for generic creator metric queries",
    );

    const browserNavigateTool = browserToolSet.browser_navigate as any;
    const browserSnapshotTool = browserToolSet.browser_snapshot as any;
    const browserTypeTool = browserToolSet.browser_type as any;
    const browserClickTool = browserToolSet.browser_click as any;
    const browserScreenshotTool = browserToolSet.browser_screenshot as any;
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
