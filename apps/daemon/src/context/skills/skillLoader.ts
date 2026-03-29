import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillDefinition, SkillMode, SkillStatus } from "@aliceloop/runtime-core";
import {
  type SkillRouteHints,
  needsFileManagement,
  inferStickySkillIdsFromContext,
} from "./skillRouting";

const currentDir = dirname(fileURLToPath(import.meta.url));

function hasSkillMarkdown(candidate: string) {
  if (!existsSync(candidate)) {
    return false;
  }

  return readdirSync(candidate, { withFileTypes: true }).some((entry) => {
    return entry.isDirectory() && existsSync(join(candidate, entry.name, "SKILL.md"));
  });
}

const skillsRootDir = [
  resolve(currentDir, "../../../../../skills"),
  resolve(process.cwd(), "skills"),
  resolve(process.cwd(), "../skills"),
  resolve(process.cwd(), "../../skills"),
  currentDir,
  resolve(currentDir, "../src/context/skills"),
  resolve(process.cwd(), "src/context/skills"),
  resolve(process.cwd(), "apps/daemon/src/context/skills"),
].find(hasSkillMarkdown) ?? currentDir;

type FrontmatterValue = string | string[];

interface ParsedFrontmatter {
  name?: string;
  label?: string;
  description?: string;
  status?: string;
  mode?: string;
  sourceUrl?: string;
  allowedTools?: string[];
}

interface SkillCatalogCacheState {
  fingerprint: string;
  definitions: SkillDefinition[];
  activeDefinitions: SkillDefinition[];
  byId: Map<string, SkillDefinition>;
}

let skillCatalogCache: SkillCatalogCacheState | null = null;

const SEARCH_SYNONYM_PATTERNS: Array<[RegExp, string]> = [
  [/(?:浏览器|网页|网站|页面)/giu, " browser web page site "],
  [/(?:上网冲浪|冲浪一下|网上冲浪|上网看看|刷推特|刷抖音|刷微博|刷b站|看推文|看帖子|看主页|逛主页|时间线|timeline|browser_click|browser_open|browser_type)/giu, " browser "],
  [/(?:点击|点开)/giu, " click open "],
  [/(?:登录|登陆)/giu, " login signin "],
  [/(?:截图|截屏|屏幕)/giu, " screenshot screen "],
  [/(?:线程|会话)/giu, " thread "],
  [/(?:列表|清单|列出)/giu, " list "],
  [/(?:详情|信息)/giu, " detail inspect "],
  [/(?:删除|移除)/giu, " delete remove "],
  [/(?:新建|创建)/giu, " create new "],
  [/(?:聊天记录|历史会话|历史对话|之前聊|上次聊|聊到哪|回忆|记忆|记住|记得|还记得)/giu, " memory recall conversation history "],
  [/(?:配置|设置)/giu, " settings config "],
  [/(?:调查|research|fact-?check|验证|核对|来源|source|新闻|天气|汇率|比分|官网|网址|链接)/giu, " websearch research "],
  [/(?:原文|正文|全文|读取网页|读网页|页面内容|网页内容|精确页面|具体页面|article|api response|release notes?|docs? page)/giu, " webfetch fetch "],
  [/(?:模型)/giu, " model "],
  [/(?:推理)/giu, " reasoning "],
  [/(?:提供商)/giu, " provider "],
  [/(?:沙箱)/giu, " sandbox "],
  [/(?:文件夹|目录)/giu, " folder directory "],
  [/(?:文件)/giu, " file "],
  [/(?:管理)/giu, " manage management manager "],
  [/(?:整理)/giu, " organize "],
  [/(?:移动)/giu, " move "],
  [/(?:重命名|改名)/giu, " rename "],
  [/(?:压缩)/giu, " compress archive zip "],
  [/\b(?:pdf|docx?|pptx?|xlsx?|csv)\b/giu, " file pdf "],
  [/\b(?:jpe?g|png|gif|webp|heic)\b/giu, " file image "],
  [/\b(?:zip|tar\.gz|tgz|tar|gz|rar|7z)\b/giu, " archive compress file "],
  [/\b(?:jpe?g|png|gif|webp|heic)\b.*(?:改成|rename).*\b(?:jpe?g|jpg|png|gif|webp|heic)\b/giu, " rename file image "],
  [/(?:下载)/giu, " downloads filemanager "],
  [/(?:桌面)/giu, " desktop filemanager "],
  [/(?:文档)/giu, " documents filemanager "],
  [/\b(?:downloads?|desktop|documents)\b/giu, " filemanager "],
  [/(?:查找|找一下|查一下|搜索|搜一下|搜)/giu, " find search "],
  [/(?:最近\s*\d+\s*天|\d+\s*天内|last\s*\d+\s*days?)/giu, " date recent "],
  [/(?:最新|当前|最近)/giu, " latest current recent "],
  [/(?:大小|体积)/giu, " size "],
  [/(?:最大|最占空间|大文件|largest|biggest)/giu, " size large "],
  [/(?:天气)/giu, " weather "],
  [/(?:原文|正文|全文)/giu, " original full body text "],
  [/(?:读取网页|读网页|网页内容|页面内容)/giu, " fetch webpage content "],
  [/(?:时间|几点|日期|几号|星期)/giu, " time date weekday "],
  [/(?:视频)/giu, " video "],
  [/(?:音频|语音|听一下|听听)/giu, " audio voice speech "],
  [/(?:说了什么|讲了什么)/giu, " transcript said summary "],
  [/(?:发文件|发送文件|上传文件)/giu, " send file attach file "],
  [/(?:待办)/giu, " todo checklist "],
  [/(?:计划|规划)/giu, " plan planning "],
  [/(?:定时|提醒)/giu, " schedule scheduler reminder "],
  [/(?:继续|接着|恢复)/giu, " continue resume "],
  [/(?:能力|技能|工具)/giu, " skill capability tool "],
  [/(?:browser_click|browser_open|browser_type|browser relay)/giu, " browser capability tool "],
  [/(?:推特)/giu, " twitter "],
  [/(?:小红书)/giu, " xiaohongshu rednote "],
];

