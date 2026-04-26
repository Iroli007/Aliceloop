export interface SkillRouteHints {
  stickySkillIds: string[];
  reasons: string[];
}

export interface TurnIntentDecision {
  normalizedQuery: string;
  needs: {
    memoryFactRecall: boolean;
    episodicHistoryRecall: boolean;
    threadManagement: boolean;
    webResearch: boolean;
    webFetch: boolean;
    systemInfo: boolean;
    fileManagement: boolean;
    cameraCapture: boolean;
    browserAutomation: boolean;
    audioAnalysis: boolean;
    imageAnalysis: boolean;
    documentIngest: boolean;
    reviewCoach: boolean;
    deepResearchFetch: boolean;
    toolDiscovery: boolean;
  };
  routeHints: SkillRouteHints;
  toolNames: string[];
}

interface TurnIntentDecisionOptions {
  hints?: SkillRouteHints;
  hasImageAttachment?: boolean;
  recentToolNames?: string[];
  continuationLike?: boolean;
  researchContinuation?: boolean;
  loginOrQrContinuation?: boolean;
  fileManagementContinuation?: boolean;
}

export function mergeSkillRouteHints(...hintSets: Array<SkillRouteHints | null | undefined>): SkillRouteHints {
  const stickySkillIds = new Set<string>();
  const reasons = new Set<string>();

  for (const hints of hintSets) {
    if (!hints) {
      continue;
    }

    for (const skillId of hints.stickySkillIds) {
      stickySkillIds.add(skillId);
    }
    for (const reason of hints.reasons) {
      reasons.add(reason);
    }
  }

  return {
    stickySkillIds: [...stickySkillIds],
    reasons: [...reasons],
  };
}

function matches(query: string, pattern: RegExp) {
  return pattern.test(query);
}

function hasStickySkill(hints: SkillRouteHints | undefined, skillId: string) {
  return hints?.stickySkillIds.includes(skillId) ?? false;
}

const MEMORY_FACT_QUERY_PATTERN = /记忆|memory|记住|忘掉|forget|偏好|事实|稳定|长期|profile|account|fact|还记得|记不记得|记得我|我的偏好|我的习惯|记一下|帮我记住/u;
const EPISODIC_HISTORY_QUERY_PATTERN = /聊天记录|历史会话|之前的对话|上次对话|conversation history|episodic history|上次聊|刚才说|之前说过|之前聊过|我们聊到哪|昨晚|昨天晚上|昨天聊|昨晚跟你说|昨天跟你说|今天我们做了什么|今天做了什么|今天都做了什么|今天聊了什么|今天聊了啥|我们今天聊了什么|我们今天做了什么|(?:这个|上个)?(?:线程|thread|会话|session).*(?:聊了什么|说了什么|提到什么|记录)/iu;
const THREAD_MANAGEMENT_QUERY_PATTERN = /线程管理|管理线程|^threads?$|thread\s+(?:list|info|delete|new|search)|thread id|线程\s*(?:列表|清单|id|信息|详情|删除|新建|创建|搜索|查找|切换|打开)|会话\s*(?:列表|清单|id|信息|详情|删除|新建|创建|搜索|查找|切换|打开)|列出.*(?:线程|会话)|删除.*(?:线程|会话)|新建.*(?:线程|会话)|创建.*(?:线程|会话)|打开.*(?:线程|会话)|切换.*(?:线程|会话)/iu;
const TOOL_DISCOVERY_QUERY_PATTERN =
  /(?:能不能|可以|可不可以)?(?:帮我|帮忙|给我)?(?:看|查|列|说)(?:一下)?(?:你|当前|本轮|这里|这个(?:runtime|agent)?|aliceloop)?.{0,16}(?:有哪些|有什么|支持|可用|能用).{0,24}(?:tools?|skills?|能力|工具|技能)|(?:你|我|当前|本轮|这里|这个(?:runtime|agent)?|aliceloop).{0,24}(?:有哪些|有什么|支持|可用|能用).{0,24}(?:tools?|skills?|能力|工具|技能)|(?:有哪些|有什么|支持|可用|能用).{0,24}(?:tools?|skills?|能力|工具|技能).{0,16}(?:你|当前|本轮|这里|这个(?:runtime|agent)?|aliceloop)|(?:怎么|如何).{0,12}(?:测试|验证).{0,24}(?:你|当前|本轮|这里|aliceloop)?.{0,24}(?:tools?|skills?|能力|工具|技能)|(?:可用|支持).{0,12}(?:tools?|skills?|能力|工具|技能)|(?:tools?|skills?|能力|工具|技能).{0,12}(?:列表|清单|目录|catalog|list)|(?:what|which).{0,16}(?:tools?|skills?|capabilit(?:y|ies)).{0,16}(?:do you have|are available|can you use)|\b(?:available tools?|tool list|skill list|available skills?|runtime tools?|tool catalog|skill catalog)\b/iu;
