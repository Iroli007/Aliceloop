import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    { createAgentPermissionFrontdesk, createDefaultAgentPermissionContext, decideAgentPermission },
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

  const outsideWorkspaceReadPath = join(tempDataDir, "outside-read.txt");
  const outsideWorkspaceWritePath = join(tempDataDir, "outside-write.txt");
  const sourcePath = join(workspaceRoot, "source.txt");
  const scriptRedirectPath = join(workspaceRoot, "script-redirect.txt");
  const bypassSensitiveEnvPath = join(workspaceRoot, ".env");
  const bypassWritePath = join(workspaceRoot, "bypass-note.txt");
  const bypassDeletePath = join(workspaceRoot, "bypass-delete.txt");
  const bypassDangerDir = join(workspaceRoot, "bypass-danger-dir");
  const autoRiskDeletePath = join(workspaceRoot, "auto-risk-delete.txt");
  const autoWrappedDeletePath = join(workspaceRoot, "auto-wrapped-delete.txt");
  const rememberedWritePath = join(workspaceRoot, "remembered-write.txt");
  const rememberedBashPath = join(workspaceRoot, "remembered-bash.txt");
  const deniedBashPath = join(workspaceRoot, "denied-bash.txt");
  const gitWorkspace = join(workspaceRoot, "git-prefix-memory");

  writeFileSync(outsideWorkspaceReadPath, "outside\n", "utf8");
  writeFileSync(sourcePath, "source\n", "utf8");
  writeFileSync(bypassDeletePath, "delete me\n", "utf8");
  mkdirSync(bypassDangerDir, { recursive: true });
  writeFileSync(join(bypassDangerDir, "nested.txt"), "danger\n", "utf8");
  writeFileSync(autoRiskDeletePath, "risk me\n", "utf8");
  writeFileSync(autoWrappedDeletePath, "wrap me\n", "utf8");
  writeFileSync(rememberedBashPath, "remember bash\n", "utf8");
  writeFileSync(deniedBashPath, "deny bash\n", "utf8");
  mkdirSync(gitWorkspace, { recursive: true });
  execFileSync("git", ["init"], { cwd: gitWorkspace });
  execFileSync("git", ["config", "user.name", "Aliceloop Smoke"], { cwd: gitWorkspace });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: gitWorkspace });

  const sessionId = createSession("permission-frontdesk-smoke").id;
  const emptyRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  function updateAskRules(ask: Array<{ toolName: "read" | "write" | "delete" | "bash"; pathPrefix?: string; commandPrefix?: string }>) {
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
        workspaceRoots: [workspaceRoot],
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

  const bypassSensitiveWritePromise = bypassSandbox.writeTextFile({
    targetPath: bypassSensitiveEnvPath,
    content: "TOKEN=first\n",
  });
  const bypassSensitiveWriteApproval = await waitForApproval((approval) => approval.toolName === "write" && approval.args[0] === bypassSensitiveEnvPath);
  approveSessionToolApproval(sessionId, bypassSensitiveWriteApproval.id, null, "allow_always");
  await bypassSensitiveWritePromise;
  assert.equal(readFileSync(bypassSensitiveEnvPath, "utf8"), "TOKEN=first\n");
  assert.equal(
    getRuntimeSettings().toolPermissionRules.allow.some((rule) => rule.toolName === "write" && rule.pathPrefix === bypassSensitiveEnvPath),
    true,
    "allow_always should still persist a sensitive write rule",
  );
  await expectNoPendingApprovals();

  let bypassSensitiveWriteReplayPromptCount = 0;
  const bypassSensitiveReplaySandbox = buildSandbox("permission-frontdesk-bypass-sensitive-replay");
  const bypassSensitiveReplayPromise = bypassSensitiveReplaySandbox.writeTextFile({
    targetPath: bypassSensitiveEnvPath,
    content: "TOKEN=second\n",
    approvalStateTracker: {
      onRequested() {
        bypassSensitiveWriteReplayPromptCount += 1;
      },
    },
  });
  const bypassSensitiveReplayApproval = await waitForApproval((approval) => approval.toolName === "write" && approval.args[0] === bypassSensitiveEnvPath);
  approveSessionToolApproval(sessionId, bypassSensitiveReplayApproval.id, null, "allow_once");
  await bypassSensitiveReplayPromise;
  assert.equal(readFileSync(bypassSensitiveEnvPath, "utf8"), "TOKEN=second\n");
  assert.equal(bypassSensitiveWriteReplayPromptCount, 1, "sensitive writes should still prompt even after allow_always");
  await expectNoPendingApprovals();

  let bypassDangerousBashPromptCount = 0;
  const bypassDangerousBashPromise = bypassSandbox.runBash({
    command: "rm",
    args: ["-rf", bypassDangerDir],
    cwd: workspaceRoot,
    approvalStateTracker: {
      onRequested() {
        bypassDangerousBashPromptCount += 1;
      },
    },
  });
  const bypassDangerousBashApproval = await waitForApproval((approval) => approval.toolName === "bash" && approval.commandLine === `rm -rf ${bypassDangerDir}`);
  approveSessionToolApproval(sessionId, bypassDangerousBashApproval.id, null, "allow_once");
  await bypassDangerousBashPromise;
  assert.equal(bypassDangerousBashPromptCount, 1, "full-access should still prompt for strict safety bash commands");
  assert.equal(existsSync(bypassDangerDir), false, "approved strict safety bash command should still run");
  await expectNoPendingApprovals();

  updateRuntimeSettings({
    sandboxProfile: "full-access",
    autoApproveToolRequests: false,
    toolPermissionRules: emptyRules,
  });

  const autoSafeSandbox = buildSandbox("permission-frontdesk-auto-safe");
  let autoSafePromptCount = 0;
  const autoSafeBash = await autoSafeSandbox.runBash({
    command: "cat",
    args: [sourcePath],
    cwd: workspaceRoot,
    approvalStateTracker: {
      onRequested() {
        autoSafePromptCount += 1;
      },
    },
  });
  assert.equal(autoSafeBash.stdout, "source\n");
  assert.equal(autoSafePromptCount, 0, "auto mode should not prompt for safe read-only bash");
  await expectNoPendingApprovals();

  const autoPipelineSandbox = buildSandbox("permission-frontdesk-auto-pipeline");
  let autoPipelinePromptCount = 0;
  const autoPipelineBash = await autoPipelineSandbox.runBash({
    command: "sh",
    script: `cat ${sourcePath} | wc -l`,
    cwd: workspaceRoot,
    approvalStateTracker: {
      onRequested() {
        autoPipelinePromptCount += 1;
      },
    },
  });
  assert.equal(autoPipelineBash.stdout.trim(), "1");
  assert.equal(autoPipelinePromptCount, 0, "auto mode should not prompt for workspace read-only pipelines");
  await expectNoPendingApprovals();

  const secondLayerWriteDecision = decideAgentPermission(
    createDefaultAgentPermissionContext({
      mode: "auto",
      rules: emptyRules,
      workspaceRoots: [workspaceRoot],
    }),
    {
      toolName: "write",
      targetPath: join(workspaceRoot, "second-layer-write.txt"),
    },
  );
  assert.equal(secondLayerWriteDecision.behavior, "allow", "workspace writes should be handled by the second-layer self-allow");
  assert.equal(secondLayerWriteDecision.reason, "Allowed by tool self-allow check for write");

  const secondLayerBashDecision = decideAgentPermission(
    createDefaultAgentPermissionContext({
      mode: "auto",
      rules: emptyRules,
      workspaceRoots: [workspaceRoot],
    }),
    {
      toolName: "bash",
      command: "cat",
      args: [sourcePath],
      cwd: workspaceRoot,
    },
  );
  assert.equal(secondLayerBashDecision.behavior, "allow", "workspace read-only bash should be handled by the second-layer self-allow");
  assert.equal(secondLayerBashDecision.reason, "Allowed by tool self-allow check for bash");

  const secondLayerPipelineDecision = decideAgentPermission(
    createDefaultAgentPermissionContext({
      mode: "auto",
      rules: emptyRules,
      workspaceRoots: [workspaceRoot],
    }),
    {
      toolName: "bash",
      command: "sh",
      script: `cat ${sourcePath} | wc -l`,
      cwd: workspaceRoot,
    },
  );
  assert.equal(secondLayerPipelineDecision.behavior, "allow", "workspace read-only bash pipelines should be handled by the second-layer self-allow");
  assert.equal(secondLayerPipelineDecision.reason, "Allowed by tool self-allow check for bash");

  const firstLayerSensitiveRedirectDecision = decideAgentPermission(
    createDefaultAgentPermissionContext({
      mode: "bypassPermissions",
      rules: emptyRules,
      workspaceRoots: [workspaceRoot],
    }),
    {
      toolName: "bash",
      command: "sh",
      script: "printf token > .npmrc",
      cwd: workspaceRoot,
    },
  );
  assert.equal(firstLayerSensitiveRedirectDecision.behavior, "ask", "tool-level content ask should catch sensitive bash redirect targets");
  assert.equal(firstLayerSensitiveRedirectDecision.reason, "Tool content ask requires approval for write to sensitive path");

  const secondLayerRedirectDecision = decideAgentPermission(
    createDefaultAgentPermissionContext({
      mode: "auto",
      rules: emptyRules,
      workspaceRoots: [workspaceRoot],
    }),
    {
      toolName: "bash",
      command: "sh",
      script: `cat ${sourcePath} > ${scriptRedirectPath}`,
      cwd: workspaceRoot,
    },
  );
  assert.equal(secondLayerRedirectDecision.behavior, "ask", "workspace bash write redirects should fall through and require approval");
  assert.equal(secondLayerRedirectDecision.reason, "Auto mode requires approval for bash outside tool self-allow");

  const secondLayerComplexScriptDecision = decideAgentPermission(
    createDefaultAgentPermissionContext({
      mode: "auto",
      rules: emptyRules,
      workspaceRoots: [workspaceRoot],
    }),
    {
      toolName: "bash",
      command: "sh",
      script: "cat $(pwd)/source.txt",
      cwd: workspaceRoot,
    },
  );
  assert.equal(secondLayerComplexScriptDecision.behavior, "ask", "complex bash syntax should fail closed back to approval");
  assert.equal(secondLayerComplexScriptDecision.reason, "Auto mode requires approval for bash outside tool self-allow");

  let autoRedirectPromptCount = 0;
  const autoRedirectSandbox = buildSandbox("permission-frontdesk-auto-script-redirect");
  const autoRedirectPromise = autoRedirectSandbox.runBash({
    command: "sh",
    script: `cat ${sourcePath} > ${scriptRedirectPath}`,
    cwd: workspaceRoot,
    approvalStateTracker: {
      onRequested() {
        autoRedirectPromptCount += 1;
      },
    },
  });
  const autoRedirectApproval = await waitForApproval((approval) => approval.toolName === "bash" && approval.commandLine === `cat ${sourcePath} > ${scriptRedirectPath}`);
  approveSessionToolApproval(sessionId, autoRedirectApproval.id, null, "allow_once");
  await autoRedirectPromise;
  assert.equal(readFileSync(scriptRedirectPath, "utf8"), "source\n");
  assert.equal(autoRedirectPromptCount, 1, "auto mode should prompt for bash write redirects outside second-layer self-allow");
  await expectNoPendingApprovals();

  let outsideReadPromptCount = 0;
  const outsideReadSandbox = buildSandbox("permission-frontdesk-auto-read-outside-workspace");
  const outsideReadPromise = outsideReadSandbox.readTextFile({
    targetPath: outsideWorkspaceReadPath,
    approvalStateTracker: {
      onRequested() {
        outsideReadPromptCount += 1;
      },
    },
  });
  const outsideReadApproval = await waitForApproval((approval) => approval.toolName === "read" && approval.args[0] === outsideWorkspaceReadPath);
  approveSessionToolApproval(sessionId, outsideReadApproval.id, null, "allow_once");
  const outsideReadResult = await outsideReadPromise;
  assert.equal(outsideReadResult, "outside\n");
  assert.equal(outsideReadPromptCount, 1, "auto mode should prompt for reads outside workspace roots");
  await expectNoPendingApprovals();

  let outsideWritePromptCount = 0;
  const outsideWriteSandbox = buildSandbox("permission-frontdesk-auto-write-outside-workspace");
  const outsideWritePromise = outsideWriteSandbox.writeTextFile({
    targetPath: outsideWorkspaceWritePath,
    content: "outside write\n",
    approvalStateTracker: {
      onRequested() {
        outsideWritePromptCount += 1;
      },
    },
  });
  const outsideWriteApproval = await waitForApproval((approval) => approval.toolName === "write" && approval.args[0] === outsideWorkspaceWritePath);
  approveSessionToolApproval(sessionId, outsideWriteApproval.id, null, "allow_once");
  await outsideWritePromise;
  assert.equal(readFileSync(outsideWorkspaceWritePath, "utf8"), "outside write\n");
  assert.equal(outsideWritePromptCount, 1, "auto mode should prompt for writes outside workspace roots");
  await expectNoPendingApprovals();

  updateAskRules([{ toolName: "read", pathPrefix: sourcePath }]);
  const autoReadSandbox = buildSandbox("permission-frontdesk-auto-read");
  let autoReadPromptCount = 0;
  const autoReadPromise = autoReadSandbox.readTextFile({
    targetPath: sourcePath,
    approvalStateTracker: {
      onRequested() {
        autoReadPromptCount += 1;
      },
    },
  });
  const autoReadApproval = await waitForApproval((approval) => approval.toolName === "read" && approval.args[0] === sourcePath);
  approveSessionToolApproval(sessionId, autoReadApproval.id, null, "allow_once");
  const autoReadResult = await autoReadPromise;
  assert.equal(autoReadResult, "source\n");
  assert.equal(autoReadPromptCount, 1, "explicit read ask rule should override read-only auto-allow");
  await expectNoPendingApprovals();

  updateAskRules([{ toolName: "delete", pathPrefix: bypassWritePath }]);
  const autoDeleteSandbox = buildSandbox("permission-frontdesk-auto-delete");
  let autoDeletePromptCount = 0;
  const autoDeletePromise = autoDeleteSandbox.deletePath({
    targetPath: bypassWritePath,
    approvalStateTracker: {
      onRequested() {
        autoDeletePromptCount += 1;
      },
    },
  });
  const autoDeleteApproval = await waitForApproval((approval) => approval.toolName === "delete" && approval.args[0] === bypassWritePath);
  approveSessionToolApproval(sessionId, autoDeleteApproval.id, null, "allow_once");
  await autoDeletePromise;
  assert.equal(autoDeletePromptCount, 1, "explicit delete ask rule should create a delete approval");
  assert.equal(existsSync(bypassWritePath), false, "approved delete ask rule should remove the file");
  await expectNoPendingApprovals();

  writeFileSync(bypassWritePath, "restored after delete ask\n", "utf8");
  updateAskRules([]);

  const autoRiskSandbox = buildSandbox("permission-frontdesk-auto-risk");
  let autoRiskPromptCount = 0;
  const autoRiskPromise = autoRiskSandbox.runBash({
    command: "rm",
    args: ["-f", autoRiskDeletePath],
    cwd: workspaceRoot,
    approvalStateTracker: {
      onRequested() {
        autoRiskPromptCount += 1;
      },
    },
  });
  const autoRiskApproval = await waitForApproval((approval) => approval.toolName === "bash" && approval.commandLine === `rm -f ${autoRiskDeletePath}`);
  approveSessionToolApproval(sessionId, autoRiskApproval.id, null, "allow_once");
  await autoRiskPromise;
  assert.equal(autoRiskPromptCount, 1, "auto mode should prompt for destructive rm");
  assert.equal(existsSync(autoRiskDeletePath), false, "approved auto rm should remove the file");
  await expectNoPendingApprovals();

  const autoWrappedSandbox = buildSandbox("permission-frontdesk-auto-wrapped");
  let autoWrappedPromptCount = 0;
  const autoWrappedPromise = autoWrappedSandbox.runBash({
    command: "sh",
    script: `MY_VAR=1 rm -f ${autoWrappedDeletePath}`,
    cwd: workspaceRoot,
    approvalStateTracker: {
      onRequested() {
        autoWrappedPromptCount += 1;
      },
    },
  });
  const autoWrappedApproval = await waitForApproval((approval) => approval.toolName === "bash" && approval.commandLine === `MY_VAR=1 rm -f ${autoWrappedDeletePath}`);
  approveSessionToolApproval(sessionId, autoWrappedApproval.id, null, "allow_once");
  await autoWrappedPromise;
  assert.equal(autoWrappedPromptCount, 1, "auto mode should prompt for env-assignment wrapped rm");
  assert.equal(existsSync(autoWrappedDeletePath), false, "approved wrapped rm should remove the file");
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

  updateAskRules([{ toolName: "bash", commandPrefix: "git commit" }]);
  const prefixMemorySandbox = buildSandbox("permission-frontdesk-auto-bash-prefix-memory");
  const rememberBashPrefixPromise = prefixMemorySandbox.runBash({
    command: "git",
    args: ["commit", "--allow-empty", "-m", "first"],
    cwd: gitWorkspace,
  });
  const rememberBashPrefixApproval = await waitForApproval((approval) => approval.toolName === "bash" && approval.commandLine.startsWith("git commit --allow-empty -m"));
  approveSessionToolApproval(sessionId, rememberBashPrefixApproval.id, null, "allow_always");
  await rememberBashPrefixPromise;
  assert.equal(
    getRuntimeSettings().toolPermissionRules.allow.some((rule) => rule.toolName === "bash" && rule.commandPrefix === "git commit"),
    true,
    "allow_always should persist a reusable git commit prefix rule",
  );
  await expectNoPendingApprovals();

  let rememberedBashPrefixPromptCount = 0;
  const rememberedBashPrefixSandbox = buildSandbox("permission-frontdesk-auto-bash-prefix-memory-replay");
  await rememberedBashPrefixSandbox.runBash({
    command: "git",
    args: ["commit", "--allow-empty", "-m", "second"],
    cwd: gitWorkspace,
    approvalStateTracker: {
      onRequested() {
        rememberedBashPrefixPromptCount += 1;
      },
    },
  });
  assert.equal(rememberedBashPrefixPromptCount, 0, "remembered git commit prefix rule should remove prompts for the same command family");
  await expectNoPendingApprovals();

  console.log(JSON.stringify({
    ok: true,
    tempDataDir,
    sessionId,
    bypassPermissions: {
      autoPassed: ["read", "write", "edit", "bash", "delete"],
      strictSafetyPrompted: ["write", "bash"],
    },
    autoMode: {
      allow: ["workspace write", "read-only workspace bash"],
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
