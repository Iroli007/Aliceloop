export interface RepairedToolCall {
  source: "minimax_text_tool_call" | "tool_call_json" | "standalone_tool_json" | "named_tool_call_tag" | "inline_tool_json" | "wrapped_command_tag" | "fenced_command_block" | "wrapped_query_tag" | "wrapped_tool_tag";
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
      includeMarkdown: pickBooleanAttribute(attributes, "includeMarkdown", "include_markdown"),
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

function pickJsonToolName(parsed: Record<string, unknown>) {
  if (typeof parsed.name === "string") {
    return parsed.name;
  }

  if (typeof parsed.toolName === "string") {
    return parsed.toolName;
  }

  if (typeof parsed.tool === "string") {
    return parsed.tool;
  }

  return "";
}

function buildJsonToolCall(
  parsed: Record<string, unknown>,
  markup: string,
  source: RepairedToolCall["source"],
): RepairedToolCall | null {
  const rawToolName = pickJsonToolName(parsed);
  const toolName = normalizeToolName(rawToolName);
  if (!toolName) {
    return null;
  }

  const input = buildNormalizedInput(toolName, getJsonToolInput(parsed, true));
  if (!input) {
    return null;
  }

  return {
    source,
    rawToolName,
    toolName,
    input,
    markup,
  };
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
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return buildJsonToolCall(parsed as Record<string, unknown>, markup, "tool_call_json");
  } catch {
    return null;
  }
}

function getJsonToolInput(parsed: Record<string, unknown>, hasExternalToolName: boolean) {
  const inputCandidate = parsed.arguments ?? parsed.parameters ?? parsed.input ?? parsed.args;
  if (inputCandidate && typeof inputCandidate === "object" && !Array.isArray(inputCandidate)) {
    return inputCandidate as Record<string, unknown>;
  }

  if (hasExternalToolName) {
    return parsed;
  }

  return {};
}

function getPlainTextToolInput(toolName: string, text: string, attributes: Record<string, unknown>) {
  if (!text) {
    return attributes;
  }

  if (toolName === "web_search") {
    return { ...attributes, query: pickStringAttribute(attributes, "query") ?? text };
  }

  if (toolName === "web_fetch") {
    return { ...attributes, url: pickStringAttribute(attributes, "url") ?? text };
  }

  if (toolName === "bash") {
    return { ...attributes, script: pickStringAttribute(attributes, "script", "command") ?? text };
  }

  return attributes;
}

function parseStandaloneToolJsonCall(text: string): RepairedToolCall | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/^```(?:json|tool|tool_call)?\s*([\s\S]*?)\s*```$/iu);
  const rawJson = fencedMatch ? fencedMatch[1]?.trim() : (() => {
    if (!trimmed.startsWith("{")) {
      return null;
    }

    const extracted = extractBalancedJsonObject(trimmed, 0);
    if (!extracted || extracted.endIndex !== trimmed.length) {
      return null;
    }

    return extracted.json;
  })();

  if (!rawJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeHtmlEntities(rawJson)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return buildJsonToolCall(parsed as Record<string, unknown>, trimmed, "standalone_tool_json");
  } catch {
    return null;
  }
}

