import type { SkillDefinition } from "@aliceloop/runtime-core";

export type SkillGroupId =
  | "research-core"
  | "browser-interaction"
  | "coding-workflow"
  | "social-platform"
  | "skill-catalog"
  | "system-ops"
  | "task-workflow"
  | "memory-state"
  | "media-workflow";

export interface SkillRouteHints {
  stickySkillIds: string[];
  stickyGroupIds: SkillGroupId[];
  reasons: string[];
}

export function mergeSkillRouteHints(...hintSets: Array<SkillRouteHints | null | undefined>): SkillRouteHints {
  const stickySkillIds = new Set<string>();
  const stickyGroupIds = new Set<SkillGroupId>();
  const reasons = new Set<string>();

  for (const hints of hintSets) {
    if (!hints) {
      continue;
    }

    for (const skillId of hints.stickySkillIds) {
      stickySkillIds.add(skillId);
    }
    for (const groupId of hints.stickyGroupIds) {
      stickyGroupIds.add(groupId);
    }
    for (const reason of hints.reasons) {
      reasons.add(reason);
    }
  }

  return {
    stickySkillIds: [...stickySkillIds],
    stickyGroupIds: [...stickyGroupIds],
    reasons: [...reasons],
  };
}

const SKILL_GROUP_LABELS: Record<SkillGroupId, string> = {
  "research-core": "Research Core",
  "browser-interaction": "Browser Interaction",
  "coding-workflow": "Coding Workflow",
  "social-platform": "Social Platform",
  "skill-catalog": "Skill Catalog",
  "system-ops": "System Ops",
  "task-workflow": "Task Workflow",
  "memory-state": "Memory & State",
  "media-workflow": "Media Workflow",
};

const SKILL_GROUP_MEMBERS: Record<SkillGroupId, string[]> = {
  "research-core": ["web-search", "web-fetch"],
  "browser-interaction": ["browser"],
  "coding-workflow": ["coding-agent"],
  "social-platform": ["twitter-media", "xiaohongshu", "telegram", "discord"],
  "skill-catalog": ["skill-discovery", "skill-hub"],
  "system-ops": ["system-info", "file-manager", "screenshot"],
  "task-workflow": ["scheduler", "tasks", "todo", "plan-mode", "notebook"],
  "memory-state": ["memory-management", "self-management", "self-reflection", "thread-management", "reactions"],
  "media-workflow": ["audio-analysis", "video-analysis", "voice", "image-gen", "music-gen", "send-file"],
};

const SKILL_TO_GROUPS = new Map<string, SkillGroupId[]>(
  Object.entries(SKILL_GROUP_MEMBERS).flatMap(([groupId, skillIds]) => {
    return skillIds.map((skillId) => [skillId, [groupId as SkillGroupId]]);
  }),
);

function matches(query: string, pattern: RegExp) {
  return pattern.test(query);
}

export function needsWebResearch(query: string) {
  return matches(
    query,
    /查|搜|搜索|research|fact-?check|验证|核对|确认|准确|准不准|可靠吗|可靠性|事实依据|来源|source|最新|当前|最近|今天|日期|几月几日|天气|温度|粉丝|关注者|播放|点赞|价格|汇率|比分|政策|新闻|官网|网址|链接|url|https?:\/\/|网上.*(好玩|有意思|新鲜事)|互联网.*(好玩|有意思)|上网.*看看|搜搜看/u,
  );
}

export function needsWebFetch(query: string) {
  return matches(
    query,
    /https?:\/\/|读取网页|读网页|打开页面|查看页面|查看网页|页面内容|网页内容|原文|正文|全文|精确页面|具体页面|文档页|docs?|release notes?|api response|article|summarize|总结文章|inspect|阅读|抓取页面|fetch page|webpage|release note|release notes|docs page/iu,
  );
}

export function needsSystemInfo(query: string) {
  return matches(
    query,
    /系统信息|电脑|内存|cpu|端口|进程|磁盘|network|网络|system info|system health|host diagnostics|当前时间|现在几点|几点了|当前日期|今天几号|今天是几月几号|今天不是\d{1,2}号吗|今天.*(几号|号吗|星期几|周几|周几来着|日期)|周几|星期几|weekday|clock|uptime|系统版本|os version|battery|电池|时间感知|时间不清楚/iu,
  );
}

