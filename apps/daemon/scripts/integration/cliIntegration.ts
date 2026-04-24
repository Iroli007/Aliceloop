import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface CapturedRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function listen(server: ReturnType<typeof createHttpServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-cli-smoke-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;
  process.env.ALICELOOP_PROVIDER_KEYCHAIN_SERVICE = `Aliceloop CLI Integration ${Date.now()}`;
  process.env.ALICELOOP_SCHEDULER_POLL_MS = "100";
  process.env.ALICELOOP_TELEGRAM_BOT_TOKEN = "cli-smoke-bot-token";

  const [{ createServer }, { runCli }, { createSession, createSessionMessage, getSessionProjectBinding }] = await Promise.all([
    import("../../src/server.ts"),
    import("../../src/cli/index.ts"),
    import("../../src/repositories/sessionRepository.ts"),
  ]);

  const session = createSession("CLI Smoke Session");
  const seededMessage = createSessionMessage({
    sessionId: session.id,
    clientMessageId: "cli-smoke-user-1",
    deviceId: "cli-smoke-desktop",
    role: "user",
    content: "Archive token CLI smoke needle lives in this older message only.",
    attachmentIds: [],
  });
  createSessionMessage({
    sessionId: session.id,
    clientMessageId: "cli-smoke-user-2",
    deviceId: "cli-smoke-desktop",
    role: "user",
    content: "Inspect the newest CLI preview path instead.",
    attachmentIds: [],
  });

  const server = await createServer();
  await server.listen({ host: "127.0.0.1", port: 0 });
  const imageBackend = createHttpServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "POST" && request.url === "/v1/images/generations") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        created: Date.now(),
        data: [
          {
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=",
            revised_prompt: "CLI smoke revised prompt",
            mime_type: "image/png",
          },
        ],
      }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === `/bot/${process.env.ALICELOOP_TELEGRAM_BOT_TOKEN}/getMe`) {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: true,
        result: {
          id: 424242,
          is_bot: true,
          first_name: "CLI Smoke Bot",
          username: "cli_smoke_bot",
        },
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === `/bot/${process.env.ALICELOOP_TELEGRAM_BOT_TOKEN}/sendMessage`) {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: true,
        result: {
          message_id: 101,
          chat: { id: 123456, type: "private" },
          text: "CLI telegram smoke",
        },
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === `/bot/${process.env.ALICELOOP_TELEGRAM_BOT_TOKEN}/sendDocument`) {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: true,
        result: {
          message_id: 102,
          chat: { id: 123456, type: "private" },
          document: {
            file_name: "cli-external-smoke.txt",
          },
          caption: "Telegram file smoke",
        },
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/discord-webhook") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        id: "discord-smoke-message",
        content: "CLI discord smoke",
        attachments: [
          {
            id: "discord-attachment-1",
            filename: "cli-external-smoke.txt",
          },
        ],
      }));
      return;
    }

    response.statusCode = 404;
    response.end("not-found");
  });
  await listen(imageBackend);

  try {
    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve daemon address");
    }
    const imageBackendAddress = imageBackend.address();
    if (!imageBackendAddress || typeof imageBackendAddress === "string") {
      throw new Error("Failed to resolve image backend address");
    }

    process.env.ALICELOOP_DAEMON_URL = `http://127.0.0.1:${address.port}`;
    process.env.ALICELOOP_TELEGRAM_API_BASE = `http://127.0.0.1:${imageBackendAddress.port}/bot`;
    process.env.ALICELOOP_DISCORD_WEBHOOK_URL = `http://127.0.0.1:${imageBackendAddress.port}/discord-webhook`;

    async function capture(args: string[]): Promise<CapturedRun> {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(args, {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      });

      return {
        code,
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
      };
    }

    const status = await capture(["status"]);
    assert.equal(status.code, 0, "status should succeed");
    assert(status.stdout.includes("\"service\": \"aliceloop-daemon\""), "status should print daemon health");

    const memoryAdd = await capture(["memory", "add", "Remember the CLI smoke path"]);
    assert.equal(memoryAdd.code, 0, "memory add should succeed");
    const addedMemory = JSON.parse(memoryAdd.stdout) as { id: string; content: string };
    assert(addedMemory.id, "memory add should return an id");

    const memorySearch = await capture(["memory", "search", "CLI smoke"]);
    assert.equal(memorySearch.code, 0, "memory search should succeed");
    assert(memorySearch.stdout.includes(addedMemory.id), "memory search should return the created memory");
    assert(memorySearch.stdout.includes("\"durability\": \"permanent\""), "memory CLI should read from semantic memory entries");

    const memoryArchive = await capture(["memory", "archive"]);
    assert.equal(memoryArchive.code, 0, "memory archive should succeed");
    assert(memoryArchive.stdout.includes("\"projectCount\""), "memory archive should report resync results");

    const transcriptPath = getSessionProjectBinding(session.id)?.transcriptMarkdownPath;
    assert(transcriptPath, "seeded session should have a transcript export path");
    appendFileSync(transcriptPath, "\nInjected archive only token: CLI-ARCHIVE-ONLY-SENTINEL\n", "utf8");

    const memoryGrep = await capture(["memory", "grep", "CLI smoke needle"]);
    assert.equal(memoryGrep.code, 0, "memory grep should succeed");
    assert(memoryGrep.stdout.includes(session.id), "memory grep should find the matching thread");
    assert(memoryGrep.stdout.includes("\"matchedPreview\""), "memory grep should surface matched conversation text");

    const archiveOnlyGrep = await capture(["memory", "grep", "CLI-ARCHIVE-ONLY-SENTINEL"]);
    assert.equal(archiveOnlyGrep.code, 0, "memory grep should search transcript archives");
    assert(archiveOnlyGrep.stdout.includes(session.id), "memory grep should find archive-only transcript content");

    const configGet = await capture(["config", "get", "runtime.sandboxProfile"]);
    assert.equal(configGet.code, 0, "config get should succeed");
    assert.equal(configGet.stdout.trim(), "full-access", "runtime sandbox profile should default to full-access");

    const autoApproveGet = await capture(["config", "get", "runtime.autoApproveToolRequests"]);
    assert.equal(autoApproveGet.code, 0, "runtime auto-approve config get should succeed");
    assert.equal(autoApproveGet.stdout.trim(), "true", "runtime auto-approve should default to true");

    const autoApproveSet = await capture(["config", "set", "runtime.autoApproveToolRequests", "false"]);
    assert.equal(autoApproveSet.code, 0, "runtime auto-approve config set should succeed");
    assert(autoApproveSet.stdout.includes("\"autoApproveToolRequests\": false"), "config set should update runtime auto-approve");

    const configSet = await capture(["config", "set", "runtime.sandboxProfile", "full-access"]);
    assert.equal(configSet.code, 0, "config set should succeed");
    assert(configSet.stdout.includes("\"sandboxProfile\": \"full-access\""), "config set should return updated runtime settings");

    const configUserSet = await capture(["config", "set", "user.displayName", "CLI Smoke User"]);
    assert.equal(configUserSet.code, 0, "user profile update should succeed");
    assert(configUserSet.stdout.includes("\"displayName\": \"CLI Smoke User\""), "config set should update user profile");

    const providers = await capture(["providers"]);
    assert.equal(providers.code, 0, "providers should succeed");
    assert(providers.stdout.includes("\"id\": \"openai\""), "providers should list provider configs");

    const skillsList = await capture(["skills", "list"]);
    assert.equal(skillsList.code, 0, "skills list should succeed");
    assert(skillsList.stdout.includes("\"id\": \"browser\""), "skills list should include browser");

    const skillsSearch = await capture(["skills", "search", "browser"]);
    assert.equal(skillsSearch.code, 0, "skills search should succeed");
    assert(skillsSearch.stdout.includes("\"id\": \"browser\""), "skills search should find browser-related skills");

    const skillsShow = await capture(["skills", "show", "skill-hub"]);
    assert.equal(skillsShow.code, 0, "skills show should succeed");
    assert(skillsShow.stdout.includes("\"id\": \"skill-hub\""), "skills show should return the requested skill");

    const threadBodySearch = await capture(["thread", "search", "CLI smoke needle"]);
    assert.equal(threadBodySearch.code, 0, "thread search should succeed");
    assert(threadBodySearch.stdout.includes(session.id), "thread search should find the matching thread body");
    assert(threadBodySearch.stdout.includes("\"matchedPreview\""), "thread search should expose matched preview metadata");

    const providerBaseUrlSet = await capture([
      "config",
      "set",
      "providers.openai.baseUrl",
      `http://127.0.0.1:${imageBackendAddress.port}/v1`,
    ]);
    assert.equal(providerBaseUrlSet.code, 0, "provider base url update should succeed");

    const providerEnabledSet = await capture(["config", "set", "providers.openai.enabled", "true"]);
    assert.equal(providerEnabledSet.code, 0, "provider enable should succeed");

    const imageOutputPath = join(tempDataDir, "cli-image-smoke.png");
    const imageGenerate = await capture([
      "image",
      "generate",
      "CLI",
      "image",
      "smoke",
      "--provider",
      "openai",
      "--output",
      imageOutputPath,
    ]);
    assert.equal(imageGenerate.code, 0, "image generate should succeed");
    assert(imageGenerate.stdout.includes("\"providerId\": \"openai\""), "image generate should return the selected provider");
    assert(imageGenerate.stdout.includes(imageOutputPath), "image generate should report the output path");
    assert.equal(existsSync(imageOutputPath), true, "image generate should write the output file");

    const fakeVideoPath = join(tempDataDir, "cli-video-smoke.mp4");
    writeFileSync(fakeVideoPath, "not-a-real-video", "utf8");
    const videoAnalyzeWithoutGemini = await capture(["video", "analyze", fakeVideoPath, "Describe this video"]);
    assert.equal(videoAnalyzeWithoutGemini.code, 1, "video analyze should fail cleanly without Gemini");
    assert(
      videoAnalyzeWithoutGemini.stderr.includes("Gemini provider is not available"),
      "video analyze should clearly explain the Gemini requirement",
    );

    const externalFilePath = join(tempDataDir, "cli-external-smoke.txt");
    writeFileSync(externalFilePath, "external smoke payload", "utf8");

    const telegramMe = await capture(["telegram", "me"]);
    assert.equal(telegramMe.code, 0, "telegram me should succeed");
    assert(telegramMe.stdout.includes("\"username\": \"cli_smoke_bot\""), "telegram me should return bot identity");

    const telegramSend = await capture(["telegram", "send", "123456", "CLI telegram smoke"]);
    assert.equal(telegramSend.code, 0, "telegram send should succeed");
    assert(telegramSend.stdout.includes("\"message_id\": 101"), "telegram send should return a sent message id");

    const telegramFile = await capture(["telegram", "file", "123456", externalFilePath, "Telegram file smoke"]);
    assert.equal(telegramFile.code, 0, "telegram file should succeed");
    assert(telegramFile.stdout.includes("\"file_name\": \"cli-external-smoke.txt\""), "telegram file should return document metadata");

    const discordSend = await capture(["discord", "send", "CLI discord smoke"]);
    assert.equal(discordSend.code, 0, "discord send should succeed");
    assert(discordSend.stdout.includes("\"id\": \"discord-smoke-message\""), "discord send should return webhook payload");

    const discordFile = await capture(["discord", "file", externalFilePath, "Discord file smoke"]);
    assert.equal(discordFile.code, 0, "discord file should succeed");
    assert(discordFile.stdout.includes("\"filename\": \"cli-external-smoke.txt\""), "discord file should return attachment metadata");

    const musicOutputPath = join(tempDataDir, "cli-music-smoke.mid");
    const musicGenerate = await capture([
      "music",
      "generate",
      "calm",
      "piano",
      "sunrise",
      "--output",
      musicOutputPath,
      "--bars",
      "4",
    ]);
    assert.equal(musicGenerate.code, 0, "music generate should succeed");
    assert(musicGenerate.stdout.includes(musicOutputPath), "music generate should report the output path");
    assert(musicGenerate.stdout.includes("\"programLabel\": \"acoustic-grand-piano\""), "music generate should report the chosen instrument");
    assert.equal(existsSync(musicOutputPath), true, "music generate should write the midi file");

    const reactionAdd = await capture(["reaction", "add", session.id, seededMessage.message.id, "👍"]);
    assert.equal(reactionAdd.code, 0, "reaction add should succeed");
    assert(reactionAdd.stdout.includes("\"created\": true"), "reaction add should create a new reaction");
    assert(reactionAdd.stdout.includes("\"emoji\": \"👍\""), "reaction add should echo the emoji");

    const reactionList = await capture(["reaction", "list", session.id, seededMessage.message.id]);
    assert.equal(reactionList.code, 0, "reaction list should succeed");
    assert(reactionList.stdout.includes("\"emoji\": \"👍\""), "reaction list should include the created reaction");

    const reactionRemove = await capture(["reaction", "remove", session.id, seededMessage.message.id, "👍"]);
    assert.equal(reactionRemove.code, 0, "reaction remove should succeed");
    assert(reactionRemove.stdout.includes("\"removed\": true"), "reaction remove should delete the reaction");

    if (process.platform === "darwin") {
      const voiceList = await capture(["voice", "list"]);
      assert.equal(voiceList.code, 0, "voice list should succeed on macOS");
      assert(voiceList.stdout.includes("\"voice\""), "voice list should return at least one installed voice");

      const voiceOutputPath = join(tempDataDir, "cli-voice-smoke.aiff");
      const voiceSave = await capture(["voice", "save", voiceOutputPath, "CLI voice smoke"]);
      assert.equal(voiceSave.code, 0, "voice save should succeed on macOS");
      assert(voiceSave.stdout.includes(voiceOutputPath), "voice save should return the output path");
    }

    const threads = await capture(["threads", "5"]);
    assert.equal(threads.code, 0, "threads should succeed");
    assert(threads.stdout.includes(session.id), "threads should include the seeded session");

    const threadInfo = await capture(["thread", "info", session.id]);
    assert.equal(threadInfo.code, 0, "thread info should succeed");
    assert(threadInfo.stdout.includes("\"messageCount\": 2"), "thread info should include message counts");

    const threadSearch = await capture(["thread", "search", "CLI Smoke"]);
    assert.equal(threadSearch.code, 0, "thread search should succeed");
    assert(threadSearch.stdout.includes(session.id), "thread search should find the seeded session");

    const threadNew = await capture(["thread", "new", "Disposable CLI Thread"]);
    assert.equal(threadNew.code, 0, "thread new should succeed");
    const newThreadPayload = JSON.parse(threadNew.stdout) as { id: string; title: string };
    assert(newThreadPayload.id, "thread new should return a session id");

    const threadDelete = await capture(["thread", "delete", newThreadPayload.id]);
    assert.equal(threadDelete.code, 0, "thread delete should succeed");
    assert(threadDelete.stdout.includes(newThreadPayload.id), "thread delete should return the deleted session id");

    const planCreate = await capture([
      "plan",
      "create",
      "CLI migration plan",
      "--goal",
      "Keep the skills rollout structured before execution.",
      "--steps",
      "Draft plan,Approve plan,Archive plan",
      "--session",
      session.id,
    ]);
    assert.equal(planCreate.code, 0, "plan create should succeed");
    const createdPlan = JSON.parse(planCreate.stdout) as { id: string; status: string; steps: string[]; sessionId: string | null };
    assert.equal(createdPlan.status, "draft", "plan create should return a draft plan");
    assert.equal(createdPlan.sessionId, session.id, "plan create should preserve the selected session");
    assert.equal(createdPlan.steps.length, 3, "plan create should persist checklist steps");

    const planUpdate = await capture([
      "plan",
      "update",
      createdPlan.id,
      "--steps",
      "Draft plan,Review plan,Approve plan,Archive plan",
    ]);
    assert.equal(planUpdate.code, 0, "plan update should succeed");
    assert(planUpdate.stdout.includes("\"Review plan\""), "plan update should overwrite the step list");

    const planShow = await capture(["plan", "show", createdPlan.id]);
    assert.equal(planShow.code, 0, "plan show should succeed");
    assert(planShow.stdout.includes("\"status\": \"draft\""), "plan show should return the current plan");

    const planList = await capture(["plan", "all"]);
    assert.equal(planList.code, 1, "unknown shorthand should fail cleanly");

    const planListAll = await capture(["plan", "list", "all"]);
    assert.equal(planListAll.code, 0, "plan list all should succeed");
    assert(planListAll.stdout.includes(createdPlan.id), "plan list all should include the created plan");

    const planApprove = await capture(["plan", "approve", createdPlan.id]);
    assert.equal(planApprove.code, 0, "plan approve should succeed");
    assert(planApprove.stdout.includes("\"status\": \"approved\""), "plan approve should mark the plan approved");

    const planArchive = await capture(["plan", "archive", createdPlan.id]);
    assert.equal(planArchive.code, 0, "plan archive should succeed");
    assert(planArchive.stdout.includes("\"status\": \"archived\""), "plan archive should archive the plan");

    const cronRunAt = new Date(Date.now() + 1200).toISOString();
    const cronAdd = await capture([
      "cron",
      "add",
      "CLI",
      "scheduler",
      "smoke",
      "at",
      cronRunAt,
      "--prompt",
      "Write a one-line scheduled reminder for the CLI smoke session.",
      "--session",
      session.id,
    ]);
    assert.equal(cronAdd.code, 0, "cron add should succeed");
    const cronPayload = JSON.parse(cronAdd.stdout) as { id: string; status: string; sessionId: string | null };
    assert.equal(cronPayload.status, "active", "cron add should create an active schedule");
    assert.equal(cronPayload.sessionId, session.id, "cron add should keep the explicit target session");

    const cronList = await capture(["cron", "list"]);
    assert.equal(cronList.code, 0, "cron list should succeed");
    assert(cronList.stdout.includes(cronPayload.id), "cron list should include the created schedule");

    let scheduledMessageSeen = false;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const scheduledThreadInfo = await capture(["thread", "info", session.id]);
      assert.equal(scheduledThreadInfo.code, 0, "thread info after cron should succeed");
      if (scheduledThreadInfo.stdout.includes("[Scheduled task: CLI scheduler smoke]")) {
        scheduledMessageSeen = true;
        break;
      }
    }
    assert.equal(scheduledMessageSeen, true, "scheduler should inject the scheduled prompt into the target session");

    const cronRemove = await capture(["cron", "remove", cronPayload.id]);
    assert.equal(cronRemove.code, 0, "cron remove should succeed");
    assert(cronRemove.stdout.includes(cronPayload.id), "cron remove should echo the removed schedule id");

    const uploadPath = join(tempDataDir, "cli-upload.txt");
    writeFileSync(uploadPath, "cli upload smoke", "utf8");
    const sendFile = await capture(["send", "file", uploadPath, "CLI upload", "--session", session.id]);
    assert.equal(sendFile.code, 0, "send file should succeed");
    assert(sendFile.stdout.includes("\"fileName\": \"cli-upload.txt\""), "send file should report the uploaded attachment");

    const postUploadThreadInfo = await capture(["thread", "info", session.id]);
    assert.equal(postUploadThreadInfo.code, 0, "thread info after send should succeed");
    const postUploadThreadPayload = JSON.parse(postUploadThreadInfo.stdout) as { attachmentCount: number; messageCount: number };
    assert(postUploadThreadPayload.attachmentCount >= 1, "send file should attach to the selected session");
    assert(postUploadThreadPayload.messageCount >= 2, "send file should create a new message");

    const taskAdd = await capture([
      "tasks",
      "add",
      "Finish tracked task smoke",
      "--detail",
      "Drive the new tracked-task API through the CLI.",
      "--steps",
      "Create task,Update task,Mark done",
    ]);
    assert.equal(taskAdd.code, 0, "tasks add should succeed");
    const addedTask = JSON.parse(taskAdd.stdout) as { id: string; taskType: string; detail: string };
    assert.equal(addedTask.taskType, "tracked-task", "tasks add should create a tracked-task");
    assert(addedTask.detail.includes("Create task"), "tracked-task detail should include parsed steps");

    const taskUpdate = await capture([
      "tasks",
      "update",
      addedTask.id,
      "--step",
      "2",
      "--status",
      "done",
    ]);
    assert.equal(taskUpdate.code, 0, "tasks update should succeed");
    assert(taskUpdate.stdout.includes("- [x] Update task"), "tasks update should mark the requested step done");

    const taskShow = await capture(["tasks", "show", addedTask.id]);
    assert.equal(taskShow.code, 0, "tasks show should succeed");
    assert(taskShow.stdout.includes("\"taskType\": \"tracked-task\""), "tasks show should return the tracked task");

    const taskList = await capture(["tasks", "list", "all"]);
    assert.equal(taskList.code, 0, "tasks list should succeed");
    assert(taskList.stdout.includes(addedTask.id), "tasks list should include the tracked task");

    const taskDone = await capture(["tasks", "done", addedTask.id]);
    assert.equal(taskDone.code, 0, "tasks done should succeed");
    assert(taskDone.stdout.includes("\"status\": \"done\""), "tasks done should mark the task done");

    const taskDelete = await capture(["tasks", "delete", addedTask.id]);
    assert.equal(taskDelete.code, 0, "tasks delete should succeed");
    assert(taskDelete.stdout.includes(addedTask.id), "tasks delete should return the deleted task");

    const memoryDelete = await capture(["memory", "delete", addedMemory.id]);
    assert.equal(memoryDelete.code, 0, "memory delete should succeed");
    assert(memoryDelete.stdout.includes(addedMemory.id), "memory delete should echo the deleted id");

    console.log(
      JSON.stringify(
        {
          ok: true,
          tempDataDir,
          sessionId: session.id,
          memoryId: addedMemory.id,
          taskId: addedTask.id,
          uploadPath,
        },
        null,
        2,
      ),
    );
  } finally {
    delete process.env.ALICELOOP_DAEMON_URL;
    delete process.env.ALICELOOP_PROVIDER_KEYCHAIN_SERVICE;
    delete process.env.ALICELOOP_SCHEDULER_POLL_MS;
    await new Promise((resolve, reject) => imageBackend.close((error) => (error ? reject(error) : resolve(undefined))));
    await server.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
