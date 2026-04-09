import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Scenario = {
  name: string;
  query?: string;
  skillIds?: string[];
  additionalToolNames?: string[];
  expectedTools?: string[];
  unexpectedTools?: string[];
  planModeActive?: boolean;
};

function reversed<T>(values: readonly T[]) {
  return [...values].reverse();
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-tool-surface-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const [
    { createPermissionSandboxExecutor },
    { buildToolSet, computeToolSurfaceKey, DEFAULT_ATTACHED_TOOL_NAMES },
    { getSkillDefinition, listActiveSkillDefinitions, resetSkillCatalogCache },
  ] = await Promise.all([
    import("../src/services/sandboxExecutor.ts"),
    import("../src/context/tools/toolRegistry.ts"),
    import("../src/context/skills/skillLoader.ts"),
  ]);

  resetSkillCatalogCache();

  const sandbox = createPermissionSandboxExecutor({
    label: "tool-surface-smoke",
    extraReadRoots: [tempDataDir],
    extraWriteRoots: [tempDataDir],
    extraCwdRoots: [tempDataDir],
  });

  const activeSkills = listActiveSkillDefinitions();
  const activeSkillIds = activeSkills.map((skill) => skill.id).sort();

  const singleSkillScenarios = activeSkillIds.map((skillId) => {
    const skill = getSkillDefinition(skillId);
    assert(skill, `missing active skill definition for ${skillId}`);
    return {
      name: `skill:${skillId}`,
      skillIds: [skillId],
      expectedTools: [...skill.allowedTools].sort(),
    } satisfies Scenario;
  });

  const skillWithAdditionalScenarios = activeSkillIds.map((skillId) => {
    const skill = getSkillDefinition(skillId);
    assert(skill, `missing active skill definition for ${skillId}`);
    const additions = [...new Set([...skill.allowedTools].slice(0, 2).reverse())];
    return {
      name: `skill+extra:${skillId}`,
      skillIds: [skillId],
      additionalToolNames: additions,
      expectedTools: [...new Set([...skill.allowedTools, ...additions])].sort(),
    } satisfies Scenario;
  });

  const mixedScenarios: Scenario[] = [
    {
      name: "base",
      expectedTools: ["agent", "enter_plan_mode"],
      unexpectedTools: ["ask_user_question", "task_output"],
    },
    {
      name: "plan-mode-active",
      planModeActive: true,
      expectedTools: [
        "exit_plan_mode",
        "write_plan_artifact",
        "web_search",
        "web_fetch",
        "view_image",
        "browser_navigate",
        "browser_snapshot",
        "browser_find",
        "browser_wait",
        "browser_scroll",
        "browser_screenshot",
        "browser_media_probe",
        "browser_video_watch_start",
        "browser_video_watch_poll",
        "browser_video_watch_stop",
        "chrome_relay_status",
        "chrome_relay_list_tabs",
        "chrome_relay_open",
        "chrome_relay_navigate",
        "chrome_relay_read",
        "chrome_relay_read_dom",
        "chrome_relay_screenshot",
        "chrome_relay_scroll",
        "chrome_relay_back",
        "chrome_relay_forward",
        "ask_user_question",
      ],
    },
    {
      name: "browser+research",
      skillIds: ["browser", "web-search"],
      expectedTools: ["web_search"],
    },
    {
      name: "browser+fetch",
      skillIds: ["browser", "web-fetch"],
      expectedTools: ["web_fetch"],
    },
    {
      name: "memory+thread",
      skillIds: ["memory-management", "thread-management"],
    },
    {
      name: "image+screenshot",
      skillIds: ["image-gen", "screenshot"],
    },
    {
      name: "file+send",
      skillIds: ["file-manager", "send-file"],
    },
    {
      name: "system+self",
      skillIds: ["system-info", "self-management"],
    },
    {
      name: "browser+twitter",
      skillIds: ["browser", "web-search"],
      query: "打开推特主页并找出最新推文",
    },
    {
      name: "browser+shopping",
      skillIds: ["browser"],
      query: "打开淘宝搜索 Yamaha Pacifica",
    },
    {
      name: "browser+interaction",
      skillIds: ["browser"],
      query: "打开网页并点击登录按钮然后输入账号",
    },
    {
      name: "research",
      query: "查一下今天上海天气",
      expectedTools: ["web_search"],
    },
    {
      name: "fetch",
      query: "读取这个页面正文并提取出处 https://example.com/post",
      expectedTools: ["web_fetch"],
    },
    {
      name: "deep-research-followup",
      query: "继续深挖这篇文章，去读原文看全文",
      skillIds: ["web-search"],
      expectedTools: ["web_fetch", "web_search"],
    },
    {
      name: "image-attachment",
      query: "看看这张图里写了什么",
      expectedTools: ["view_image"],
    },
    {
      name: "document-ingest-additional",
      additionalToolNames: ["document_ingest"],
      expectedTools: ["document_ingest"],
    },
    {
      name: "review-coach-additional",
      additionalToolNames: ["review_coach"],
      expectedTools: ["review_coach"],
    },
    {
      name: "task-output-not-auto",
      query: "帮我写个代码实现登录功能并顺手修一下这个 bug",
      expectedTools: ["agent"],
      unexpectedTools: ["task_output"],
    },
  ];

  const scenarios = [
    ...singleSkillScenarios,
    ...skillWithAdditionalScenarios,
    ...mixedScenarios,
  ];

  assert.equal(scenarios.length, 60, "expected exactly 60 tool-surface scenarios");

  const defaultPrefix = [...DEFAULT_ATTACHED_TOOL_NAMES];

  for (const scenario of scenarios) {
    const resolvedSkills = (scenario.skillIds ?? []).map((skillId) => {
      const skill = getSkillDefinition(skillId);
      assert(skill, `scenario ${scenario.name} references missing skill ${skillId}`);
      return skill;
    });

    const forwardTools = buildToolSet(sandbox, resolvedSkills, {
      sessionId: `tool-surface-${scenario.name}`,
      query: scenario.query ?? null,
      additionalToolNames: scenario.additionalToolNames ?? [],
      planModeActive: scenario.planModeActive ?? false,
    });
    const reverseTools = buildToolSet(sandbox, reversed(resolvedSkills), {
      sessionId: `tool-surface-${scenario.name}`,
      query: scenario.query ?? null,
      additionalToolNames: reversed(scenario.additionalToolNames ?? []),
      planModeActive: scenario.planModeActive ?? false,
    });

    const forwardNames = Object.keys(forwardTools);
    const reverseNames = Object.keys(reverseTools);
    const expectedPrefix = scenario.planModeActive
      ? ["bash", "read", "glob", "grep"]
      : defaultPrefix;

    assert.deepEqual(
      forwardNames.slice(0, expectedPrefix.length),
      expectedPrefix,
      `default tool prefix should remain stable for ${scenario.name}`,
    );
    assert.deepEqual(
      reverseNames.slice(0, expectedPrefix.length),
      expectedPrefix,
      `default tool prefix should remain stable under permutation for ${scenario.name}`,
    );
    assert.deepEqual(
      forwardNames,
      reverseNames,
      `tool order should be stable across skill/additional permutations for ${scenario.name}`,
    );
    assert.equal(
      computeToolSurfaceKey(forwardNames),
      computeToolSurfaceKey(reverseNames),
      `tool surface key should be stable across permutations for ${scenario.name}`,
    );
    if (scenario.planModeActive) {
      assert(
        !forwardNames.includes("use_skill"),
        `scenario ${scenario.name} should suppress use_skill while planning`,
      );
      for (const blockedTool of [
        "write",
        "edit",
        "browser_click",
        "browser_type",
        "browser_batch",
        "chrome_relay_click",
        "chrome_relay_type",
        "chrome_relay_eval",
      ]) {
        assert(
          !forwardNames.includes(blockedTool),
          `scenario ${scenario.name} should not include plan-unsafe tool ${blockedTool}`,
        );
      }
    } else {
      assert(
        forwardNames.includes("use_skill"),
        `scenario ${scenario.name} should expose use_skill outside plan mode`,
      );
      assert(
        !forwardNames.includes("ask_user_question"),
        `scenario ${scenario.name} should not expose ask_user_question outside plan mode`,
      );
    }

    for (const skill of resolvedSkills) {
      for (const allowedTool of skill.allowedTools) {
        assert(
          forwardNames.includes(allowedTool),
          `scenario ${scenario.name} should fully attach ${skill.id} allowed tool ${allowedTool}`,
        );
      }
    }

    for (const expectedTool of scenario.expectedTools ?? []) {
      assert(
        forwardNames.includes(expectedTool),
        `scenario ${scenario.name} should include tool ${expectedTool}`,
      );
    }

    for (const unexpectedTool of scenario.unexpectedTools ?? []) {
      assert(
        !forwardNames.includes(unexpectedTool),
        `scenario ${scenario.name} should not include tool ${unexpectedTool}`,
      );
    }
  }

  console.info(`[tool-surface-smoke] passed ${scenarios.length} scenarios`);
}

main().catch((error) => {
  console.error("[tool-surface-smoke] failed", error);
  process.exitCode = 1;
});
