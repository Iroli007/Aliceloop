import { reconcileRunningSandboxRuns } from "./repositories/sandboxRunRepository";
import { reconcileInterruptedSessionState } from "./repositories/sessionRepository";
import { listActiveSkillDefinitions } from "./context/skills/skillLoader";
import { listRequestedSkillToolNames } from "./context/tools/toolRegistry";
import { createServer } from "./server";

const port = Number(process.env.ALICELOOP_DAEMON_PORT ?? 3030);
const host = process.env.ALICELOOP_DAEMON_HOST ?? "127.0.0.1";

async function start() {
  const sessionRecovery = reconcileInterruptedSessionState();
  const sandboxRecoveryCount = reconcileRunningSandboxRuns();
  if (sessionRecovery.clearedJobs > 0 || sessionRecovery.clearedApprovals > 0 || sandboxRecoveryCount > 0) {
    console.info(
      "[aliceloop-daemon] recovered interrupted state",
      JSON.stringify({
        clearedJobs: sessionRecovery.clearedJobs,
        clearedApprovals: sessionRecovery.clearedApprovals,
        clearedSandboxRuns: sandboxRecoveryCount,
      }),
    );
  }

  const activeSkills = listActiveSkillDefinitions();
  const activeSkillToolNames = listRequestedSkillToolNames(activeSkills);
  console.info(
    "[aliceloop-daemon] active skills ready",
    JSON.stringify({
      count: activeSkills.length,
      skills: activeSkills.map((skill) => skill.id),
      adapters: activeSkillToolNames,
    }),
  );

  const server = await createServer();
  await server.listen({
    host,
    port,
  });
}

start().catch((error) => {
  console.error("[aliceloop-daemon] failed to start", error);
  process.exitCode = 1;
});
