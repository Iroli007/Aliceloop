import { publishSessionEvent } from "../realtime/sessionStreams";
import {
  completeCronJobRun,
  failCronJobRun,
  listDueCronJobs,
} from "../repositories/cronJobRepository";
import {
  createSession,
  createSessionMessage,
  hasSession,
} from "../repositories/sessionRepository";
import { abortAgentForSession } from "../runtime/agentRuntime";
import { runProviderReply } from "./providerRunner";
import { syncSessionProjectHistory } from "./sessionProjectService";

function getSchedulerPollMs() {
  const parsed = Number(process.env.ALICELOOP_SCHEDULER_POLL_MS ?? "1000");
  if (!Number.isFinite(parsed) || parsed < 50) {
    return 1000;
  }

  return Math.trunc(parsed);
}

function buildScheduledPromptMessage(input: {
  name: string;
  schedule: string;
  triggeredAt: string;
  prompt: string;
}) {
  return [
    `[Scheduled task: ${input.name}]`,
    `Schedule: ${input.schedule}`,
    `Triggered at: ${input.triggeredAt}`,
    "",
    input.prompt,
  ].join("\n");
}

export function startSchedulerService() {
  const inFlight = new Set<string>();
  let stopped = false;
  let polling = false;

  async function tick() {
    if (stopped || polling) {
      return;
    }

    polling = true;
    try {
      const dueJobs = listDueCronJobs();
      await Promise.all(
        dueJobs.map(async (job) => {
          if (inFlight.has(job.id)) {
            return;
          }

          inFlight.add(job.id);
          const runAt = new Date().toISOString();

          try {
            let sessionId = job.sessionId;
            if (!sessionId || !hasSession(sessionId)) {
              sessionId = createSession({ title: `定时任务 · ${job.name}` }).id;
            }

            const result = createSessionMessage({
              sessionId,
              clientMessageId: `cron-${job.id}-${Date.now()}`,
              deviceId: "aliceloop-scheduler",
              role: "user",
              content: buildScheduledPromptMessage({
                name: job.name,
                schedule: job.schedule,
                triggeredAt: runAt,
                prompt: job.prompt,
              }),
              attachmentIds: [],
            });

            for (const event of result.events) {
              publishSessionEvent(event);
            }

            await syncSessionProjectHistory(sessionId);

            completeCronJobRun({
              jobId: job.id,
              runAt,
              sessionId,
            });

            abortAgentForSession(sessionId, "interrupt");
            void runProviderReply(sessionId);
          } catch (error) {
            failCronJobRun({
              jobId: job.id,
              runAt,
              sessionId: job.sessionId,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            console.error("[aliceloop-daemon] scheduled job failed", {
              jobId: job.id,
              name: job.name,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            inFlight.delete(job.id);
          }
        }),
      );
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, getSchedulerPollMs());

  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
