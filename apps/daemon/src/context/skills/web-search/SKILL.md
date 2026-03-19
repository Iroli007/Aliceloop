---
name: web-search
label: web-search
description: Search the web for up-to-date information, research, fact-checking, and source discovery before fetching specific pages.
status: planned
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

This skill is planned for a future web-search adapter.

If `web_search` is not available yet:

- say that live search is not wired into the current runtime
- avoid claiming anything is current unless you can verify it another way
- recommend a later ACP / external engine integration when the task truly needs live web access
