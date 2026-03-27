---
name: web-search
label: web-search
description: Search the web for current information and source discovery. Use when you need fresh facts, multiple viewpoints, or a first pass over a topic.
status: available
mode: instructional
source-url: https://docs.anthropic.com/en/docs/claude-code/settings
allowed-tools:
  - web_search
---

# Web Search

Use the built-in `web_search` tool for discovery. It returns ranked sources, snippets, and source links.

Call `web_search` with a focused query and keep the result count small. For example, search for `python 3.13 new features` or `峰哥亡命天涯 最新情况`.

When a candidate URL matters, switch to the `web-fetch` skill and read the exact page.

## Good fits

- latest releases, prices, scores, or policy updates
- fact-checking a claim
- finding official docs or primary sources
- comparing several current sources before answering

## Browser Fallback

If a page needs login, CAPTCHA, or multi-step interaction, use the browser skill instead.

## Tips

- Search with a few focused queries instead of one vague query.
- Prefer official docs, vendor pages, standards bodies, or primary reporting.
- Compare dates when sources disagree.
- Cite the URLs you relied on at the end.
