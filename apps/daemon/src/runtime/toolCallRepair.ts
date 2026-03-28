export interface RepairedToolCall {
  source: "minimax_text_tool_call" | "tool_call_json";
  rawToolName: string;
  toolName: string;
  input: Record<string, unknown>;
  markup: string;
}

function coerceXmlAttributeValue(rawValue: string): unknown {
  const value = rawValue.trim();
  if (/^-?\d+$/u.test(value)) {
    return Number(value);
  }

  if (/^(true|false)$/iu.test(value)) {
    return value.toLowerCase() === "true";
  }

  return value;
}

function parseXmlAttributes(source: string) {
  const attributes: Record<string, unknown> = {};
  const attributePattern = /([a-zA-Z_][\w-]*)="([^"]*)"/gu;

  for (const match of source.matchAll(attributePattern)) {
    const [, rawKey, rawValue] = match;
    if (!rawKey) {
      continue;
    }

    attributes[rawKey] = coerceXmlAttributeValue(rawValue ?? "");
  }

  return attributes;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    return Number(value.trim());
  }

  return undefined;
}

function pickStringAttribute(attributes: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function pickBooleanAttribute(attributes: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  return undefined;
}

function pickIntegerAttribute(attributes: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = toPositiveInteger(attributes[key]);
    if (typeof value === "number") {
      return value;
    }
  }

  return undefined;
}

function normalizeToolName(rawToolName: string) {
  const normalized = rawToolName.trim().toLowerCase().replace(/-/gu, "_");
  if (normalized === "search") {
    return "web_search";
  }

  if (normalized === "fetch") {
    return "web_fetch";
  }

  return normalized;
}

function buildNormalizedInput(toolName: string, attributes: Record<string, unknown>) {
  if (toolName === "web_search") {
    const query = pickStringAttribute(attributes, "query");
    if (!query) {
      return null;
    }

    return {
      query,
      maxResults: pickIntegerAttribute(attributes, "count", "maxResults", "max_results"),
      domains: [],
    };
  }

  if (toolName === "web_fetch") {
    const url = pickStringAttribute(attributes, "url");
    if (!url) {
      return null;
    }

    return {
      url,
      extractMain: pickBooleanAttribute(attributes, "extractMain", "extract_main") ?? true,
    };
  }

  if (toolName === "bash") {
    const script = pickStringAttribute(attributes, "script");
    const command = pickStringAttribute(attributes, "command");
    if (!script && !command) {
      return null;
    }

    const input: Record<string, unknown> = {};
    if (script) {
      input.script = script;
    } else if (command) {
      if (/[|&;<>()$`\n]/u.test(command) || /\s/u.test(command)) {
        input.script = command;
      } else {
        input.command = command;
      }
    }

    const args = pickStringAttribute(attributes, "args");
    if (!input.script && args) {
      input.args = args.split(/\s+/u).filter(Boolean);
    }

    const cwd = pickStringAttribute(attributes, "cwd");
    if (cwd) {
      input.cwd = cwd;
    }

    return input;
  }

  if (toolName === "read") {
    const filePath = pickStringAttribute(attributes, "filePath", "path", "targetPath");
    if (!filePath) {
      return null;
    }

    return {
      filePath,
      offset: pickIntegerAttribute(attributes, "offset"),
      limit: pickIntegerAttribute(attributes, "limit"),
    };
  }

  if (toolName === "glob") {
    const pattern = pickStringAttribute(attributes, "pattern");
    if (!pattern) {
      return null;
    }

    return {
      pattern,
      cwd: pickStringAttribute(attributes, "cwd", "path"),
    };
  }

  if (toolName === "grep") {
    const pattern = pickStringAttribute(attributes, "pattern");
    if (!pattern) {
      return null;
    }

    return {
      pattern,
      path: pickStringAttribute(attributes, "path"),
      glob: pickStringAttribute(attributes, "glob"),
      fixedStrings: pickBooleanAttribute(attributes, "fixedStrings", "fixed_strings"),
      caseSensitive: pickBooleanAttribute(attributes, "caseSensitive", "case_sensitive"),
      maxCount: pickIntegerAttribute(attributes, "maxCount", "max_count"),
      context: pickIntegerAttribute(attributes, "context"),
    };
  }

  if (toolName === "write") {
    const targetPath = pickStringAttribute(attributes, "targetPath", "path", "filePath");
    const content = pickStringAttribute(attributes, "content");
    if (!targetPath || content === undefined) {
      return null;
    }

    return {
      targetPath,
      content,
    };
  }

  if (toolName === "edit") {
    const filePath = pickStringAttribute(attributes, "filePath", "path", "targetPath");
    const oldText = pickStringAttribute(attributes, "oldText", "old_text");
    const newText = pickStringAttribute(attributes, "newText", "new_text");
    if (!filePath || oldText === undefined || newText === undefined) {
      return null;
    }

    return {
      filePath,
      oldText,
      newText,
    };
  }

  return Object.keys(attributes).length > 0 ? attributes : {};
}

function parseMiniMaxTextToolCall(text: string): RepairedToolCall | null {
  if (!/minimax:tool_call/iu.test(text)) {
    return null;
  }

  const match = text.match(/<([a-zA-Z_][\w-]*)\s*([^<>]*?)\/>/u);
  if (!match) {
    return null;
  }

  const [, rawToolName = "", rawAttributes = ""] = match;
  const toolName = normalizeToolName(rawToolName);
  const attributes = parseXmlAttributes(rawAttributes);
  const input = buildNormalizedInput(toolName, attributes);
  if (!input) {
    return null;
  }

  return {
    source: "minimax_text_tool_call",
    rawToolName,
    toolName,
    input,
    markup: match[0],
  };
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function parseJsonToolCall(text: string): RepairedToolCall | null {
  const match = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/u);
  if (!match) {
    return null;
  }

  const markup = match[0];
  const decoded = decodeHtmlEntities(match[1] ?? "").trim();
  if (!decoded) {
    return null;
  }

  try {
    const parsed = JSON.parse(decoded) as {
      name?: unknown;
      toolName?: unknown;
      tool?: unknown;
      parameters?: unknown;
      input?: unknown;
      args?: unknown;
    };
    const rawToolName = typeof parsed.name === "string"
      ? parsed.name
      : typeof parsed.toolName === "string"
        ? parsed.toolName
        : typeof parsed.tool === "string"
          ? parsed.tool
          : "";
    const toolName = normalizeToolName(rawToolName);
    if (!toolName) {
      return null;
    }

    const inputCandidate = parsed.parameters ?? parsed.input ?? parsed.args;
    const input = inputCandidate && typeof inputCandidate === "object"
      ? inputCandidate as Record<string, unknown>
      : {};

    return {
      source: "tool_call_json",
      rawToolName,
      toolName,
      input,
      markup,
    };
  } catch {
    return null;
  }
}

export function repairTextToolCall(text: string): RepairedToolCall | null {
  return parseJsonToolCall(text) ?? parseMiniMaxTextToolCall(text);
}
