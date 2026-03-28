type RawBashInput = {
  command?: unknown;
  args?: unknown;
  script?: unknown;
  cwd?: unknown;
};

function normalizeString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeArgs(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  if (typeof value === "string") {
    return value.split(/\s+/u).map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

function shouldPromoteCommandToScript(command: string) {
  return /[|;&<>`$()\n]/u.test(command) || /\s/u.test(command);
}

export function normalizeBashInput(value: unknown) {
  if (!value || typeof value !== "object") {
    return value;
  }

  const raw = value as RawBashInput;
  let command = normalizeString(raw.command);
  const args = normalizeArgs(raw.args);
  let script = normalizeString(raw.script);
  const cwd = normalizeString(raw.cwd);

  if (script) {
    command = undefined;
  } else if (command && shouldPromoteCommandToScript(command)) {
    script = command;
    command = undefined;
  }

  return {
    command,
    args: command ? args : [],
    script,
    cwd,
  };
}