function parseNamedToolCallTagMatch(markup: string, rawAttributes: string, body: string): RepairedToolCall | null {
  const attributes = parseXmlAttributes(rawAttributes);
  const attributeToolName = pickStringAttribute(attributes, "name", "tool", "toolName");
  const decoded = decodeHtmlEntities(body).trim();
  if (!attributeToolName && !decoded) {
    return null;
  }

  const attributeInput = { ...attributes };
  delete attributeInput.name;
  delete attributeInput.tool;
  delete attributeInput.toolName;

  try {
    const parsed = decoded ? JSON.parse(decoded) as unknown : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const parsedRecord = parsed as Record<string, unknown>;
    const rawToolName = attributeToolName
      ?? (typeof parsedRecord.name === "string"
        ? parsedRecord.name
        : typeof parsedRecord.toolName === "string"
          ? parsedRecord.toolName
          : typeof parsedRecord.tool === "string"
            ? parsedRecord.tool
            : "");
    const toolName = normalizeToolName(rawToolName);
    if (!toolName) {
      return null;
    }

    const rawInput = Object.keys(parsedRecord).length > 0
      ? getJsonToolInput(parsedRecord, Boolean(attributeToolName))
      : attributeInput;
    const input = buildNormalizedInput(toolName, rawInput);
    if (!input) {
      return null;
    }

    return {
      source: "named_tool_call_tag",
      rawToolName,
      toolName,
      input,
      markup,
    };
  } catch {
    const rawToolName = attributeToolName ?? "";
    const toolName = normalizeToolName(rawToolName);
    if (!toolName) {
      return null;
    }

    const input = buildNormalizedInput(toolName, getPlainTextToolInput(toolName, decoded, attributeInput));
    if (!input) {
      return null;
    }

    return {
      source: "named_tool_call_tag",
      rawToolName,
      toolName,
      input,
      markup,
    };
  }
}

function parseNamedToolCallTags(text: string): RepairedToolCall[] {
  const calls: RepairedToolCall[] = [];
  const tagPattern = /<tool_call\b([^>]*)>\s*([\s\S]*?)\s*<\/tool_call>/giu;

  for (const match of text.matchAll(tagPattern)) {
    const call = parseNamedToolCallTagMatch(match[0], match[1] ?? "", match[2] ?? "");
    if (call) {
      calls.push(call);
    }
  }

  return calls;
}

function extractBalancedJsonObject(text: string, startIndex: number) {
  if (text[startIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          json: text.slice(startIndex, index + 1),
          endIndex: index + 1,
        };
      }
    }
  }

  return null;
}

function parseInlineToolJsonCall(text: string): RepairedToolCall | null {
  const markerPattern = /(?:^|[^\w-])([a-zA-Z_][\w-]*)\s*:\s*\d+\s*\{/gu;

  for (const match of text.matchAll(markerPattern)) {
    const rawToolName = match[1] ?? "";
    const matchedText = match[0] ?? "";
    const markerStart = match.index ?? 0;
    const callStart = markerStart + Math.max(0, matchedText.indexOf(rawToolName));
    const jsonStart = markerStart + matchedText.lastIndexOf("{");
    const extracted = extractBalancedJsonObject(text, jsonStart);
    if (!extracted) {
      continue;
    }

    try {
      const parsed = JSON.parse(extracted.json) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }

      const toolName = normalizeToolName(rawToolName);
      if (!toolName) {
        continue;
      }

      const input = buildNormalizedInput(toolName, parsed as Record<string, unknown>);
      if (!input) {
        continue;
      }

      return {
        source: "inline_tool_json",
        rawToolName,
        toolName,
        input,
        markup: text.slice(callStart, extracted.endIndex).trim(),
      };
    } catch {
      continue;
    }
  }

  return null;
}

function parseWrappedCommandTag(text: string): RepairedToolCall | null {
  const match = text.match(/<(bash|sh|shell)>\s*([\s\S]*?)\s*<\/\1>/iu);
  if (!match) {
    return null;
  }

  const script = (match[2] ?? "").trim();
  if (!script) {
    return null;
  }

  return {
    source: "wrapped_command_tag",
    rawToolName: match[1] ?? "bash",
    toolName: "bash",
    input: { script },
    markup: match[0],
  };
}

function parseFencedCommandBlock(text: string): RepairedToolCall | null {
  const match = text.trim().match(/^```(?:bash|sh|shell|zsh)\s*\n([\s\S]*?)\n?```$/iu);
  if (!match) {
    return null;
  }

  const script = (match[1] ?? "").trim();
  if (!script) {
    return null;
  }

  return {
    source: "fenced_command_block",
    rawToolName: "bash",
    toolName: "bash",
    input: { script },
    markup: match[0],
  };
}

