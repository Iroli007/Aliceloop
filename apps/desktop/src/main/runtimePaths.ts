import { app } from "electron";
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const publicRootDirName = "aliceloop";
const runtimeAssetsDirName = "runtime-assets";

export interface DesktopPublicPaths {
  publicRootDir: string;
  workspaceDir: string;
  skillsDir: string;
  scriptsDir: string;
  chromeExtensionDir: string;
}

export interface ManagedDesktopRuntimePaths extends DesktopPublicPaths {
  baseUrl: string;
  dataDir: string;
  promptsDir: string;
}

function resolveWorkspaceRoot() {
  return resolve(currentDir, "../../../..");
}

function getBundledRuntimeAssetsRoot() {
  if (app.isPackaged) {
    return join(process.resourcesPath, runtimeAssetsDirName);
  }

  const workspaceRoot = resolveWorkspaceRoot();
  return workspaceRoot;
}

function getPublicRootDir() {
  const override = process.env.ALICELOOP_PUBLIC_DIR?.trim();
  if (override) {
    return resolve(override);
  }

  return join(homedir(), publicRootDirName);
}

function getManagedDataDir() {
  return join(app.getPath("userData"), "daemon-data");
}

function buildPublicPaths(publicRootDir: string): DesktopPublicPaths {
  return {
    publicRootDir,
    workspaceDir: join(publicRootDir, "workspace"),
    skillsDir: join(publicRootDir, "skills"),
    scriptsDir: join(publicRootDir, "scripts"),
    chromeExtensionDir: join(publicRootDir, "chrome-extension"),
  };
}

async function replaceDirectory(sourceDir: string, targetDir: string) {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(dirname(targetDir), { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true, force: true });
}

export async function prepareManagedDesktopRuntime(): Promise<ManagedDesktopRuntimePaths> {
  const publicRootDir = getPublicRootDir();
  const runtimeAssetsRoot = getBundledRuntimeAssetsRoot();
  const publicPaths = buildPublicPaths(publicRootDir);

  await mkdir(publicRootDir, { recursive: true });
  await mkdir(publicPaths.workspaceDir, { recursive: true });
  await replaceDirectory(join(runtimeAssetsRoot, "chrome-extension"), publicPaths.chromeExtensionDir);
  await replaceDirectory(join(runtimeAssetsRoot, "skills"), publicPaths.skillsDir);
  await replaceDirectory(join(runtimeAssetsRoot, "scripts"), publicPaths.scriptsDir);

  return {
    ...publicPaths,
    baseUrl: "http://127.0.0.1:3030",
    dataDir: getManagedDataDir(),
    promptsDir: join(runtimeAssetsRoot, "prompts"),
  };
}

export function getDesktopPublicPaths() {
  if (app.isPackaged) {
    return buildPublicPaths(getPublicRootDir());
  }

  const workspaceRoot = resolveWorkspaceRoot();
  return {
    publicRootDir: workspaceRoot,
    workspaceDir: join(workspaceRoot, "apps", "daemon", ".data", "workspaces", "default"),
    skillsDir: join(workspaceRoot, "skills"),
    scriptsDir: join(workspaceRoot, "apps", "daemon", "runtime-scripts"),
    chromeExtensionDir: join(workspaceRoot, "chrome-extension"),
  };
}
