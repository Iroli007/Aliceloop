---
name: web-search
label: web-search
description: Search the web for up-to-date information, research, fact-checking, and source discovery before fetching specific pages.
status: available
mode: instructional
source-url: https://docs.anthropic.com/en/docs/claude-code/settings
allowed-tools:
  - web_search
  - web_fetch
---

# Web Search

Use this skill when the task depends on fresh or externally sourced information.

Examples:

- latest releases, prices, scores, or policy updates
- fact-checking a claim
- finding official docs or primary sources
- comparing several current sources before answering

## Intended workflow

1. Search with precise, scoped queries.
2. Prefer official docs, vendor pages, standards bodies, or primary reporting.
3. Fetch the strongest candidate sources before answering.
4. Compare dates and resolve conflicts explicitly.
5. Cite the sources you relied on.

## Query habits

- Include product names, versions, or exact error messages.
- Add the current year when freshness matters.
- Use multiple narrow searches instead of one vague search.
- Follow up with targeted fetches instead of answering from snippets alone.

## Aliceloop status

`web_search` is active and returns compact result lists that can be followed up with `web_fetch`.

Current limitations:

- search quality depends on the configured endpoint and may be lighter than a full search API
- results are intended for source discovery, not as a final answer by themselves
- always fetch the strongest result before claiming specifics
