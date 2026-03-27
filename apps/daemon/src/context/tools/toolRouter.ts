import type { SkillRouteHints } from "../skills/skillRouting";
import {
  needsAudioAnalysis,
  needsBrowserAutomation,
  needsDocumentIngest,
  needsImageAnalysis,
  needsReviewCoach,
  needsWebFetch,
  needsWebResearch,
} from "../skills/skillRouting";

function hasStickySkill(hints: SkillRouteHints | undefined, skillId: string) {
  return hints?.stickySkillIds.includes(skillId) ?? false;
}

function hasStickyGroup(hints: SkillRouteHints | undefined, groupId: SkillRouteHints["stickyGroupIds"][number]) {
  return hints?.stickyGroupIds.includes(groupId) ?? false;
}

const DEEP_RESEARCH_FOLLOWUP_PATTERN =
  /深度研究|深入研究|深挖|深扒|别偷懒|别只看摘要|别看摘要|去读|读一下|看原文|看正文|看全文|看来源|看帖子|看词条|看页面|补完|补全|继续深挖|继续深查|继续研究|现在什么情况|现在咋样|现在怎么样|最新情况|有进展吗|进展如何|怎么样了|情况怎么样|还有进展吗/u;

function needsDeepResearchFollowup(query: string) {
  return DEEP_RESEARCH_FOLLOWUP_PATTERN.test(query);
}

export function routeToolNamesForTurn(
  query: string | null | undefined,
  hints?: SkillRouteHints,
  options?: { hasImageAttachment?: boolean },
) {
  const normalizedQuery = query?.trim() ?? "";
  const toolNames = new Set<string>();

  if (
    needsWebResearch(normalizedQuery)
    || hasStickyGroup(hints, "research-core")
    || hasStickySkill(hints, "web-search")
  ) {
    toolNames.add("web_search");
  }

  if (
    needsWebFetch(normalizedQuery)
    || hasStickySkill(hints, "web-fetch")
    || (
      needsDeepResearchFollowup(normalizedQuery)
      && (hasStickyGroup(hints, "research-core") || hasStickySkill(hints, "web-search"))
    )
  ) {
    toolNames.add("web_fetch");
  }

  if (
    needsBrowserAutomation(normalizedQuery)
    || hasStickyGroup(hints, "browser-interaction")
    || hasStickySkill(hints, "browser")
  ) {
    toolNames.add("browser_snapshot");
    toolNames.add("browser_navigate");
    toolNames.add("browser_click");
    toolNames.add("browser_type");
    toolNames.add("browser_screenshot");
    toolNames.add("browser_media_probe");
    toolNames.add("browser_video_watch_start");
    toolNames.add("browser_video_watch_poll");
    toolNames.add("browser_video_watch_stop");
  }

  if (needsDocumentIngest(normalizedQuery)) {
    toolNames.add("document_ingest");
  }

  if (needsReviewCoach(normalizedQuery)) {
    toolNames.add("review_coach");
  }

  if (
    options?.hasImageAttachment
    || needsImageAnalysis(normalizedQuery)
  ) {
    toolNames.add("view_image");
  }

  if (
    needsAudioAnalysis(normalizedQuery)
    || hasStickySkill(hints, "audio-analysis")
  ) {
    toolNames.add("audio_understand");
  }

  return [...toolNames].sort();
}