const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "how",
  "into",
  "local",
  "may",
  "need",
  "page",
  "real",
  "site",
  "detail",
  "help",
  "list",
  "task",
  "that",
  "the",
  "this",
  "turn",
  "use",
  "used",
  "using",
  "user",
  "users",
  "when",
  "with",
  "you",
  "your",
  "current",
  "find",
  "search",
  "latest",
  "recent",
  "session",
  "sessions",
  "skill",
  "skills",
  "support",
  "thread",
  "threads",
  "tool",
  "tools",
  "capability",
  "capabilities",
  "bash",
  "read",
  "write",
  "grep",
  "glob",
  "edit",
]);

const GENERIC_DISCOVERY_TOKENS = new Set([
  "capability",
  "capabilities",
]);

const ALLOWED_TOOL_ALIASES = new Map<string, string>([
  ["Bash", "bash"],
  ["Read", "read"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["Grep", "grep"],
  ["Glob", "glob"],
  ["WebSearch", "web_search"],
  ["WebFetch", "web_fetch"],
  ["ChromeRelayStatus", "chrome_relay_status"],
  ["ChromeRelayListTabs", "chrome_relay_list_tabs"],
  ["ChromeRelayOpen", "chrome_relay_open"],
  ["ChromeRelayNavigate", "chrome_relay_navigate"],
  ["ChromeRelayRead", "chrome_relay_read"],
  ["ChromeRelayReadDom", "chrome_relay_read_dom"],
  ["ChromeRelayClick", "chrome_relay_click"],
  ["ChromeRelayType", "chrome_relay_type"],
  ["ChromeRelayScreenshot", "chrome_relay_screenshot"],
  ["ChromeRelayScroll", "chrome_relay_scroll"],
  ["ChromeRelayEval", "chrome_relay_eval"],
  ["ChromeRelayBack", "chrome_relay_back"],
  ["ChromeRelayForward", "chrome_relay_forward"],
]);

class SkillFrontmatterError extends Error {
  constructor(sourcePath: string, message: string) {
    super(`Invalid skill frontmatter in ${sourcePath}: ${message}`);
    this.name = "SkillFrontmatterError";
  }
}

function normalizeKey(rawKey: string) {
  return rawKey.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function normalizeScalar(rawValue: string) {
  const value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function canonicalizeAllowedToolName(toolName: string) {
  return ALLOWED_TOOL_ALIASES.get(toolName) ?? toolName;
}

function normalizeSearchText(rawText: string) {
  let normalized = rawText.toLowerCase();
  for (const [pattern, replacement] of SEARCH_SYNONYM_PATTERNS) {
    normalized = normalized.replace(pattern, replacement);
  }

  normalized = normalized
    .replace(/[_/]/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff.+-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized;
}

function buildSkillSearchCorpus(skill: SkillDefinition) {
  return [skill.id, skill.label, skill.description, skill.allowedTools.join(" ")].join(" ");
}

function expandTokenVariants(token: string) {
  const variants = new Set<string>([token]);
  if (/^[a-z0-9.+-]{5,}$/.test(token) && token.endsWith("ies")) {
    variants.add(`${token.slice(0, -3)}y`);
  }
  else if (/^[a-z0-9.+-]{4,}$/.test(token) && token.endsWith("s")) {
    variants.add(token.slice(0, -1));
  }

  return [...variants];
}

function extractSearchTokens(rawText: string) {
  const normalized = normalizeSearchText(rawText);
  const tokens = new Set<string>();
  const matches = normalized.match(/[a-z0-9.+-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];

  for (const match of matches) {
    for (const variant of expandTokenVariants(match)) {
      if (!SEARCH_STOPWORDS.has(variant)) {
        tokens.add(variant);
      }
    }
  }

  return [...tokens];
}

function buildTokenDocumentFrequency(skills: SkillDefinition[]) {
  const tokenDocumentFrequency = new Map<string, number>();

  for (const skill of skills) {
    for (const token of new Set(extractSearchTokens(buildSkillSearchCorpus(skill)))) {
      tokenDocumentFrequency.set(token, (tokenDocumentFrequency.get(token) ?? 0) + 1);
    }
  }

  return tokenDocumentFrequency;
}

function scoreSkillMatch(
  skill: SkillDefinition,
  query: string,
  tokenDocumentFrequency: Map<string, number>,
  skillCount: number,
) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return 0;
  }

  const metadataText = buildSkillSearchCorpus(skill);
  const normalizedMetadata = normalizeSearchText(metadataText);
  const skillTokens = new Set(extractSearchTokens(metadataText));
  const nameTokens = new Set(extractSearchTokens(`${skill.id} ${skill.label}`));
  const allowedToolTokens = new Set(extractSearchTokens(skill.allowedTools.join(" ")));
  const queryTokens = extractSearchTokens(query);
  const queryTokenSet = new Set(queryTokens);
  const specificQueryTokens = queryTokens.filter((token) => !GENERIC_DISCOVERY_TOKENS.has(token));

  if (queryTokens.length === 0) {
    return 0;
  }

  let score = 0;
  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const exactNameVariants = [
    skill.id,
    skill.label,
    skill.id.replace(/-/g, " "),
    skill.label.replace(/-/g, " "),
    skill.id.replace(/-/g, ""),
    skill.label.replace(/-/g, ""),
  ]
    .map((value) => value.toLowerCase())
    .filter(Boolean);

  let hasExactNameMatch = false;
  for (const variant of exactNameVariants) {
    if (normalizedQuery.includes(variant) || compactQuery.includes(variant.replace(/\s+/g, ""))) {
      score += 40;
      hasExactNameMatch = true;
      break;
    }
  }

  const hasExactAllowedToolMatch = skill.allowedTools.some((toolName) => {
    const toolTokens = extractSearchTokens(toolName);
    return toolTokens.length > 0 && toolTokens.every((token) => queryTokenSet.has(token));
  });
  if (hasExactAllowedToolMatch) {
    score += 18;
  }

  let matchedWeight = 0;
  let totalWeight = 0;
  let matchedTokenCount = 0;

  for (const token of queryTokens) {
    const documentFrequency = tokenDocumentFrequency.get(token) ?? skillCount;
    const weight = token.length >= 10
      ? 5
      : token.length >= 6
        ? 4
        : token.length >= 4
          ? 3
          : 2;
    const rarityWeight = Math.max(1, Math.ceil(Math.log2((skillCount + 1) / documentFrequency)));
    const tokenWeight = weight + rarityWeight;
    totalWeight += tokenWeight;

    if (!skillTokens.has(token)) {
      continue;
    }

    matchedWeight += tokenWeight;
    matchedTokenCount += 1;
    score += nameTokens.has(token)
      ? tokenWeight + 4
      : allowedToolTokens.has(token)
        ? tokenWeight + 2
        : tokenWeight;
  }

  if (score > 0 && normalizedMetadata.includes(normalizedQuery)) {
    score += 8;
  }

  const matchedSpecificTokenCount = specificQueryTokens.filter((token) => skillTokens.has(token)).length;
  if (matchedSpecificTokenCount > 0) {
    score += matchedSpecificTokenCount >= 2 ? 10 : 4;
  }

  if (totalWeight > 0 && matchedWeight > 0) {
    const coverage = matchedWeight / totalWeight;
    score += Math.round(coverage * 8);

    if (!hasExactNameMatch && !hasExactAllowedToolMatch && matchedTokenCount === 1 && coverage < 0.45) {
      score -= 4;
    }
  }

  return score;
}

function parseSkillFrontmatter(source: string, sourcePath: string): ParsedFrontmatter {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new SkillFrontmatterError(sourcePath, "missing opening YAML frontmatter delimiter");
  }

  const result: Record<string, FrontmatterValue> = {};
  const keyLines = new Map<string, number>();
  let activeListKey: string | null = null;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      return {
        name: typeof result.name === "string" ? result.name : undefined,
        label: typeof result.label === "string" ? result.label : undefined,
        description: typeof result.description === "string" ? result.description : undefined,
        status: typeof result.status === "string" ? result.status : undefined,
        mode: typeof result.mode === "string" ? result.mode : undefined,
        sourceUrl: typeof result.sourceUrl === "string" ? result.sourceUrl : undefined,
        allowedTools: Array.isArray(result.allowedTools) ? result.allowedTools : [],
      };
    }

    const listItemMatch = line.match(/^\s*-\s*(.+)$/);
    if (listItemMatch && activeListKey) {
      const current = result[activeListKey];
      if (Array.isArray(current)) {
        current.push(normalizeScalar(listItemMatch[1]));
      }
      continue;
    }

    const keyValueMatch = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!keyValueMatch) {
      activeListKey = null;
      continue;
    }

    const [, rawKey, rawValue] = keyValueMatch;
    const key = normalizeKey(rawKey);
    const value = rawValue.trim();
    const lineNumber = index + 1;

    if (key === "tools") {
      throw new SkillFrontmatterError(
        sourcePath,
        `line ${lineNumber} uses deprecated frontmatter key "${rawKey}". Use "allowed-tools" instead.`,
      );
    }

    if (keyLines.has(key)) {
      throw new SkillFrontmatterError(
        sourcePath,
        `frontmatter key "${rawKey}" is repeated on lines ${keyLines.get(key)} and ${lineNumber}`,
      );
    }
    keyLines.set(key, lineNumber);

    if (!value) {
      result[key] = [];
      activeListKey = key;
      continue;
    }

    result[key] = normalizeScalar(value);
    activeListKey = null;
  }

  throw new SkillFrontmatterError(sourcePath, "missing closing YAML frontmatter delimiter");
}