export function needsBrowserAutomation(query: string) {
  return matches(
    query,
    /浏览器|browser|browser relay|browser_click|browser_open|browser_type|网页|页面|网站|打开.*(网页|页面|网站)|导航|navigate|登录|login|点击|click|按钮|表单|输入|截图|screenshot|tab|标签页|滚动|scroll|回复|评论|回帖|发帖|留言|私信|关注|点赞|转发|发布|对线|回怼|互动|刷|刷视频|刷推特|刷抖音|刷b站|刷微博|刷首页|刷推荐|逛|逛站|逛主页|看主页|看视频|看帖子|看推文|播放页|播放器|播放控件|继续看|继续看下去|视频后面|feed|timeline|时间线|推荐流|信息流|二维码|扫码|扫码登录|登录页|验证码|验证页|auth|signin|sign-in|上网冲浪|冲浪一下|网上冲浪|到网上逛逛|去网上逛逛|让它上网冲浪一下|b站.*(上网|逛|刷|登录)|深入.*b站/u,
  );
}

export function needsAudioAnalysis(query: string) {
  return matches(query, /音频|audio|voice note|语音|播客|录音|旁白|台词|转写|转录|听一下|听听|听懂|念了什么|说了什么|transcribe audio/iu);
}

export function needsCodingAgent(query: string) {
  return matches(query, /代码|仓库|repo|project|项目|文件|修复|bug|报错|重构|实现|开发|typecheck|build|测试|test|脚本修改|源码/iu);
}

export function needsDocumentIngest(query: string) {
  return matches(query, /document[_ -]?ingest|ingest document|导入文档|摄取文档|建立索引|文档入库/iu);
}

export function needsReviewCoach(query: string) {
  return matches(query, /review[_ -]?coach|复盘笔记|反思笔记|review note|review memory/iu);
}

function hasStickySkill(hints: SkillRouteHints | undefined, skillId: string) {
  return hints?.stickySkillIds.includes(skillId) ?? false;
}

export function getSkillGroupIdsForSkill(skillId: string): SkillGroupId[] {
  return SKILL_TO_GROUPS.get(skillId) ?? [];
}

export function getSkillGroupLabel(groupId: SkillGroupId) {
  return SKILL_GROUP_LABELS[groupId];
}

export function inferStickySkillIdsFromContext(query: string) {
  const stickySkillIds = new Set<string>();

  if (matches(query, /twitter|x\.com|推特|tweet|推文/iu)) {
    stickySkillIds.add("twitter-media");
  }
  if (matches(query, /小红书|xiaohongshu|rednote|xhs/iu)) {
    stickySkillIds.add("xiaohongshu");
  }
  if (matches(query, /telegram|\btg\b|电报/iu)) {
    stickySkillIds.add("telegram");
  }
  if (matches(query, /discord|webhook/iu)) {
    stickySkillIds.add("discord");
  }
  if (matches(query, /技能|skill|能力|会什么|能做什么|有哪些工具|browser_click|browser_open|browser_type|tool(s)?/iu)) {
    stickySkillIds.add("skill-discovery");
    stickySkillIds.add("skill-hub");
  }
  if (matches(query, /系统信息|电脑|内存|cpu|端口|进程|磁盘|network|网络|system info|browser relay|relay 开关|relay连接|relay 连接/iu)) {
    stickySkillIds.add("system-info");
  }
  if (matches(query, /截图|screen|screenshot|当前界面|屏幕/iu)) {
    stickySkillIds.add("screenshot");
  }
  if (matches(query, /任务|计划|todo|待办|排期|schedule|scheduler|cron|提醒/iu)) {
    stickySkillIds.add("tasks");
    stickySkillIds.add("todo");
    stickySkillIds.add("scheduler");
  }
  if (matches(query, /记忆|memory|记住|忘掉|forget|线程|thread|会话|session/iu)) {
    stickySkillIds.add("memory-management");
    stickySkillIds.add("thread-management");
  }
  if (needsSystemInfo(query)) {
    stickySkillIds.add("system-info");
  }

  return [...stickySkillIds];
}

