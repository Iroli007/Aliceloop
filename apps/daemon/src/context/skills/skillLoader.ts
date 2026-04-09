import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillDefinition, SkillMode, SkillStatus } from "@aliceloop/runtime-core";
import {
  inferStickySkillIdsFromContext,
  type SkillRouteHints,
  needsAudioAnalysis,
  needsBrowserAutomation,
  needsFileManagement,
  needsSystemInfo,
  needsThreadManagement,
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
  process.env.ALICELOOP_SKILLS_DIR?.trim(),
  resolve(currentDir, "../../../../../skills"),
  resolve(process.cwd(), "skills"),
  resolve(process.cwd(), "../skills"),
  resolve(process.cwd(), "../../skills"),
  currentDir,
  resolve(currentDir, "../src/context/skills"),
  resolve(process.cwd(), "src/context/skills"),
  resolve(process.cwd(), "apps/daemon/src/context/skills"),
].filter((candidate): candidate is string => Boolean(candidate)).find(hasSkillMarkdown) ?? currentDir;

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

interface StaticSkillCatalogBlockCacheState {
  fingerprint: string;
  content: string;
  key: string;
}

interface SkillBodyCacheEntry {
  fingerprint: string;
  content: string;
  key: string;
}

let skillCatalogCache: SkillCatalogCacheState | null = null;
let staticSkillCatalogBlockCache: StaticSkillCatalogBlockCacheState | null = null;
const skillBodyCache = new Map<string, SkillBodyCacheEntry>();
const MAX_SELECTED_SKILLS = 2;
const TOOL_OWNED_SKILL_IDS = new Set(["plan-mode"]);

export function computeSkillBlockKey(content: string) {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}

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
  [/(?:任务追踪|任务跟踪|任务列表|任务进度|多步骤任务|长期任务|列一下任务|有哪些任务|查看任务|任务拆成步骤|列步骤)/giu, " tasks task tracking progress list steps "],
  [/(?:计划|规划)/giu, " plan planning "],
  [/(?:定时|提醒|cron)/giu, " schedule scheduler reminder cron "],
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
  return [skill.id, skill.label, skill.description].join(" ");
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
  const queryTokens = extractSearchTokens(query);
  const queryTokenSet = new Set(queryTokens);
  const specificQueryTokens = queryTokens.filter((token) => !GENERIC_DISCOVERY_TOKENS.has(token));
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

  const hasExactNameMatch = exactNameVariants.some((variant) => {
    return normalizedQuery.includes(variant) || compactQuery.includes(variant.replace(/\s+/g, ""));
  });

  if (queryTokens.length === 0) {
    return 0;
  }

  if (!hasExactNameMatch && specificQueryTokens.length === 0) {
    return 0;
  }

  let score = 0;
  if (hasExactNameMatch) {
    score += 40;
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

    if (!hasExactNameMatch && matchedTokenCount === 1 && coverage < 0.45) {
      score -= 4;
    }
  }

  return score;
}

function needsSchedulerIntent(query: string) {
  return /提醒|定时|cron|schedule|scheduler|稍后|晚点|明天|后天|每周|每天|每月|follow[- ]?up|到点|定期|周期/u.test(query);
}

function needsNotebookIntent(query: string) {
  return /notebook|ipynb|jupyter|单元格|cell|笔记本/u.test(query);
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

function stripSkillFrontmatter(source: string) {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return source.trim();
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      return lines.slice(index + 1).join("\n").trim();
    }
  }

  return source.trim();
}