function normalizeStatus(value: string | undefined, sourcePath: string): SkillStatus {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "available") {
    return "available";
  }

  if (normalized === "planned") {
    return "planned";
  }

  throw new SkillFrontmatterError(sourcePath, `unsupported status "${value}"`);
}

function normalizeMode(value: string | undefined, sourcePath: string): SkillMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "instructional") {
    return "instructional";
  }

  if (normalized === "task") {
    return "task";
  }

  throw new SkillFrontmatterError(sourcePath, `unsupported mode "${value}"`);
}

function readSkillDefinition(directoryName: string) {
  const sourcePath = join(skillsRootDir, directoryName, "SKILL.md");
  if (!existsSync(sourcePath)) {
    return null;
  }

  const source = readFileSync(sourcePath, "utf8");
  const frontmatter = parseSkillFrontmatter(source, sourcePath);

  const missingFields = ["name", "description"].filter((field) => {
    return typeof frontmatter[field as keyof ParsedFrontmatter] !== "string";
  });
  if (missingFields.length > 0) {
    throw new SkillFrontmatterError(
      sourcePath,
      `missing required frontmatter key${missingFields.length > 1 ? "s" : ""}: ${missingFields.join(", ")}`,
    );
  }

  const normalizedAllowedTools: string[] = [];
  const seenAllowedTools = new Set<string>();

  for (const toolName of frontmatter.allowedTools ?? []) {
    const trimmedToolName = toolName.trim();
    if (!trimmedToolName) {
      throw new SkillFrontmatterError(sourcePath, "allowed-tools entries must not be empty");
    }
    if (trimmedToolName !== toolName) {
      throw new SkillFrontmatterError(
        sourcePath,
        `allowed-tools entry "${toolName}" must not contain surrounding whitespace`,
      );
    }

    const canonicalName = canonicalizeAllowedToolName(trimmedToolName);
    if (!seenAllowedTools.has(canonicalName)) {
      seenAllowedTools.add(canonicalName);
      normalizedAllowedTools.push(canonicalName);
    }
  }

  const name = frontmatter.name as string;
  const description = frontmatter.description as string;

  return {
    id: name,
    label: frontmatter.label?.trim() || name,
    description,
    status: normalizeStatus(frontmatter.status, sourcePath),
    mode: normalizeMode(frontmatter.mode, sourcePath),
    sourcePath,
    sourceUrl: frontmatter.sourceUrl?.trim() || null,
    allowedTools: normalizedAllowedTools,
  } satisfies SkillDefinition;
}