const DEEP_RESEARCH_FETCH_PATTERN =
  /深度研究|深入研究|深挖|深扒|别偷懒|别只看摘要|别看摘要|去读|读一下|看原文|看正文|看全文|看来源|看帖子|看词条|看页面|补完|补全|继续深挖|继续深查|继续研究|现在什么情况|现在咋样|现在怎么样|最新情况|有进展吗|进展如何|怎么样了|情况怎么样|还有进展吗/u;

export function needsMemoryFactRecall(query: string) {
  return matches(query, MEMORY_FACT_QUERY_PATTERN);
}

export function needsEpisodicHistoryRecall(query: string) {
  return matches(query, EPISODIC_HISTORY_QUERY_PATTERN);
}

export function needsThreadManagement(query: string) {
  return matches(query, THREAD_MANAGEMENT_QUERY_PATTERN);
}

export function needsWebResearch(query: string) {
  if (needsToolDiscovery(query)) {
    return false;
  }
  return matches(
    query,
    /^search$|^web[\s_-]?search$|^websearch$|搜索|搜一下|搜一搜|搜搜看|research|调查|fact-?check|验证|核对|确认|准确|准不准|可靠吗|可靠性|事实依据|来源|source|天气|温度|粉丝|关注者|播放|点赞|价格|汇率|比分|政策|新闻|官网|网址|链接|url|https?:\/\/|网上.*(好玩|有意思|新鲜事)|互联网.*(好玩|有意思)|上网.*看看|搜搜看/iu,
  );
}

export function needsWebFetch(query: string) {
  return matches(
    query,
    /^fetch$|^web[\s_-]?fetch$|^webfetch$|https?:\/\/|读取网页|读网页|打开页面|查看页面|查看网页|页面内容|网页内容|原文|正文|全文|精确页面|具体页面|文档页|docs?|release notes?|api response|article|summarize|总结文章|inspect|阅读|抓取页面|fetch page|webpage|release note|release notes|docs page/iu,
  );
}

export function needsSystemInfo(query: string) {
  return matches(
    query,
    /系统信息|电脑|内存|cpu|端口|进程|磁盘|network|网络|system info|system health|host diagnostics|当前时间|现在几点|几点了|当前日期|今天几号|今天是几月几号|今天不是\d{1,2}号吗|今天.*(几号|号吗|星期几|周几|周几来着|日期)|周几|星期几|weekday|clock|uptime|系统版本|os version|battery|电池|时间感知|时间不清楚/iu,
  );
}

export function needsFileManagement(query: string) {
  return matches(
    query,
    /文件管理|管理文件|管理文件夹|整理文件|整理文件夹|清理文件|清理文件夹|清空回收站|回收站|垃圾桶|清缓存|清理缓存|cache|缓存|大文件夹|大文件|占空间|磁盘清理|目录大小|folder size|disk usage|du -sh|下载目录|downloads|桌面整理|workspace.*大文件|找大文件|查大文件|move files|rename files|organize files|clean up files/iu,
  );
}

export function needsCameraCapture(query: string) {
  return matches(
    query,
    /摄像头|相机|自拍|拍张.*照片|拍个.*照片|拍照|拍一张|照相|webcam|camera|take .*photo|take .*picture|take a selfie|capture photo|capture image|imagesnap|ffmpeg/u,
  );
}