export function inferStickySkillGroupIdsFromContext(query: string): SkillGroupId[] {
  const groupIds = new Set<SkillGroupId>();

  if (needsWebResearch(query) || needsWebFetch(query)) {
    groupIds.add("research-core");
  }
  if (needsSystemInfo(query)) {
    groupIds.add("system-ops");
  }
  if (needsBrowserAutomation(query)) {
    groupIds.add("browser-interaction");
  }
  if (needsCodingAgent(query)) {
    groupIds.add("coding-workflow");
  }
  if (matches(query, /twitter|x\.com|推特|tweet|推文|小红书|xiaohongshu|rednote|xhs|telegram|\btg\b|电报|discord|微博|b站|哔哩哔哩|抖音/iu)) {
    groupIds.add("social-platform");
  }
  if (matches(query, /技能|skill|能力|browser_click|browser_open|browser_type|browser relay|tool(s)?|工具(有哪些|缺失|丢了|没了)?/iu)) {
    groupIds.add("skill-catalog");
  }
  if (matches(query, /系统信息|电脑|内存|cpu|端口|进程|磁盘|network|网络|system info|截图|screen|screenshot|当前界面|屏幕|browser relay|relay 开关|relay连接|relay 连接/iu)) {
    groupIds.add("system-ops");
  }
  if (matches(query, /任务|计划|todo|待办|排期|schedule|scheduler|cron|提醒|notebook|笔记本/iu)) {
    groupIds.add("task-workflow");
  }
  if (matches(query, /记忆|memory|记住|忘掉|forget|线程|thread|会话|session|反思|reflection/iu)) {
    groupIds.add("memory-state");
  }
  if (matches(query, /音频|audio|视频|video|voice|语音|音乐|music|图片|image|截图发送|发文件|send file/iu)) {
    groupIds.add("media-workflow");
  }

  return [...groupIds];
}

function listCoreSkillIdsForGroup(groupId: SkillGroupId, query: string): string[] {
  switch (groupId) {
    case "research-core":
      return ["web-search"];
    case "browser-interaction":
      return ["browser"];
    case "coding-workflow":
      return ["coding-agent"];
    case "skill-catalog":
      return ["skill-discovery", "skill-hub"];
    case "system-ops": {
      const skillIds = ["system-info"];
      if (matches(query, /截图|screen|screenshot|当前界面|屏幕/iu)) {
        skillIds.push("screenshot");
      }
      if (matches(query, /文件管理|整理文件|移动文件|重命名文件|压缩文件|file manager/iu)) {
        skillIds.push("file-manager");
      }
      return skillIds;
    }
    case "task-workflow": {
      const skillIds: string[] = [];
      if (matches(query, /任务|track|durable|steps?|长期工作/iu)) {
        skillIds.push("tasks");
      }
      if (matches(query, /todo|待办|checklist|清单/iu)) {
        skillIds.push("todo");
      }
      if (matches(query, /schedule|scheduler|cron|提醒|定时/iu)) {
        skillIds.push("scheduler");
      }
      if (matches(query, /plan|规划|步骤|执行前计划/iu)) {
        skillIds.push("plan-mode");
      }
      if (matches(query, /notebook|ipynb|jupyter/iu)) {
        skillIds.push("notebook");
      }
      return skillIds;
    }
    case "memory-state": {
      const skillIds: string[] = [];
      if (matches(query, /记忆|memory|记住|忘掉|forget/iu)) {
        skillIds.push("memory-management");
      }
      if (matches(query, /线程|thread|会话|session/iu)) {
        skillIds.push("thread-management");
      }
      if (matches(query, /配置|runtime|provider|模型设置|sandbox|alice自己/iu)) {
        skillIds.push("self-management");
      }
      if (matches(query, /反思|reflection|日记|retrospective/iu)) {
        skillIds.push("self-reflection");
      }
      return skillIds;
    }
    case "media-workflow": {
      const skillIds: string[] = [];
      if (needsAudioAnalysis(query)) {
        skillIds.push("audio-analysis");
      }
      if (matches(query, /视频|video|片段|clip|播放页|播放器|继续看|视频后面/iu)) {
        skillIds.push("video-analysis");
      }
      if (matches(query, /voice|语音合成|朗读|speak/iu)) {
        skillIds.push("voice");
      }
      if (matches(query, /生成图|image generate|图片生成/iu)) {
        skillIds.push("image-gen");
      }
      if (matches(query, /音乐|music|midi/iu)) {
        skillIds.push("music-gen");
      }
      if (matches(query, /发文件|发送文件|send file|attach file/iu)) {
        skillIds.push("send-file");
      }
      return skillIds;
    }
    case "social-platform":
      return inferStickySkillIdsFromContext(query).filter((skillId) => {
        return SKILL_GROUP_MEMBERS["social-platform"].includes(skillId);
      });
    default:
      return [];
  }
}

