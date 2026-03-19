import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-sandbox-data-"));
  const externalDir = mkdtempSync(join(tmpdir(), "aliceloop-sandbox-ext-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const [{ createPermissionSandboxExecutor, SandboxViolationError }, { listSandboxRuns }] = await Promise.all([
    import("../src/services/sandboxExecutor.ts"),
    import("../src/repositories/sandboxRunRepository.ts"),
  ]);

  const sourcePath = join(externalDir, "source.txt");
  const outputPath = join(tempDataDir, "artifacts", "note.txt");
  const runtimeScriptPath = join(tempDataDir, "runtime-check.ts");

  writeFileSync(sourcePath, "alpha\nbeta\n", "utf8");
  writeFileSync(runtimeScriptPath, 'console.log("tsx-sandbox-ok");\n', "utf8");

  const sandbox = createPermissionSandboxExecutor({
    label: "sandbox-smoke",
    extraReadRoots: [externalDir, tempDataDir],
    extraWriteRoots: [join(tempDataDir, "artifacts")],
    extraCwdRoots: [tempDataDir],
    allowedCommands: ["cat", "tsx"],
  });

  const text = await sandbox.readTextFile({
    targetPath: sourcePath,
  });
  assert.equal(text, "alpha\nbeta\n");

  await sandbox.writeTextFile({
    targetPath: outputPath,
    content: text,
  });
  assert.equal(readFileSync(outputPath, "utf8"), "alpha\nbeta\n");

  const edited = await sandbox.editTextFile({
    targetPath: outputPath,
    transform: (content) => content.replace("beta", "gamma"),
  });
  assert.equal(edited, "alpha\ngamma\n");

  let approvalCount = 0;
  const approvedSandbox = createPermissionSandboxExecutor({
    label: "sandbox-smoke-approved",
    extraReadRoots: [tempDataDir],
    extraWriteRoots: [tempDataDir],
    extraCwdRoots: [tempDataDir],
    allowedCommands: ["cat"],
    requestBashApproval: async () => {
      approvalCount += 1;
    },
  });

  const approvedBash = await approvedSandbox.runBash({
    command: "cat",
    args: [outputPath],
    cwd: tempDataDir,
  });
  assert.equal(approvedBash.stdout, "alpha\ngamma\n");
  assert.equal(approvalCount, 1, "bash approval hook should run before command execution");

  const bashResult = await sandbox.runBash({
    command: "cat",
    args: [outputPath],
    cwd: tempDataDir,
  });
  assert.equal(bashResult.stdout, "alpha\ngamma\n");

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const tsxResult = await sandbox.runBash({
      command: "tsx",
      args: [runtimeScriptPath],
      cwd: tempDataDir,
    });
    assert(tsxResult.stdout.includes("tsx-sandbox-ok"), "sandbox should resolve tsx without relying on PATH");
  } finally {
    process.env.PATH = originalPath;
  }

  let blockedRead = false;
  try {
    await sandbox.readTextFile({
      targetPath: "/etc/hosts",
    });
  } catch (error) {
    blockedRead = error instanceof SandboxViolationError;
  }
  assert.equal(blockedRead, true, "sandbox should block reading /etc/hosts");

  let blockedBash = false;
  try {
    await sandbox.runBash({
      command: "cat",
      args: ["/etc/hosts"],
      cwd: tempDataDir,
    });
  } catch (error) {
    blockedBash = error instanceof SandboxViolationError;
  }
  assert.equal(blockedBash, true, "sandbox should block bash path arguments outside allowed roots");

  const fullAccessSandbox = createPermissionSandboxExecutor({
    label: "sandbox-smoke-full-access",
    permissionProfile: "full-access",
  });

  const hosts = await fullAccessSandbox.readTextFile({
    targetPath: "/etc/hosts",
  });
  assert(hosts.length > 0, "full access sandbox should read arbitrary host files");

  const fullAccessBash = await fullAccessSandbox.runBash({
    command: "/bin/echo",
    args: ["full-access-ok"],
    cwd: process.cwd(),
  });
  assert.equal(fullAccessBash.stdout.trim(), "full-access-ok");

  const logs = listSandboxRuns(20);
  assert(logs.some((run) => run.primitive === "read" && run.status === "done"), "read run should be logged");
  assert(logs.some((run) => run.primitive === "write" && run.status === "done"), "write run should be logged");
  assert(logs.some((run) => run.primitive === "edit" && run.status === "done"), "edit run should be logged");
  assert(logs.some((run) => run.primitive === "bash" && run.status === "done"), "bash run should be logged");
  assert(logs.some((run) => run.command === "tsx" && run.status === "done"), "tsx run should be logged");
  assert(logs.some((run) => run.status === "blocked"), "blocked run should be logged");

  console.log(
    JSON.stringify(
      {
        ok: true,
        tempDataDir,
        externalDir,
        logCount: logs.length,
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
