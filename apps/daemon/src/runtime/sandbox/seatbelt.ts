import { existsSync } from "node:fs";
import { homedir } from "node:os";

const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * Check whether macOS sandbox-exec (Seatbelt) is available on this system.
 */
export function isSeatbeltAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC_PATH);
}

/**
 * Build a Seatbelt SBPL profile string.
 *
 * Strategy: blacklist mode (allow default + deny specific).
 * SBPL uses last-match-wins semantics, so:
 *   deny file-write* (subpath "/Users")
 *   allow file-write* (subpath "/Users/me/project")
 * → the allow wins for the project subpath.
 */
export function buildSeatbeltProfile(options: {
  allowedWriteRoots: string[];
  allowedReadRoots: string[];
  denyNetwork: boolean;
}): string {
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    "",
  ];

  // --- Network ---
  if (options.denyNetwork) {
    lines.push(";; Block TCP/UDP network access but allow Unix domain sockets (needed for IPC)");
    lines.push("(deny network*)");
    lines.push("(allow network* (local unix))");
    lines.push("(allow network* (remote unix))");
    lines.push("");
  }

  // --- File access restrictions ---
  const home = homedir();
  lines.push(";; Restrict file reads and writes under /Users");
  lines.push(`(deny file-read* (subpath "/Users"))`);
  lines.push(`(deny file-write* (subpath "/Users"))`);

  if (options.allowedWriteRoots.length > 0) {
    lines.push(";; Allow writes to explicitly permitted roots");
    for (const root of options.allowedWriteRoots) {
      lines.push(`(allow file-write* (subpath ${sbplQuote(root)}))`);
    }
  }

  // Allow writes to temp directories (needed for Node.js / general operation)
  lines.push(`(allow file-write* (subpath "/tmp"))`);
  lines.push(`(allow file-write* (subpath "/private/tmp"))`);
  const tmpdir = process.env.TMPDIR;
  if (tmpdir && tmpdir.startsWith("/var/folders/")) {
    lines.push(`(allow file-write* (subpath ${sbplQuote(tmpdir)}))`);
  }
  lines.push("");

  // --- Sensitive directory read restrictions ---
  const sensitiveRelativePaths = [".ssh", ".gnupg", ".aws", ".config", ".env"];
  lines.push(";; Block reads of sensitive directories");
  for (const rel of sensitiveRelativePaths) {
    const sensitivePath = `${home}/${rel}`;
    lines.push(`(deny file-read* (subpath ${sbplQuote(sensitivePath)}))`);
  }

  // Allow reads for explicitly permitted roots (overrides the deny above if overlapping)
  if (options.allowedReadRoots.length > 0) {
    lines.push(";; Allow reads for explicitly permitted roots");
    for (const root of options.allowedReadRoots) {
      lines.push(`(allow file-read* (subpath ${sbplQuote(root)}))`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Wrap a command invocation with sandbox-exec.
 * Returns the new executable and args to pass to execFile.
 */
export function wrapWithSeatbelt(
  executable: string,
  args: string[],
  profile: string,
): { executable: string; args: string[] } {
  return {
    executable: SANDBOX_EXEC_PATH,
    args: ["-p", profile, executable, ...args],
  };
}

/**
 * Quote a string for SBPL (Scheme-based profile language).
 * SBPL uses double-quoted strings with backslash escaping.
 */
function sbplQuote(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
