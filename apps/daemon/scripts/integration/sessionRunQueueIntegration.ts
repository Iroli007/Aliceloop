import assert from "node:assert/strict";

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const [{ enqueueSessionRun, getQueuedSessionCount }] = await Promise.all([
    import("../../src/services/sessionRunQueue.ts"),
  ]);

  const events: string[] = [];

  await Promise.all([
    enqueueSessionRun("session-a", async () => {
      events.push("session-a:first:start");
      await sleep(40);
      events.push("session-a:first:end");
    }),
    enqueueSessionRun("session-a", async () => {
      events.push("session-a:second:start");
      await sleep(10);
      events.push("session-a:second:end");
    }),
    enqueueSessionRun("session-b", async () => {
      events.push("session-b:first:start");
      await sleep(5);
      events.push("session-b:first:end");
    }),
  ]);

  assert(events.indexOf("session-a:first:end") < events.indexOf("session-a:second:start"), "same session should run serially");
  assert.equal(getQueuedSessionCount(), 0, "queue should drain after all session runs complete");

  console.log(
    JSON.stringify(
      {
        ok: true,
        events,
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