export function needsBrowserAutomation(query: string) {
  return matches(
    query,
    /浏览器|browser|browser relay|browser_click|browser_open|browser_type|agent-browser|@jackwener\/opencli|opencli|网页|页面|网站|打开.*(网页|页面|网站)|导航|navigate|登录|login|点击|click|按钮|表单|输入|截图|screenshot|tab|标签页|滚动|scroll|回复|评论|回帖|发帖|留言|私信|关注|点赞|转发|发布|对线|回怼|互动|刷|刷视频|刷推特|刷抖音|刷b站|刷微博|刷首页|刷推荐|逛|逛站|逛主页|看主页|看视频|看帖子|看推文|播放页|播放器|播放控件|继续看|继续看下去|视频后面|feed|timeline|时间线|推荐流|信息流|二维码|扫码|扫码登录|登录页|验证码|验证页|auth|signin|sign-in|上网冲浪|冲浪一下|网上冲浪|到网上逛逛|去网上逛逛|让它上网冲浪一下|b站.*(上网|逛|刷|登录)|深入.*b站/u,
  );
}

export function needsAudioAnalysis(query: string) {
  return matches(query, /音频|audio|voice note|语音|播客|录音|旁白|台词|转写|转录|transcribe audio|音乐|歌曲|song|music|这首歌|这段音频|这个音频|这段录音|这个录音/iu);
}

export function needsImageAnalysis(query: string) {
  return matches(
    query,
    /看图|识图|读图|分析图片|分析图像|图片内容|图里|图中|图片里|图上的|图中的|这张图|这幅图|这图|这四个字|这几个字|文字识别|OCR|看一下图片|看看图片|image understanding|analyze image|analyze the image|what is in this image|what's in this image|describe image/iu,
  );
}

export function needsDocumentIngest(query: string) {
  return matches(query, /document[_ -]?ingest|ingest document|导入文档|摄取文档|建立索引|文档入库/iu);
}

export function needsReviewCoach(query: string) {
  return matches(query, /review[_ -]?coach|复盘笔记|反思笔记|review note|review memory/iu);
}

export function prefersDeepResearchFetch(query: string) {
  return matches(query.trim(), DEEP_RESEARCH_FETCH_PATTERN);
}

export function needsToolDiscovery(query: string) {
  return matches(query, TOOL_DISCOVERY_QUERY_PATTERN);
}

function buildBaseStickySkillIds(query: string) {
  const stickySkillIds = new Set<string>();

  if (needsMemoryFactRecall(query) || needsEpisodicHistoryRecall(query)) {
    stickySkillIds.add("memory-management");
  }
  if (needsThreadManagement(query)) {
    stickySkillIds.add("thread-management");
  }
  if (needsWebResearch(query)) {
    stickySkillIds.add("web-search");
  }
  if (needsSystemInfo(query)) {
    stickySkillIds.add("system-info");
  }
  if (needsFileManagement(query)) {
    stickySkillIds.add("file-manager");
  }
  if (needsCameraCapture(query)) {
    stickySkillIds.add("selfie");
  }
  if (needsBrowserAutomation(query)) {
    stickySkillIds.add("browser");
  }
  if (needsAudioAnalysis(query)) {
    stickySkillIds.add("music-listener");
  }
  if (matches(query, /视频文件|video file|本地视频|上传.*视频|发了.*视频|\.mp4\b|\.mov\b|\.mkv\b|\.webm\b|\.avi\b|\.m4v\b|\.3gp\b/iu)) {
    stickySkillIds.add("video-reader");
  }
  if (needsToolDiscovery(query)) {
    stickySkillIds.add("skill-hub");
    stickySkillIds.add("skill-search");
  }
  if (matches(query, /继续|接着|go on|resume|恢复/iu)) {
    stickySkillIds.add("continue");
  }

  return [...stickySkillIds];
}

export function inferStickySkillIdsFromContext(query: string) {
  return buildTurnIntentDecision(query).routeHints.stickySkillIds;
}