function listSkillDirectoryNames() {
  return readdirSync(skillsRootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function buildSkillCatalogFingerprint(directoryNames: string[]) {
  return directoryNames
    .map((directoryName) => {
      const sourcePath = join(skillsRootDir, directoryName, "SKILL.md");
      if (!existsSync(sourcePath)) {
        return `${directoryName}:missing`;
      }

      return `${directoryName}:${statSync(sourcePath).mtimeMs}`;
    })
    .join("|");
}

function getSkillCatalogCache() {
  const directoryNames = listSkillDirectoryNames();
  const fingerprint = buildSkillCatalogFingerprint(directoryNames);
  if (skillCatalogCache?.fingerprint === fingerprint) {
    return skillCatalogCache;
  }

  const definitions = directoryNames
    .map((directoryName) => readSkillDefinition(directoryName))
    .filter((skill): skill is SkillDefinition => Boolean(skill))
    .sort((left, right) => left.id.localeCompare(right.id));
  const activeDefinitions = definitions.filter((skill) => skill.status === "available");

  skillCatalogCache = {
    fingerprint,
    definitions,
    activeDefinitions,
    byId: new Map(definitions.map((skill) => [skill.id, skill])),
  };

  return skillCatalogCache;
}

export function listSkillDefinitions() {
  return getSkillCatalogCache().definitions;
}

export function listActiveSkillDefinitions() {
  return getSkillCatalogCache().activeDefinitions;
}

export function selectRelevantSkillIds(query: string | null | undefined, hints?: SkillRouteHints) {
  const normalizedQuery = query?.trim() ?? "";
  if (!normalizedQuery && (hints?.stickySkillIds.length ?? 0) === 0) {
    return [] as string[];
  }

  const activeSkills = listActiveSkillDefinitions();
  const stickySkillIds = new Set([
    ...inferStickySkillIdsFromContext(normalizedQuery),
    ...(hints?.stickySkillIds ?? []),
  ]);

  if (needsFileManagement(normalizedQuery)) {
    return [...stickySkillIds];
  }

  const tokenDocumentFrequency = buildTokenDocumentFrequency(activeSkills);
  const scoredSkills = activeSkills
    .map((skill) => ({
      id: skill.id,
      score: stickySkillIds.has(skill.id)
        ? 1000
        : scoreSkillMatch(skill, normalizedQuery, tokenDocumentFrequency, activeSkills.length),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  if (scoredSkills.length === 0) {
    return [...stickySkillIds];
  }

  const stickyEntries = scoredSkills.filter((entry) => stickySkillIds.has(entry.id));
  const nonStickyEntries = scoredSkills.filter((entry) => !stickySkillIds.has(entry.id));

  if (nonStickyEntries.length === 0) {
    return stickyEntries.slice(0, 4).map((entry) => entry.id);
  }

  const topNonStickyScore = nonStickyEntries[0]?.score ?? 0;
  const minimumNonStickyScore = topNonStickyScore >= 24
    ? topNonStickyScore - 10
    : topNonStickyScore >= 14
      ? topNonStickyScore - 6
      : topNonStickyScore >= 8
        ? topNonStickyScore - 3
        : Math.max(4, topNonStickyScore);

  const selectedIds = new Set<string>();
  const orderedSelections: string[] = [];

  for (const entry of stickyEntries) {
    if (!selectedIds.has(entry.id)) {
      selectedIds.add(entry.id);
      orderedSelections.push(entry.id);
    }
  }

  for (const entry of nonStickyEntries) {
    if (entry.score < minimumNonStickyScore || selectedIds.has(entry.id)) {
      continue;
    }

    selectedIds.add(entry.id);
    orderedSelections.push(entry.id);
  }

  return orderedSelections.slice(0, 4);
}

export function selectRelevantSkillDefinitions(query: string | null | undefined, hints?: SkillRouteHints) {
  const normalizedQuery = query?.trim() ?? "";
  const directlyRelevantSkillIds = new Set(selectRelevantSkillIds(normalizedQuery, hints));
  const activeSkills = listActiveSkillDefinitions();

  return activeSkills.filter((skill) => directlyRelevantSkillIds.has(skill.id));
}

export function getSkillDefinition(skillId: string) {
  return getSkillCatalogCache().byId.get(skillId) ?? null;
}

export function resetSkillCatalogCache() {
  skillCatalogCache = null;
}

interface BuildSkillContextBlockOptions {
  browserRelayAvailable?: boolean;
  routeHints?: SkillRouteHints;
}

export function buildSkillContextBlock(skills: SkillDefinition[], options?: BuildSkillContextBlockOptions) {
  if (skills.length === 0) {
    return [
      "No extra local skill was selected for this turn.",
      "Select skills from metadata only when they materially help the task.",
      "Tool routing is separate from skill selection.",
    ].join("\n");
  }

  const sections = [
    "Project skills live in the local context catalog.",
    `Skill catalog root: ${skillsRootDir}`,
    "Architecture rule: skills are AI-native instruction blocks selected from metadata; they are not workflow scripts.",
    "Tool routing is handled separately from skill selection.",
    "Bash can invoke unlimited scripts = unlimited capabilities. Skills封装这些能力。",
    "Critical execution rule: when a selected skill shows shell commands or CLI examples, treat them as actions to run with the attached tools, not as text to paste into the assistant reply.",
    "If `bash` is attached for the current turn, execute the relevant command and answer from its result. Do not reply with raw command suggestions like `ls`, `pwd`, or `aliceloop ...` unless the user explicitly asked for the command itself.",
    "Do not expose internal routing labels such as `web_search`, `web-fetch`, `memory-management`, or `thread-management` in a normal user-facing answer unless the user explicitly asked for runtime diagnostics.",
    "If a turn needs better capability coverage, improve retrieval quality or use skill-hub / skill-search instead of expanding the default tool base.",
    "Selection policy: prefer the smallest relevant subset of skills for this turn instead of loading the whole catalog.",
    "The skills below were selected as relevant for this turn. Read their SKILL.md files before acting when needed.",
    "",
    "Selected skills for this turn:",
  ];

  const routedSkillIds = new Set(skills.map((skill) => skill.id));
  if ((options?.routeHints?.stickySkillIds.length ?? 0) > 0) {
    sections.push(`- Relevant carry-forward skills from the immediate context: ${options?.routeHints?.stickySkillIds.join(", ")}.`);
  }
  if (routedSkillIds.has("web-search") || routedSkillIds.has("web-fetch")) {
    sections.push("- Routing priority: when the user needs exact factual verification, current metrics, dates, or source-backed corrections, treat web_search as the default first step and only route web_fetch when a specific page still needs to be read.");
    sections.push("- Source priority: primary platform pages and clearly dated sources come before encyclopedia overviews; 百度百科 is extremely low priority for live facts.");
    sections.push("- Research memory rule: keep a running evidence ledger. Search results are discovery only, and the next `web_fetch` should target the strongest unfetched candidate URL from the ledger instead of restarting the topic from scratch.");
  }
  if (routedSkillIds.has("system-info")) {
    sections.push("- system-info: use it for current local time, date, weekday, or host diagnostics. It can call `bash` commands such as `date`, `sw_vers`, `df -h`, or `uptime`.");
  }

  if (routedSkillIds.has("browser")) {
    if (options?.browserRelayAvailable) {
      sections.push("- Browser runtime status for this turn: a healthy visible Aliceloop Desktop Chrome relay is available right now.");
      sections.push("- Browser backend policy: prefer the Chrome relay for browser tasks when it is healthy, and fall back to PinchTab only if the relay is unavailable.");
      sections.push("- Do not claim that browser automation is headless, stateless, or unable to retain login data when using this relay. Use the visible Chrome path and reuse its persistent login session.");
    } else {
      sections.push("- Browser runtime status for this turn: no healthy desktop relay is currently registered, so browser automation should use PinchTab instead of a local Playwright browser.");
    }
    sections.push("- Structured site rule: for supported platforms such as Bilibili, Xiaohongshu, and Twitter/X, stay on the browser tools by default instead of detouring through bash wrappers.");
  }

  if (routedSkillIds.has("twitter-media")) {
    sections.push("- Twitter/X routing rule: for logged-in timeline/search/bookmarks/profile tasks, prefer the current browser session. Use public-link fetch only when the user only needs a tweet's public content.");
  }

  if (routedSkillIds.has("xiaohongshu")) {
    sections.push("- Xiaohongshu routing rule: prefer the current browser session for profile/feed/note tasks, and only switch away when the browser path is unavailable.");
  }

  for (const skill of skills) {
    const relativeSourcePath = relative(skillsRootDir, skill.sourcePath).replace(/\\/g, "/");
    sections.push(`- ${skill.label}: ${skill.description} [${relativeSourcePath}]`);
  }

  return sections.join("\n");
}
