import assert from "node:assert/strict";
import { listAvailableToolAdapterNames } from "../src/context/tools/skillToolFactories";

function main() {
  const visibleTools = listAvailableToolAdapterNames();
  assert.equal(
    visibleTools.filter((toolName) => toolName.startsWith("chrome_relay_")).length,
    0,
    "chrome_relay_* should stay hidden from the normal model-facing tool adapter list",
  );
  assert.ok(
    visibleTools.includes("browser_navigate") && visibleTools.includes("browser_snapshot"),
    "browser_* tools should remain visible",
  );

  console.log(JSON.stringify({
    ok: true,
    browserTools: visibleTools.filter((toolName) => toolName.startsWith("browser_")),
  }, null, 2));
}

main();
