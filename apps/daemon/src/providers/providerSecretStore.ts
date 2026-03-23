import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderKind } from "@aliceloop/runtime-core";
import { getDataDir } from "../db/client";

const providerKeychainService = process.env.ALICELOOP_PROVIDER_KEYCHAIN_SERVICE?.trim()
  || "Aliceloop Provider Credentials";
const fallbackSecretsFilePath = join(getDataDir(), "provider-secrets.json");

interface ProviderSecretsFile {
  apiKeys?: Partial<Record<ProviderKind, string>>;
}

function getProviderSecretAccount(providerId: ProviderKind) {
  return `provider:${providerId}`;
}

function readFallbackSecrets(): ProviderSecretsFile {
  if (!existsSync(fallbackSecretsFilePath)) {
    return {};
  }

  try {
    const content = readFileSync(fallbackSecretsFilePath, "utf8");
    const parsed = JSON.parse(content) as ProviderSecretsFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeFallbackSecrets(next: ProviderSecretsFile) {
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(fallbackSecretsFilePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try {
    chmodSync(fallbackSecretsFilePath, 0o600);
  } catch {
    // Best effort only. Some filesystems do not support chmod.
  }
}

function runSecurityCommand(args: string[]) {
  return execFileSync("security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function readKeychainApiKey(providerId: ProviderKind) {
  try {
    const value = runSecurityCommand([
      "find-generic-password",
      "-a",
      getProviderSecretAccount(providerId),
      "-s",
      providerKeychainService,
      "-w",
    ]);
    return value || null;
  } catch {
    return null;
  }
}

function writeKeychainApiKey(providerId: ProviderKind, apiKey: string) {
  try {
    runSecurityCommand([
      "add-generic-password",
      "-U",
      "-a",
      getProviderSecretAccount(providerId),
      "-s",
      providerKeychainService,
      "-w",
      apiKey,
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown Keychain write error";
    throw new Error(`Failed to store provider API key in macOS Keychain: ${detail}`);
  }
}

function deleteKeychainApiKey(providerId: ProviderKind) {
  try {
    runSecurityCommand([
      "delete-generic-password",
      "-a",
      getProviderSecretAccount(providerId),
      "-s",
      providerKeychainService,
    ]);
  } catch {
    // Missing entries are fine.
  }
}

function readFallbackApiKey(providerId: ProviderKind) {
  return readFallbackSecrets().apiKeys?.[providerId] ?? null;
}

function writeFallbackApiKey(providerId: ProviderKind, apiKey: string) {
  const secrets = readFallbackSecrets();
  writeFallbackSecrets({
    ...secrets,
    apiKeys: {
      ...secrets.apiKeys,
      [providerId]: apiKey,
    },
  });
}

function deleteFallbackApiKey(providerId: ProviderKind) {
  const secrets = readFallbackSecrets();
  if (!secrets.apiKeys?.[providerId]) {
    return;
  }

  const nextApiKeys = { ...secrets.apiKeys };
  delete nextApiKeys[providerId];
  writeFallbackSecrets({
    ...secrets,
    apiKeys: nextApiKeys,
  });
}

export function getProviderApiKey(providerId: ProviderKind) {
  if (process.platform === "darwin") {
    return readKeychainApiKey(providerId) ?? readFallbackApiKey(providerId);
  }

  return readFallbackApiKey(providerId);
}

export function hasProviderApiKey(providerId: ProviderKind) {
  return Boolean(getProviderApiKey(providerId));
}

export function setProviderApiKey(providerId: ProviderKind, apiKey: string) {
  const normalized = apiKey.trim();
  if (!normalized) {
    return;
  }

  if (process.platform === "darwin") {
    try {
      writeKeychainApiKey(providerId, normalized);
      deleteFallbackApiKey(providerId);
    } catch {
      writeFallbackApiKey(providerId, normalized);
    }
    return;
  }

  writeFallbackApiKey(providerId, normalized);
}

export function deleteProviderApiKey(providerId: ProviderKind) {
  if (process.platform === "darwin") {
    deleteKeychainApiKey(providerId);
    deleteFallbackApiKey(providerId);
    return;
  }

  deleteFallbackApiKey(providerId);
}