export function expandRoutedSkillIds(
  directSkillIds: string[],
  query: string,
  hints?: SkillRouteHints,
) {
  const routedSkillIds = new Set<string>([...directSkillIds, ...(hints?.stickySkillIds ?? [])]);
  const activeGroupIds = new Set<SkillGroupId>(hints?.stickyGroupIds ?? []);

  for (const skillId of routedSkillIds) {
    for (const groupId of getSkillGroupIdsForSkill(skillId)) {
      activeGroupIds.add(groupId);
    }
  }

  for (const groupId of activeGroupIds) {
    for (const skillId of listCoreSkillIdsForGroup(groupId, query)) {
      routedSkillIds.add(skillId);
    }
  }

  return {
    routedSkillIds: [...routedSkillIds],
    activeGroupIds: [...activeGroupIds],
  };
}

export function isRelevantSkillForTurn(
  skill: SkillDefinition,
  query: string,
  hints?: SkillRouteHints,
) {
  if (hasStickySkill(hints, skill.id)) {
    return true;
  }

  switch (skill.id) {
    case "web-search":
      return needsWebResearch(query);
    case "web-fetch":
      return needsWebFetch(query);
    case "browser":
      return needsBrowserAutomation(query);
    case "coding-agent":
      return needsCodingAgent(query);
    case "xiaohongshu":
      return matches(query, /小红书|xiaohongshu|rednote|xhs/iu);
    case "telegram":
      return matches(query, /telegram|\btg\b|电报/iu);
    case "discord":
      return matches(query, /discord|webhook/iu);
    case "twitter-media":
      return matches(query, /twitter|x\.com|推特|tweet|帖子链接/iu);
    case "skill-discovery":
    case "skill-hub":
      return matches(query, /技能|skill|能力|会什么|能做什么|有哪些工具|browser_click|browser_open|browser_type|browser relay|工具(有哪些|缺失|丢了|没了)?/iu);
    case "system-info":
      return matches(query, /系统信息|电脑|内存|cpu|端口|进程|磁盘|network|网络|system info|system health|host diagnostics|browser relay|relay 开关|relay连接|relay 连接|当前时间|现在几点|几点了|当前日期|今天几号|今天是几月几号|今天不是\d{1,2}号吗|今天.*(几号|号吗|星期几|周几|周几来着|日期)|周几|星期几|weekday|clock|uptime|系统版本|os version|battery|电池|时间感知|时间不清楚/iu);
    case "screenshot":
      return matches(query, /截图|screen|screenshot|当前界面|屏幕/iu);
    case "video-analysis":
      return matches(query, /看视频|读视频|分析视频|视频内容|总结视频|讲了什么|说了什么|视频里|播放页|播放器|继续看|继续看下去|视频后面|video analysis|analyze video|watch video|video content/iu);
    case "send-file":
      return matches(query, /发文件|发送文件|上传文件|send file|attach file|发送照片|send photo/iu);
    case "tasks":
      return matches(query, /任务追踪|tracked task|长期任务|多步骤任务|task list/iu);
    case "todo":
      return matches(query, /todo|待办|checklist|清单/iu);
    case "scheduler":
      return matches(query, /schedule|scheduler|cron|提醒|定时/iu);
    case "plan-mode":
      return matches(query, /plan mode|规划模式|先计划|执行前计划/iu);
    case "memory-management":
      return matches(query, /记忆|memory|记住|忘掉|forget/iu);
    case "thread-management":
      return matches(query, /线程|thread|会话|session/iu);
    case "self-management":
      return matches(query, /配置|runtime|provider|模型设置|sandbox|alice自己/iu);
    case "self-reflection":
      return matches(query, /反思|reflection|日记|retrospective/iu);
    case "audio-analysis":
      return needsAudioAnalysis(query);
    case "voice":
      return matches(query, /voice|语音合成|朗读|speak/iu);
    case "image-gen":
      return matches(query, /生成图|image generate|图片生成/iu);
    case "music-gen":
      return matches(query, /音乐|music|midi/iu);
    case "file-manager":
      return matches(query, /文件管理|整理文件|移动文件|重命名文件|压缩文件|file manager/iu);
    default:
      return false;
  }
}
