---
name: web-search
label: web-search
description: Search the web for up-to-date information, research, fact-checking, and source discovery before deciding whether specific pages need to be fetched.
status: available
mode: instructional
source-url: https://docs.anthropic.com/en/docs/claude-code/settings
allowed-tools:
  - web_search
---

# Web Search

Use this skill when the task depends on fresh or externally sourced information.
This routed skill sits above the underlying search tool: it can repeat search passes with refined queries, inspect the returned sources, and only then decide whether a separate page-reading step is needed.

Examples:

- latest releases, prices, scores, or policy updates
- fact-checking a claim
- finding official docs or primary sources
- comparing several current sources before answering

## Intended workflow

1. Search with precise, scoped queries.
2. Let `web_search` split one broad query into up to three focused search lanes, then inspect the returned top results and source links.
3. Prefer official docs, vendor pages, standards bodies, or primary reporting.
4. For simple discovery or source-finding turns, stop after `web_search`, synthesize from the snippets, and cite the source links at the end.
5. Only fetch the strongest candidate sources when you need exact page evidence, timestamps, or to resolve conflicting claims.
6. Do not fan out `web_fetch` across every result; fetch only the one or two pages that materially change the answer.
7. Compare dates and resolve conflicts explicitly.
8. Cite the sources you relied on at the end of the answer.

## Evidence ledger

- Keep a running ledger of what the search already discovered.
- Separate confirmed evidence from mere candidates, and carry the remaining gaps into the next turn.
- When a follow-up asks you to continue the investigation, reuse the existing candidate URLs instead of starting a fresh search from zero.
- If the ledger already contains a strong unfetched page, fetch that page before expanding the search again.

## Simple search mode

- Use this mode when the user mainly wants discovery, an overview, or a first-pass source list.
- Keep it to one to three search lanes.
- Do not call `web_fetch` unless the exact page contents matter.
- Treat the search results as the discovery layer, not as pages to be fetched one by one.
- End the answer with the source links that informed the conclusion.

## Query habits

- Include product names, versions, or exact error messages.
- Add the current year when freshness matters.
- Use multiple narrow searches instead of one vague search.
- Follow up with targeted fetches instead of answering from snippets alone.
- When the latest user message is only a short continuation of an ongoing fact-checking thread, recover the omitted subject from the recent turns and continue searching instead of replying with a promise to search later.
- When the system prompt already resolves the short follow-up into a concrete current request, use that resolved work item as your query seed and search immediately.
- For live metrics, rankings, follower counts, or date-specific platform activity, start with `web_search` and only route `web_fetch` if the snippets and source links are not enough to answer safely.
- For live metrics, rankings, follower counts, or date-specific platform activity, prefer primary platform pages and dated reporting. Do not lead with encyclopedia or stale overview pages when fresher sources are available.
- Treat Bilibili, Douyin, and X/Twitter as first-class primary sources for their own live profile/activity data.
- Treat 百度百科 as extremely low priority for live facts. Only cite it when better primary, official, dated, or reputable analytics sources fail, and label it explicitly as 百度百科 background instead of a live metric source.
- If the target account or preferred source site is ambiguous, ask the user for the exact profile URL or trusted domain list before guessing. A good phrasing is: `可以提供相对应的网址，这样我能更准确地解答问题。`

## Aliceloop status

`web_search` is active and returns up to 10 ranked results plus source links for the agent to synthesize.

Runtime behavior:

- Desktop relay available: open a temporary visible Chrome tab, load each search lane, extract ranked results, then close the tab
- No relay available: use the configured HTTP search endpoint directly

Current limitations:

- search quality depends on the configured endpoint and may be lighter than a full search API
- results are intended for source discovery, not as a final answer by themselves
- use `web_fetch` only when you need exact page evidence, not for the initial simple search pass