export function buildTurnIntentDecision(
  query: string | null | undefined,
  options?: TurnIntentDecisionOptions,
): TurnIntentDecision {
  const normalizedQuery = query?.trim() ?? "";
  const needs = {
    memoryFactRecall: needsMemoryFactRecall(normalizedQuery),
    episodicHistoryRecall: needsEpisodicHistoryRecall(normalizedQuery),
    threadManagement: needsThreadManagement(normalizedQuery),
    webResearch: needsWebResearch(normalizedQuery),
    webFetch: needsWebFetch(normalizedQuery),
    systemInfo: needsSystemInfo(normalizedQuery),
    fileManagement: needsFileManagement(normalizedQuery),
    cameraCapture: needsCameraCapture(normalizedQuery),
    browserAutomation: needsBrowserAutomation(normalizedQuery),
    audioAnalysis: needsAudioAnalysis(normalizedQuery),
    imageAnalysis: needsImageAnalysis(normalizedQuery),
    documentIngest: needsDocumentIngest(normalizedQuery),
    reviewCoach: needsReviewCoach(normalizedQuery),
    deepResearchFetch: prefersDeepResearchFetch(normalizedQuery),
    toolDiscovery: needsToolDiscovery(normalizedQuery),
  };
  const recentToolNames = options?.recentToolNames ?? [];
  const sawRecentWebTool = recentToolNames.some((toolName) => toolName === "web_search" || toolName === "web_fetch");
  const sawRecentWebFetchTool = recentToolNames.some((toolName) => toolName === "web_fetch");
  const sawRecentBrowserTool = recentToolNames.some((toolName) => toolName.startsWith("browser_"));
  const stickySkillIds = new Set([
    ...buildBaseStickySkillIds(normalizedQuery),
    ...(options?.hints?.stickySkillIds ?? []),
  ]);
  const reasons = new Set(options?.hints?.reasons ?? []);
  const needsDeepResearchFollowup = needs.deepResearchFetch && (sawRecentWebTool || hasStickySkill(options?.hints, "web-search"));

  if (
    options?.researchContinuation
    || (options?.continuationLike && sawRecentWebTool)
    || needs.webResearch
    || needsDeepResearchFollowup
  ) {
    stickySkillIds.add("web-search");
    reasons.add("carry forward live research/fact-check tools");
  }

  if (
    (options?.continuationLike && sawRecentWebFetchTool)
    || needs.webFetch
    || needsDeepResearchFollowup
  ) {
    stickySkillIds.add("web-fetch");
    reasons.add("carry forward recent page reading");
  }

  if (
    (options?.continuationLike && sawRecentBrowserTool)
    || (options?.continuationLike && needs.browserAutomation)
    || (options?.continuationLike && options.loginOrQrContinuation)
  ) {
    stickySkillIds.add("browser");
    reasons.add("carry forward recent browser context");
  }

  if (options?.fileManagementContinuation) {
    stickySkillIds.add("file-manager");
    reasons.add("carry forward recent file-management context");
  }

  const routeHints = {
    stickySkillIds: [...stickySkillIds],
    reasons: [...reasons],
  };
  const toolNames = new Set<string>();

  if (needs.fileManagement || options?.fileManagementContinuation || needs.cameraCapture || needs.systemInfo) {
    toolNames.add("bash");
  }

  if (needs.toolDiscovery || hasStickySkill(routeHints, "skill-hub") || hasStickySkill(routeHints, "skill-search")) {
    toolNames.add("tool_search");
  }

  if (needs.webResearch || hasStickySkill(routeHints, "web-search")) {
    toolNames.add("web_search");
  }

  if (needs.webFetch || hasStickySkill(routeHints, "web-fetch") || (needs.deepResearchFetch && hasStickySkill(routeHints, "web-search"))) {
    toolNames.add("web_fetch");
  }

  if (needs.browserAutomation || hasStickySkill(routeHints, "browser")) {
    toolNames.add("view_image");
    toolNames.add("browser_find");
    toolNames.add("browser_snapshot");
    toolNames.add("browser_navigate");
    toolNames.add("browser_wait");
    toolNames.add("browser_click");
    toolNames.add("browser_type");
    toolNames.add("browser_scroll");
    toolNames.add("browser_screenshot");
    toolNames.add("browser_media_probe");
    toolNames.add("browser_video_watch_start");
    toolNames.add("browser_video_watch_poll");
    toolNames.add("browser_video_watch_stop");
  }

  if (needs.documentIngest) {
    toolNames.add("document_ingest");
  }

  if (needs.reviewCoach) {
    toolNames.add("review_coach");
  }

  if (options?.hasImageAttachment || needs.imageAnalysis) {
    toolNames.add("view_image");
  }

  return {
    normalizedQuery,
    needs,
    routeHints,
    toolNames: [...toolNames].sort(),
  };
}