function parseWrappedQueryTags(text: string): RepairedToolCall[] {
  const calls: RepairedToolCall[] = [];
  const tagPattern = /<(search|web_search|fetch|web_fetch)\b([^>]*)>\s*([\s\S]*?)\s*<\/\1>/giu;

  for (const match of text.matchAll(tagPattern)) {
    const rawToolName = match[1] ?? "";
    const toolName = normalizeToolName(rawToolName);
    const body = decodeHtmlEntities(match[3] ?? "").trim();
    const bodyTagName = toolName === "web_fetch" ? "url" : "query";
    const nestedBodyMatch = body.match(new RegExp(`<${bodyTagName}\\b[^>]*>\\s*([\\s\\S]*?)\\s*<\\/${bodyTagName}>`, "iu"));
    const bodyValue = (nestedBodyMatch?.[1] ?? body).trim();
    const attributes = parseXmlAttributes(match[2] ?? "");
    const bodyKey = toolName === "web_fetch" ? "url" : "query";
    const input = buildNormalizedInput(toolName, {
      ...attributes,
      [bodyKey]: pickStringAttribute(attributes, bodyKey) ?? bodyValue,
    });
    if (!input) {
      continue;
    }

    calls.push({
      source: "wrapped_query_tag",
      rawToolName,
      toolName,
      input,
      markup: match[0] ?? "",
    });
  }

  return calls;
}

function parseXmlChildTags(body: string) {
  const attributes: Record<string, unknown> = {};
  const childPattern = /<([a-zA-Z_][\w-]*)\b[^>]*>\s*([\s\S]*?)\s*<\/\1>/gu;

  for (const match of body.matchAll(childPattern)) {
    const rawKey = match[1];
    if (!rawKey) {
      continue;
    }

    attributes[rawKey] = decodeHtmlEntities(match[2] ?? "").trim();
  }

  return attributes;
}

function parseWrappedToolTags(text: string): RepairedToolCall[] {
  const calls: RepairedToolCall[] = [];
  const tagPattern = /<(grep|glob|read|bash|search|web_search|fetch|web_fetch)\b([^>]*)>\s*([\s\S]*?)\s*<\/\1>/giu;

  for (const match of text.matchAll(tagPattern)) {
    const rawToolName = match[1] ?? "";
    const toolName = normalizeToolName(rawToolName);
    const attributes = {
      ...parseXmlAttributes(match[2] ?? ""),
      ...parseXmlChildTags(match[3] ?? ""),
    };
    const body = decodeHtmlEntities(match[3] ?? "").trim();
    const input = buildNormalizedInput(toolName, getPlainTextToolInput(toolName, body, attributes));
    if (!input) {
      continue;
    }

    calls.push({
      source: "wrapped_tool_tag",
      rawToolName,
      toolName,
      input,
      markup: match[0] ?? "",
    });
  }

  return calls;
}

export function repairTextToolCalls(text: string): RepairedToolCall[] {
  const wrappedToolCalls = parseWrappedToolTags(text);
  if (wrappedToolCalls.length > 0) {
    return wrappedToolCalls;
  }

  const wrappedQueryCalls = parseWrappedQueryTags(text);
  if (wrappedQueryCalls.length > 0) {
    return wrappedQueryCalls;
  }

  const jsonToolCall = parseJsonToolCall(text);
  if (jsonToolCall) {
    return [jsonToolCall];
  }

  const namedToolCallTags = parseNamedToolCallTags(text);
  if (namedToolCallTags.length > 0) {
    return namedToolCallTags;
  }

  const singleCall = parseStandaloneToolJsonCall(text)
    ?? parseInlineToolJsonCall(text)
    ?? parseWrappedCommandTag(text)
    ?? parseFencedCommandBlock(text)
    ?? parseMiniMaxTextToolCall(text);

  return singleCall ? [singleCall] : [];
}

export function repairTextToolCall(text: string): RepairedToolCall | null {
  return repairTextToolCalls(text)[0] ?? null;
}