function getSkillRelativeSourcePath(sourcePath: string) {
  return relative(skillsRootDir, sourcePath).replace(/\\/g, "/");
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
  const activeDefinitions = definitions.filter((skill) => {
    return skill.status === "available" && !TOOL_OWNED_SKILL_IDS.has(skill.id);
  });

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
  const browserSceneBlocksLocalMediaSkills = needsBrowserAutomation(normalizedQuery);

  const tokenDocumentFrequency = buildTokenDocumentFrequency(activeSkills);
  const scoredSkills = activeSkills
    .map((skill) => ({
      id: skill.id,
      blocked: browserSceneBlocksLocalMediaSkills && (skill.id === "video-reader" || skill.id === "music-listener"),
      score: (() => {
        const baseScore = scoreSkillMatch(skill, normalizedQuery, tokenDocumentFrequency, activeSkills.length);
        if (!stickySkillIds.has(skill.id)) {
          return baseScore;
        }

        return baseScore > 0 ? baseScore + 4 : 6;
      })(),
    }))
    .filter((entry) => !entry.blocked && entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  if (scoredSkills.length === 0) {
    return [...stickySkillIds];
  }

  const stickyEntries = scoredSkills.filter((entry) => stickySkillIds.has(entry.id));
  const nonStickyEntries = scoredSkills.filter((entry) => !stickySkillIds.has(entry.id));

  if (nonStickyEntries.length === 0) {
    return stickyEntries
      .filter((entry) => entry.score >= 6)
      .slice(0, MAX_SELECTED_SKILLS)
      .map((entry) => entry.id);
  }

  const topNonStickyScore = nonStickyEntries[0]?.score ?? 0;
  if (topNonStickyScore < 8) {
    return stickyEntries
      .filter((entry) => entry.score >= 6)
      .slice(0, MAX_SELECTED_SKILLS)
      .map((entry) => entry.id);
  }

  const minimumNonStickyScore = topNonStickyScore >= 24
    ? topNonStickyScore - 6
    : topNonStickyScore >= 14
      ? topNonStickyScore - 4
      : topNonStickyScore >= 8
        ? topNonStickyScore - 2
        : Math.max(4, topNonStickyScore);

  const selectedIds = new Set<string>();
  const orderedSelections: string[] = [];

  for (const entry of stickyEntries) {
    if (entry.score < 6) {
      continue;
    }
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

  const limitedSelections = orderedSelections.slice(0, MAX_SELECTED_SKILLS);

  if (limitedSelections.includes("thread-management") && limitedSelections.includes("system-info") && !needsSystemInfo(normalizedQuery)) {
    return limitedSelections.filter((id) => id !== "system-info");
  }

  if (limitedSelections.includes("thread-management") && limitedSelections.includes("scheduler") && !needsSchedulerIntent(normalizedQuery)) {
    return limitedSelections.filter((id) => id !== "scheduler");
  }

  if (limitedSelections.includes("thread-management") && limitedSelections.includes("notebook") && !needsNotebookIntent(normalizedQuery)) {
    return limitedSelections.filter((id) => id !== "notebook");
  }

  if (limitedSelections.includes("scheduler") && needsThreadManagement(normalizedQuery) && !needsSchedulerIntent(normalizedQuery)) {
    return limitedSelections.filter((id) => id !== "scheduler");
  }

  if (limitedSelections.includes("notebook") && needsThreadManagement(normalizedQuery) && !needsNotebookIntent(normalizedQuery)) {
    return limitedSelections.filter((id) => id !== "notebook");
  }

  if (limitedSelections.includes("send-file") && limitedSelections.includes("music-listener") && !needsAudioAnalysis(normalizedQuery)) {
    return limitedSelections.filter((id) => id !== "music-listener");
  }

  if (limitedSelections.includes("file-manager") && limitedSelections.includes("music-listener") && !needsAudioAnalysis(normalizedQuery)) {
    return limitedSelections.filter((id) => id !== "music-listener");
  }

  if (limitedSelections.includes("send-file") && limitedSelections.includes("file-manager") && !needsFileManagement(normalizedQuery)) {
    return limitedSelections.filter((id) => id !== "file-manager");
  }

  if (
    limitedSelections.includes("memory-management")
    && limitedSelections.includes("send-file")
    && !/(?:发文件|发送文件|上传文件|send file|attach file|upload file)/iu.test(normalizedQuery)
  ) {
    return limitedSelections.filter((id) => id !== "send-file");
  }

  return limitedSelections;
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
  staticSkillCatalogBlockCache = null;
  skillBodyCache.clear();
}

interface BuildSkillContextBlockOptions {
  browserRelayAvailable?: boolean;
  routeHints?: SkillRouteHints;
}

function getStaticSkillCatalogBlockState() {
  const catalog = getSkillCatalogCache();
  if (staticSkillCatalogBlockCache?.fingerprint === catalog.fingerprint) {
    return staticSkillCatalogBlockCache;
  }

  const content = [
    "Local skill catalog for this project.",
    `Skill catalog root: ${skillsRootDir}`,
    "Architecture rule: skills are AI-native instruction blocks selected from metadata; they are not workflow scripts.",
    "Use `use_skill` with the exact skill id when a catalog skill matches the task and is not already loaded.",
    "Start with the smallest relevant task skill. Add a second non-meta task skill only if execution truly requires it.",
    "Do not call `skill-hub` or `skill-search` just to inspect this catalog.",
    "Do not emit raw `<skill>...</skill>` tags in the reply.",
    "Skills usually work through bash, read, and write. A small set of native exceptions such as web_search, web_fetch, and view_image may appear only when the selected skill truly needs them.",
    "Capability judgment examples: website or platform interaction -> browser; exact page/original article/docs reading -> web-fetch; general current-info lookup -> web-search; sending a local file/photo into the conversation -> send-file; generating a new image/poster/avatar -> image-gen; managing threads/sessions -> thread-management; asking what skills/capabilities exist -> skill-hub or skill-search.",
    "Decision boundary: for shopping-site price checks, product lookup, and other factual reading tasks, prefer web-search / web-fetch first. Use browser only when the task truly needs interaction such as login, clicking, filling forms, captcha handling, or working with an existing visible tab.",
    "",
    "Available skills:",
    ...catalog.activeDefinitions.map((skill) => {
      return `- ${skill.label}: ${skill.description} [id=${skill.id}; ${getSkillRelativeSourcePath(skill.sourcePath)}]`;
    }),
  ].join("\n");

  staticSkillCatalogBlockCache = {
    fingerprint: catalog.fingerprint,
    content,
    key: computeSkillBlockKey(content),
  };

  return staticSkillCatalogBlockCache;
}

function getSkillBodyCacheEntry(skill: SkillDefinition) {
  const fingerprint = `${statSync(skill.sourcePath).mtimeMs}`;
  const cachedEntry = skillBodyCache.get(skill.id);
  if (cachedEntry?.fingerprint === fingerprint) {
    return cachedEntry;
  }

  const source = readFileSync(skill.sourcePath, "utf8");
  const body = stripSkillFrontmatter(source);
  const content = [
    `Loaded skill: ${skill.id}`,
    `Source: ${getSkillRelativeSourcePath(skill.sourcePath)}`,
    body,
  ].join("\n\n");
  const key = computeSkillBlockKey(content);
  const entry = {
    fingerprint,
    content,
    key,
  } satisfies SkillBodyCacheEntry;
  skillBodyCache.set(skill.id, entry);
  return entry;
}

export function buildStaticSkillCatalogBlock() {
  return getStaticSkillCatalogBlockState().content;
}

export function getStaticSkillCatalogKey() {
  return getStaticSkillCatalogBlockState().key;
}

export function buildSelectedSkillBodyBlock(skills: SkillDefinition[]) {
  const orderedSkills = [...skills].sort((a, b) => a.id.localeCompare(b.id));
  if (orderedSkills.length === 0) {
    return {
      content: "",
      keys: [] as string[],
    };
  }

  const entries = orderedSkills.map((skill) => ({
    skillId: skill.id,
    entry: getSkillBodyCacheEntry(skill),
  }));

  return {
    content: entries.map(({ entry }) => entry.content).join("\n\n"),
    keys: entries.map(({ skillId, entry }) => `${skillId}:${entry.key}`),
  };
}

export function buildSkillDynamicOverlay(skills: SkillDefinition[], options?: BuildSkillContextBlockOptions) {
  const orderedSkills = [...skills].sort((a, b) => a.id.localeCompare(b.id));
  const loadedSkillIds = orderedSkills.map((skill) => skill.id);
  const loadedSkillIdSet = new Set(loadedSkillIds);
  const sections: string[] = [];

  if (loadedSkillIds.length === 0) {
    sections.push("No extra local skill was selected for this turn.");
  } else {
    sections.push(`Loaded skill ids for this turn: ${loadedSkillIds.join(", ")}.`);
  }

  if ((options?.routeHints?.stickySkillIds.length ?? 0) > 0) {
    sections.push(`Relevant carry-forward skills from the immediate context: ${[...new Set(options?.routeHints?.stickySkillIds ?? [])].sort((a, b) => a.localeCompare(b)).join(", ")}.`);
  }

  if (loadedSkillIdSet.has("web-search") || loadedSkillIdSet.has("web-fetch")) {
    sections.push("Routing priority: when the user needs exact factual verification, current metrics, dates, or source-backed corrections, treat web_search as the default first step and only route web_fetch when a specific page still needs to be read.");
    sections.push("Source priority: primary platform pages and clearly dated sources come before encyclopedia overviews; 百度百科 is extremely low priority for live facts.");
    sections.push("Research memory rule: keep a running evidence ledger. Search results are discovery only, and the next web_fetch should target the strongest unfetched candidate URL from the ledger instead of restarting the topic from scratch.");
  }

  if (loadedSkillIdSet.has("system-info")) {
    sections.push("system-info: use it for current local time, date, weekday, or host diagnostics. It can call bash commands such as date, sw_vers, df -h, or uptime.");
  }

  if (loadedSkillIdSet.has("browser")) {
    if (options?.browserRelayAvailable) {
      sections.push("Browser runtime status for this turn: a healthy visible Aliceloop Desktop Chrome relay is available right now.");
    } else {
      sections.push("Browser runtime status for this turn: no healthy desktop relay is currently registered, so browser automation should use PinchTab instead of the relay.");
    }
  }

  return sections.join("\n");
}

export function buildSkillContextBlock(skills: SkillDefinition[], options?: BuildSkillContextBlockOptions) {
  return [
    buildStaticSkillCatalogBlock(),
    buildSelectedSkillBodyBlock(skills).content,
    buildSkillDynamicOverlay(skills, options),
  ].filter(Boolean).join("\n\n");
}
