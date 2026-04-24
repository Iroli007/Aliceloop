import assert from "node:assert/strict";
import { listAvailableToolAdapterNames } from "../../src/context/tools/skillToolFactories";

function main() {
  const visibleTools = listAvailableToolAdapterNames();
  const chromeRelayTools = visibleTools.filter((toolName) => toolName.startsWith("chrome_relay_"));
  assert.ok(
    chromeRelayTools.includes("chrome_relay_status") && chromeRelayTools.includes("chrome_relay_navigate"),
    "chrome_relay_* tools should be available through the adapter catalog",
  );
  assert.ok(
    visibleTools.includes("browser_navigate") && visibleTools.includes("browser_snapshot"),
    "browser_* tools should remain visible",
  );
  assert.equal(new Set(visibleTools).size, visibleTools.length, "visible tool adapter names should be unique");

  console.log(JSON.stringify({
    ok: true,
    chromeRelayTools,
    browserTools: visibleTools.filter((toolName) => toolName.startsWith("browser_")),
  }, null, 2));
}

main();
