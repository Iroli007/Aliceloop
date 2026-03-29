import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "../..");
const sourcePackageDir = join(repoRoot, "node_modules", "better-sqlite3");
const electronVersion = "37.10.3";

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

export default async function afterPack(context) {
  const appBundles = (await readdir(context.appOutDir)).filter((entry) => entry.endsWith(".app"));
  const appBundleName = appBundles[0];

  if (!appBundleName) {
    return;
  }

  const targetBinary = join(
    context.appOutDir,
    appBundleName,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );

  try {
    await stat(targetBinary);
  } catch {
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "aliceloop-electron-native-"));

  try {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "aliceloop-electron-native",
      private: true,
      version: "1.0.0",
    }));
    await mkdir(join(tempDir, "node_modules"), { recursive: true });
    await cp(sourcePackageDir, join(tempDir, "node_modules", "better-sqlite3"), { recursive: true });
    await run("npm", ["rebuild", "better-sqlite3"], {
      cwd: tempDir,
      env: {
        ...process.env,
        npm_config_build_from_source: "true",
        npm_config_disturl: "https://electronjs.org/headers",
        npm_config_runtime: "electron",
        npm_config_target: electronVersion,
      },
    });

    await cp(
      join(tempDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
      targetBinary,
      { force: true },
    );
    console.info("[aliceloop-desktop] patched packaged native module", JSON.stringify({ targetBinary }));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
