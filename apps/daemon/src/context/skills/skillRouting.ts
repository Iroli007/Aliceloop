export interface SkillRouteHints {
  stickySkillIds: string[];
  reasons: string[];
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

const MEMORY_FACT_QUERY_PATTERN = /记忆|memory|记住|忘掉|forget|偏好|事实|稳定|长期|profile|account|fact|还记得|记不记得|记得我|我的偏好|我的习惯|记一下|帮我记住/u;
const EPISODIC_HISTORY_QUERY_PATTERN = /聊天记录|历史会话|之前的对话|上次对话|conversation history|episodic history|上次聊|刚才说|之前说过|之前聊过|我们聊到哪|昨晚|昨天晚上|昨天聊|昨晚跟你说|昨天跟你说|今天我们做了什么|今天做了什么|今天都做了什么|今天聊了什么|今天聊了啥|我们今天聊了什么|我们今天做了什么|(?:这个|上个)?(?:线程|thread|会话|session).*(?:聊了什么|说了什么|提到什么|记录)/iu;
const THREAD_MANAGEMENT_QUERY_PATTERN = /线程管理|管理线程|^threads?$|thread\s+(?:list|info|delete|new|search)|thread id|线程\s*(?:列表|清单|id|信息|详情|删除|新建|创建|搜索|查找|切换|打开)|会话\s*(?:列表|清单|id|信息|详情|删除|新建|创建|搜索|查找|切换|打开)|列出.*(?:线程|会话)|删除.*(?:线程|会话)|新建.*(?:线程|会话)|创建.*(?:线程|会话)|打开.*(?:线程|会话)|切换.*(?:线程|会话)/iu;
const TASK_TRACKING_QUERY_PATTERN = /(?:活跃|当前|进行中|全局|长期|跟踪|追踪|状态|进度|列表|清单|running|queued|done|failed|tracked)\s*(?:任务|tasks?)|(?:任务|tasks?)\s*(?:列表|清单|状态|进度|追踪|跟踪|list|show|status|progress)|(?:列出|列一下|查看|显示|有哪些).{0,6}(?:活跃|当前|进行中|全局)?.{0,4}(?:任务|tasks?)/iu;
const TODO_CHECKLIST_QUERY_PATTERN = /待办|todo|checklist|待办列表|待办清单|todo list|任务清单/u;
const EXPLICIT_WEB_LOOKUP_QUERY_PATTERN = /(?:^|[，。！？\s])(?:帮我|请|麻烦|给我)?(?:查一下|查查|搜一下|搜搜|搜索一下)(?!\s*(?:文件|文件夹|目录|线程|会话|任务|待办|todo|记忆|memory|本地|项目|代码|日志|报错|错误|设置|权限|工具|skill|skills?))/iu;
const LOCAL_LOOKUP_QUERY_PATTERN = /文件|文件夹|目录|线程|会话|任务|待办|todo|记忆|memory|之前|上次|刚才|今天我们|今天做了什么|今天聊了什么|本地|workspace|项目|代码|日志|报错|错误|终端|设置|权限|工具|skills?/iu;

export function needsMemoryFactRecall(query: string) {
  return matches(query, MEMORY_FACT_QUERY_PATTERN);
}

export function needsEpisodicHistoryRecall(query: string) {
  return matches(query, EPISODIC_HISTORY_QUERY_PATTERN);
}

export function needsThreadManagement(query: string) {
  return matches(query, THREAD_MANAGEMENT_QUERY_PATTERN);
}

export function needsTaskTracking(query: string) {
  return matches(query, TASK_TRACKING_QUERY_PATTERN);
}

export function needsTodoChecklist(query: string) {
  return matches(query, TODO_CHECKLIST_QUERY_PATTERN);
}

export function needsWebResearch(query: string) {
  if (matches(
    query,
    /^search$|^web[\s_-]?search$|^websearch$|搜索|搜搜看|research|调查|fact-?check|验证|核对|确认|准确|准不准|可靠吗|可靠性|事实依据|来源|source|天气|温度|粉丝|关注者|播放|点赞|价格|汇率|比分|政策|新闻|官网|网址|链接|url|https?:\/\/|网上.*(好玩|有意思|新鲜事)|互联网.*(好玩|有意思)|上网.*看看|搜搜看/iu,
  )) {
    return true;
  }

  return EXPLICIT_WEB_LOOKUP_QUERY_PATTERN.test(query) && !LOCAL_LOOKUP_QUERY_PATTERN.test(query);
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

export function inferStickySkillIdsFromContext(query: string) {
  const stickySkillIds = new Set<string>();

  if (needsMemoryFactRecall(query) || needsEpisodicHistoryRecall(query)) {
    stickySkillIds.add("memory-management");
  }
  if (needsThreadManagement(query)) {
    stickySkillIds.add("thread-management");
  }
  if (needsTaskTracking(query)) {
    stickySkillIds.add("tasks");
  }
  if (needsTodoChecklist(query)) {
    stickySkillIds.add("todo");
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
  if (matches(query, /(?:\bskills?\b|\bcapabilit(?:y|ies)\b|browser_click|browser_open|browser_type|browser relay|tool(s)?|能力|有哪些工具|哪些工具|缺少.*(?:工具|skills?|tools?|能力|capabilit(?:y|ies))|没有.*(?:工具|skills?|tools?|能力|capabilit(?:y|ies)))/iu)) {
    stickySkillIds.add("skill-hub");
    stickySkillIds.add("skill-search");
  }
  return [...stickySkillIds];
}
