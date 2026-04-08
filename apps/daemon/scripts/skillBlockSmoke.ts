import assert from "node:assert/strict";

type Scenario = {
  name: string;
  selectedSkillIds: string[];
  stickySkillIds?: string[];
  browserRelayAvailable?: boolean;
};

function reversed<T>(values: readonly T[]) {
  return [...values].reverse();
}

async function main() {
  const {
    buildSelectedSkillBodyBlock,
    buildStaticSkillCatalogBlock,
    buildSkillContextBlock,
    computeSkillBlockKey,
    getSkillDefinition,
    getStaticSkillCatalogKey,
    listActiveSkillDefinitions,
    resetSkillCatalogCache,
  } = await import("../src/context/skills/skillLoader.ts");

  resetSkillCatalogCache();

  const staticCatalogBlockA = buildStaticSkillCatalogBlock();
  const staticCatalogBlockB = buildStaticSkillCatalogBlock();
  assert.equal(
    staticCatalogBlockA,
    staticCatalogBlockB,
    "static skill catalog block should be stable across repeated reads",
  );
  assert.equal(
    getStaticSkillCatalogKey(),
    getStaticSkillCatalogKey(),
    "static skill catalog key should be stable across repeated reads",
  );

  const activeSkillIds = listActiveSkillDefinitions().map((skill) => skill.id).sort();

  const singleSkillScenarios = activeSkillIds.map((skillId) => ({
    name: `single:${skillId}`,
    selectedSkillIds: [skillId],
  }));

  const pairedScenarios: Scenario[] = [
    { name: "browser+web-search", selectedSkillIds: ["browser", "web-search"] },
    { name: "browser+web-fetch", selectedSkillIds: ["browser", "web-fetch"] },
    { name: "memory+thread", selectedSkillIds: ["memory-management", "thread-management"] },
    { name: "file+send", selectedSkillIds: ["file-manager", "send-file"] },
    { name: "system+self", selectedSkillIds: ["system-info", "self-management"] },
    { name: "image+screenshot", selectedSkillIds: ["image-gen", "screenshot"] },
    { name: "music+video", selectedSkillIds: ["music-listener", "video-reader"] },
    { name: "skill-hub+skill-search", selectedSkillIds: ["skill-hub", "skill-search"] },
    { name: "browser+telegram", selectedSkillIds: ["browser", "telegram"] },
    { name: "browser+reactions", selectedSkillIds: ["browser", "reactions"] },
    { name: "browser+view-stack", selectedSkillIds: ["browser", "screenshot"] },
    { name: "web-stack", selectedSkillIds: ["web-search", "web-fetch"] },
    { name: "memory+self", selectedSkillIds: ["memory-management", "self-management"] },
    { name: "thread+system", selectedSkillIds: ["thread-management", "system-info"] },
    { name: "image+send", selectedSkillIds: ["image-gen", "send-file"] },
    { name: "video+browser", selectedSkillIds: ["video-reader", "browser"] },
  ];

  const stickyScenarios: Scenario[] = [
    {
      name: "sticky:browser+web",
      selectedSkillIds: ["browser", "web-search"],
      stickySkillIds: ["web-search", "browser"],
      browserRelayAvailable: true,
    },
    {
      name: "sticky:memory+thread",
      selectedSkillIds: ["memory-management", "thread-management"],
      stickySkillIds: ["thread-management", "memory-management"],
    },
    {
      name: "sticky:file+send",
      selectedSkillIds: ["file-manager", "send-file"],
      stickySkillIds: ["send-file", "file-manager"],
    },
    {
      name: "sticky:web-stack",
      selectedSkillIds: ["web-search", "web-fetch"],
      stickySkillIds: ["web-fetch", "web-search"],
    },
    {
      name: "sticky:system+self",
      selectedSkillIds: ["system-info", "self-management"],
      stickySkillIds: ["self-management", "system-info"],
    },
    {
      name: "sticky:image+browser",
      selectedSkillIds: ["image-gen", "browser"],
      stickySkillIds: ["browser", "image-gen"],
      browserRelayAvailable: false,
    },
    {
      name: "sticky:music+video",
      selectedSkillIds: ["music-listener", "video-reader"],
      stickySkillIds: ["video-reader", "music-listener"],
    },
    {
      name: "sticky:skill-tools",
      selectedSkillIds: ["skill-hub", "skill-search"],
      stickySkillIds: ["skill-search", "skill-hub"],
    },
    {
      name: "sticky:telegram+browser",
      selectedSkillIds: ["telegram", "browser"],
      stickySkillIds: ["browser", "telegram"],
    },
    {
      name: "sticky:reactions+thread",
      selectedSkillIds: ["reactions", "thread-management"],
      stickySkillIds: ["thread-management", "reactions"],
    },
    {
      name: "sticky:screenshot+send",
      selectedSkillIds: ["screenshot", "send-file"],
      stickySkillIds: ["send-file", "screenshot"],
    },
    {
      name: "sticky:memory+system",
      selectedSkillIds: ["memory-management", "system-info"],
      stickySkillIds: ["system-info", "memory-management"],
    },
    {
      name: "sticky:browser+fetch",
      selectedSkillIds: ["browser", "web-fetch"],
      stickySkillIds: ["web-fetch", "browser"],
      browserRelayAvailable: true,
    },
    {
      name: "sticky:image+self",
      selectedSkillIds: ["image-gen", "self-management"],
      stickySkillIds: ["self-management", "image-gen"],
    },
    {
      name: "sticky:video+send",
      selectedSkillIds: ["video-reader", "send-file"],
      stickySkillIds: ["send-file", "video-reader"],
    },
    {
      name: "sticky:file+telegram",
      selectedSkillIds: ["file-manager", "telegram"],
      stickySkillIds: ["telegram", "file-manager"],
    },
  ];

  const noSkillScenarios: Scenario[] = [
    { name: "empty:default", selectedSkillIds: [] },
  ];

  const scenarios = [
    ...singleSkillScenarios,
    ...pairedScenarios,
    ...stickyScenarios,
    ...noSkillScenarios,
  ];

  assert.equal(scenarios.length, 54, "expected exactly 54 skill-block scenarios");

  for (const scenario of scenarios) {
    const selectedSkills = scenario.selectedSkillIds.map((skillId) => {
      const skill = getSkillDefinition(skillId);
      assert(skill, `missing skill ${skillId} in scenario ${scenario.name}`);
      return skill;
    });

    const blockA = buildSkillContextBlock(selectedSkills, {
      browserRelayAvailable: scenario.browserRelayAvailable,
      routeHints: scenario.stickySkillIds
        ? {
            stickySkillIds: scenario.stickySkillIds,
            reasons: ["smoke"],
          }
        : undefined,
    });
    const blockB = buildSkillContextBlock(reversed(selectedSkills), {
      browserRelayAvailable: scenario.browserRelayAvailable,
      routeHints: scenario.stickySkillIds
        ? {
            stickySkillIds: reversed(scenario.stickySkillIds),
            reasons: ["smoke"],
          }
        : undefined,
    });
    const bodiesA = buildSelectedSkillBodyBlock(selectedSkills);
    const bodiesB = buildSelectedSkillBodyBlock(reversed(selectedSkills));

    assert.equal(
      computeSkillBlockKey(blockA),
      computeSkillBlockKey(blockB),
      `skill block key should be stable across selected/sticky permutations for ${scenario.name}`,
    );
    assert.deepEqual(
      bodiesA.keys,
      bodiesB.keys,
      `skill body keys should be stable across selected permutations for ${scenario.name}`,
    );

    for (const skillId of scenario.selectedSkillIds) {
      const skill = getSkillDefinition(skillId);
      assert(skill, `missing skill ${skillId}`);
      assert(
        blockA.includes(`${skill.label}: ${skill.description}`),
        `skill block should render selected skill ${skillId} for ${scenario.name}`,
      );
    }

    if (scenario.selectedSkillIds.length === 0) {
      assert(
        blockA.includes("No extra local skill was selected for this turn."),
        `empty scenario should render no-skill header for ${scenario.name}`,
      );
    }
  }

  console.info(`[skill-block-smoke] passed ${scenarios.length} scenarios`);
}

main().catch((error) => {
  console.error("[skill-block-smoke] failed", error);
  process.exitCode = 1;
});
