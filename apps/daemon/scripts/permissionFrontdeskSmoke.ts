import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-permission-frontdesk-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const [
    { createPermissionSandboxExecutor },
    { createAgentPermissionFrontdesk, createDefaultAgentPermissionContext },
    {
      ToolApprovalRejectedError,
      approveSessionToolApproval,
      rejectSessionToolApproval,
      requestSessionToolApproval,
    },
    { listPendingToolApprovals },
    { createSession },
    { getRuntimeSettings, updateRuntimeSettings },
  ] = await Promise.all([
    import("../src/services/sandboxExecutor.ts"),
    import("../src/services/agentPermissionFrontdesk.ts"),
    import("../src/services/sessionToolApprovalService.ts"),
    import("../src/services/toolApprovalBroker.ts"),
    import("../src/repositories/sessionRepository.ts"),
    import("../src/repositories/runtimeSettingsRepository.ts"),
  ]);

  const workspaceRoot = join(tempDataDir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });

  const sourcePath = join(workspaceRoot, "source.txt");
  const bypassWritePath = join(workspaceRoot, "bypass-note.txt");
  const bypassDeletePath = join(workspaceRoot, "bypass-delete.txt");
  const rememberedWritePath = join(workspaceRoot, "remembered-write.txt");
  const rememberedBashPath = join(workspaceRoot, "remembered-bash.txt");
  const deniedBashPath = join(workspaceRoot, "denied-bash.txt");

  writeFileSync(sourcePath, "source\n", "utf8");
  writeFileSync(bypassDeletePath, "delete me\n", "utf8");
  writeFileSync(rememberedBashPath, "remember bash\n", "utf8");
  writeFileSync(deniedBashPath, "deny bash\n", "utf8");

  const sessionId = createSession("permission-frontdesk-smoke").id;
  const emptyRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  function updateAskRules(ask: Array<{ toolName: "write" | "bash"; pathPrefix?: string; commandPrefix?: string }>) {
    const currentRules = getRuntimeSettings().toolPermissionRules;
    updateRuntimeSettings({
      sandboxProfile: "full-access",
      autoApproveToolRequests: false,
      toolPermissionRules: {
        allow: currentRules.allow,
        deny: currentRules.deny,
        ask,
      },
    });
  }

  function buildSandbox(label: string) {
    const runtimeSettings = getRuntimeSettings();
    const abortController = new AbortController();
    const baseSandbox = createPermissionSandboxExecutor({
      label,
      permissionProfile: "full-access",
      autoApproveToolRequests: runtimeSettings.autoApproveToolRequests,
      workspaceRoot,
      defaultCwd: workspaceRoot,
      extraReadRoots: [workspaceRoot],
      extraWriteRoots: [workspaceRoot],
      extraCwdRoots: [workspaceRoot],
      allowedCommands: ["cat"],
      requestElevatedApproval: (input) => requestSessionToolApproval({
        sessionId,
        abortSignal: abortController.signal,
        ...input,
      }),
    });

    return createAgentPermissionFrontdesk(baseSandbox, {
      sessionId,
      abortSignal: abortController.signal,
      permissionContext: createDefaultAgentPermissionContext({
        mode: runtimeSettings.autoApproveToolRequests
          ? "bypassPermissions"
          : "auto",
        rules: runtimeSettings.toolPermissionRules,
      }),
    });
  }

  async function waitForApproval(
    predicate: (approval: { id: string; toolName: string; args: string[]; commandLine: string }) => boolean,
  ) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const approval = listPendingToolApprovals(sessionId).find(predicate);
      if (approval) {
        return approval;
      }
      await sleep(20);
    }

    throw new Error("Timed out waiting for tool approval");
  }

  async function expectNoPendingApprovals() {
    await sleep(20);
    assert.equal(listPendingToolApprovals(sessionId).length, 0, "expected no pending tool approvals");
  }

  updateRuntimeSettings({
    sandboxProfile: "full-access",
    autoApproveToolRequests: true,
    toolPermissionRules: emptyRules,
  });

  const bypassSandbox = buildSandbox("permission-frontdesk-bypass");
  let bypassPromptCount = 0;

  const bypassRead = await bypassSandbox.readTextFile({
    targetPath: sourcePath,
  });
  assert.equal(bypassRead, "source\n");

  await bypassSandbox.writeTextFile({
    targetPath: bypassWritePath,
    content: "bypass write\n",
    approvalStateTracker: {
      onRequested() {
        bypassPromptCount += 1;
      },
    },
  });
  assert.equal(readFileSync(bypassWritePath, "utf8"), "bypass write\n");

  await bypassSandbox.editTextFile({
    targetPath: bypassWritePath,
    transform: (content) => content.replace("write", "edit"),
    approvalStateTracker: {
      onRequested() {
        bypassPromptCount += 1;
      },
    },
  });
  assert.equal(readFileSync(bypassWritePath, "utf8"), "bypass edit\n");

  const bypassBash = await bypassSandbox.runBash({
    command: "cat",
    args: [bypassWritePath],
    cwd: workspaceRoot,
    approvalStateTracker: {
      onRequested() {
        bypassPromptCount += 1;
      },
    },
  });
  assert.equal(bypassBash.stdout, "bypass edit\n");
  assert.equal(bypassPromptCount, 0, "full-access should not prompt for read/write/edit/bash");
  await expectNoPendingApprovals();

  let deletePromptCount = 0;
  await bypassSandbox.deletePath({
    targetPath: bypassDeletePath,
    approvalStateTracker: {
      onRequested() {
        deletePromptCount += 1;
      },
    },
  });
  assert.equal(deletePromptCount, 0, "full-access should not prompt for delete");
  assert.equal(existsSync(bypassDeletePath), false, "full-access delete should remove the file immediately");
  await expectNoPendingApprovals();

  updateAskRules([{ toolName: "write", pathPrefix: rememberedWritePath }]);
  const autoWriteSandbox = buildSandbox("permission-frontdesk-auto-write");
  const rememberWritePromise = autoWriteSandbox.writeTextFile({
    targetPath: rememberedWritePath,
    content: "remember write\n",
  });
  const rememberWriteApproval = await waitForApproval((approval) => approval.toolName === "write" && approval.args[0] === rememberedWritePath);
  approveSessionToolApproval(sessionId, rememberWriteApproval.id, null, "allow_always");
  await rememberWritePromise;
  assert.equal(readFileSync(rememberedWritePath, "utf8"), "remember write\n");
  assert.equal(
    getRuntimeSettings().toolPermissionRules.allow.some((rule) => rule.toolName === "write" && rule.pathPrefix === rememberedWritePath),
    true,
    "allow_always should persist a write rule",
  );
  await expectNoPendingApprovals();

  let rememberedWritePromptCount = 0;
  const rememberedWriteSandbox = buildSandbox("permission-frontdesk-auto-write-remembered");
  await rememberedWriteSandbox.writeTextFile({
    targetPath: rememberedWritePath,
    content: "remember write again\n",
    approvalStateTracker: {
      onRequested() {
        rememberedWritePromptCount += 1;
      },
    },
  });
  assert.equal(readFileSync(rememberedWritePath, "utf8"), "remember write again\n");
  assert.equal(rememberedWritePromptCount, 0, "remembered write rule should remove the second prompt");
  await expectNoPendingApprovals();

  updateAskRules([{ toolName: "bash", commandPrefix: `cat ${rememberedBashPath}` }]);
  const autoBashSandbox = buildSandbox("permission-frontdesk-auto-bash");
  const rememberBashPromise = autoBashSandbox.runBash({
    command: "cat",
    args: [rememberedBashPath],
    cwd: workspaceRoot,
  });
  const rememberBashApproval = await waitForApproval((approval) => approval.toolName === "bash" && approval.commandLine === `cat ${rememberedBashPath}`);
  approveSessionToolApproval(sessionId, rememberBashApproval.id, null, "allow_always");
  const rememberedBashResult = await rememberBashPromise;
  assert.equal(rememberedBashResult.stdout, "remember bash\n");
  assert.equal(
    getRuntimeSettings().toolPermissionRules.allow.some((rule) => rule.toolName === "bash" && rule.commandPrefix === `cat ${rememberedBashPath}`),
    true,
    "allow_always should persist a bash rule",
  );
  await expectNoPendingApprovals();

  let rememberedBashPromptCount = 0;
  const rememberedBashSandbox = buildSandbox("permission-frontdesk-auto-bash-remembered");
  const rememberedBashReplay = await rememberedBashSandbox.runBash({
    command: "cat",
    args: [rememberedBashPath],
    cwd: workspaceRoot,
    approvalStateTracker: {
      onRequested() {
        rememberedBashPromptCount += 1;
      },
    },
  });
  assert.equal(rememberedBashReplay.stdout, "remember bash\n");
  assert.equal(rememberedBashPromptCount, 0, "remembered bash rule should remove the second prompt");
  await expectNoPendingApprovals();

  updateAskRules([{ toolName: "bash", commandPrefix: `cat ${deniedBashPath}` }]);
  const autoDenySandbox = buildSandbox("permission-frontdesk-auto-bash-deny");
  const denyBashPromise = autoDenySandbox.runBash({
    command: "cat",
    args: [deniedBashPath],
    cwd: workspaceRoot,
  }).then(
    () => {
      throw new Error("deny_always should reject the first command after approval");
    },
    (error) => error,
  );
  const denyBashApproval = await waitForApproval((approval) => approval.toolName === "bash" && approval.commandLine === `cat ${deniedBashPath}`);
  rejectSessionToolApproval(sessionId, denyBashApproval.id, null, "deny_always");
  const deniedBashError = await denyBashPromise;
  assert(deniedBashError instanceof ToolApprovalRejectedError, "deny_always should reject the pending bash request");
  assert.equal(
    getRuntimeSettings().toolPermissionRules.deny.some((rule) => rule.toolName === "bash" && rule.commandPrefix === `cat ${deniedBashPath}`),
    true,
    "deny_always should persist a bash deny rule",
  );
  await expectNoPendingApprovals();

  let immediateDenyPromptCount = 0;
  try {
    const rememberedDenySandbox = buildSandbox("permission-frontdesk-auto-bash-denied");
    await rememberedDenySandbox.runBash({
      command: "cat",
      args: [deniedBashPath],
      cwd: workspaceRoot,
      approvalStateTracker: {
        onRequested() {
          immediateDenyPromptCount += 1;
        },
      },
    });
    assert.fail("deny_always should reject the repeated bash command immediately");
  } catch (error) {
    assert(error instanceof ToolApprovalRejectedError, "deny_always should reject with ToolApprovalRejectedError");
  }
  assert.equal(immediateDenyPromptCount, 0, "remembered deny rule should not create another approval");
  await expectNoPendingApprovals();

  console.log(JSON.stringify({
    ok: true,
    tempDataDir,
    sessionId,
    bypassPermissions: {
      autoPassed: ["read", "write", "edit", "bash", "delete"],
      prompted: [],
    },
    autoMode: {
      allow: ["write", "bash"],
      deny: ["bash"],
    },
    rememberedRules: {
      allow: ["write", "bash"],
      deny: ["bash"],
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
