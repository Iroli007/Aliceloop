#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MID = "568639458";
const DEFAULT_PS = 40;
const DEFAULT_OUTPUT_DIR = path.resolve("test_output/bilibili-fangyingshouji");

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    parsed[key] = rest.length > 0 ? rest.join("=") : "true";
  }
  return parsed;
}

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((index) => orig[index]).join("").slice(0, 32);
}

function encodeWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const chrFilter = /[!'()*]/g;
  const wts = Math.floor(Date.now() / 1000);
  const query = Object.entries({ ...params, wts })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const sanitized = String(value).replace(chrFilter, "");
      return `${encodeURIComponent(key)}=${encodeURIComponent(sanitized)}`;
    })
    .join("&");
  const wRid = crypto.createHash("md5").update(query + mixinKey).digest("hex");
  return `${query}&w_rid=${wRid}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fetchJson(url, init = {}, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(400 * attempt);
      }
    }
  }
  throw lastError;
}

function buildHeaders(cookie) {
  return {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    referer: "https://space.bilibili.com/",
    ...(cookie ? { cookie } : {}),
  };
}

async function getWbiKeys(headers) {
  const nav = await fetchJson("https://api.bilibili.com/x/web-interface/nav", {
    headers,
  });
  const imgUrl = nav?.data?.wbi_img?.img_url;
  const subUrl = nav?.data?.wbi_img?.sub_url;
  if (!imgUrl || !subUrl) {
    throw new Error("Failed to read WBI keys from nav response.");
  }
  return {
    imgKey: path.basename(imgUrl, path.extname(imgUrl)),
    subKey: path.basename(subUrl, path.extname(subUrl)),
  };
}

async function getVideoList({ mid, ps, headers, imgKey, subKey }) {
  const videos = [];
  let pn = 1;
  let total = 0;

  while (true) {
    const query = encodeWbi(
      {
        pn,
        ps,
        tid: 0,
        special_type: "",
        order: "pubdate",
        mid,
        index: 0,
        keyword: "",
        order_avoided: "true",
        platform: "web",
        web_location: 333.1387,
      },
      imgKey,
      subKey,
    );

    const url = `https://api.bilibili.com/x/space/wbi/arc/search?${query}`;
    const payload = await fetchJson(url, { headers });
    const list = payload?.data?.list?.vlist ?? [];
    total = payload?.data?.page?.count ?? total;
    videos.push(...list);

    process.stderr.write(`Fetched list page ${pn}, ${videos.length}/${total || "?"} videos\r`);

    if (list.length < ps) break;
    pn += 1;
    await sleep(250);
  }

  process.stderr.write("\n");
  return { total, videos };
}

function chooseChineseSubtitle(subtitles) {
  if (!Array.isArray(subtitles) || subtitles.length === 0) return null;
  return (
    subtitles.find((item) => item.lan === "ai-zh") ||
    subtitles.find((item) => item.lan?.startsWith("zh")) ||
    subtitles.find((item) => item.lan?.includes("zh")) ||
    subtitles[0]
  );
}

async function getVideoDetail(bvid, headers) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const payload = await fetchJson(url, { headers });
  if (payload?.code !== 0 || !payload?.data) {
    throw new Error(`Failed to fetch view data for ${bvid}: ${payload?.message ?? "unknown error"}`);
  }
  return payload.data;
}

async function getSubtitleTrack({ aid, cid, headers, imgKey, subKey }) {
  const query = encodeWbi({ aid, cid }, imgKey, subKey);
  const url = `https://api.bilibili.com/x/player/wbi/v2?${query}`;
  const payload = await fetchJson(url, { headers });
  if (payload?.code !== 0) {
    throw new Error(`Failed to fetch subtitle metadata: ${payload?.message ?? "unknown error"}`);
  }

  const subtitles = payload?.data?.subtitle?.subtitles ?? [];
  const normalizedTracks = subtitles.map((item) => ({
    id: item.id,
    lan: item.lan,
    lanDoc: item.lan_doc,
    isAiSubtitle: item.ai_type != null,
    subtitleUrl: item.subtitle_url?.startsWith("//")
      ? `https:${item.subtitle_url}`
      : item.subtitle_url,
  }));

  return {
    needLoginSubtitle: Boolean(payload?.data?.need_login_subtitle),
    track: chooseChineseSubtitle(normalizedTracks),
    allTracks: normalizedTracks,
  };
}

async function getSubtitleBody(subtitleUrl, headers) {
  if (!subtitleUrl) return null;
  const payload = await fetchJson(subtitleUrl, { headers });
  const segments = Array.isArray(payload?.body) ? payload.body : [];
  const lines = segments
    .map((item) => item.content?.trim())
    .filter(Boolean);
  return {
    lang: payload?.lang ?? null,
    segments,
    text: lines.join("\n"),
    lineCount: lines.length,
  };
}

function formatDate(timestampSeconds) {
  if (!timestampSeconds) return "";
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

function toMarkdown(videos, meta) {
  const lines = [
    "# 放映手机视频文本合集",
    "",
    `- 导出时间: ${new Date(meta.exportedAt).toISOString()}`,
    `- UID: ${meta.mid}`,
    `- 视频总数: ${meta.videoCount}`,
    `- 含字幕视频数: ${meta.withSubtitleCount}`,
    `- 缺字幕视频数: ${meta.withoutSubtitleCount}`,
    "",
  ];

  for (const video of videos) {
    lines.push(`## ${video.title}`);
    lines.push("");
    lines.push(`- BVID: ${video.bvid}`);
    lines.push(`- 日期: ${video.pubdate || "未知"}`);
    lines.push(`- 时长: ${video.durationSeconds ?? "未知"} 秒`);
    lines.push(`- 字幕状态: ${video.subtitleText ? "已抓取" : "无可用字幕"}`);
    lines.push(`- 链接: https://www.bilibili.com/video/${video.bvid}/`);
    if (video.desc) {
      lines.push(`- 简介: ${video.desc.replace(/\n+/g, " ").trim()}`);
    }
    lines.push("");
    if (video.subtitleText) {
      lines.push("```text");
      lines.push(video.subtitleText);
      lines.push("```");
    } else {
      lines.push("_无可用中文字幕，保留标题与简介。_");
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mid = args.mid || DEFAULT_MID;
  const ps = Number(args.ps || DEFAULT_PS);
  const limit = args.limit ? Number(args.limit) : null;
  const outputDir = path.resolve(args.out || DEFAULT_OUTPUT_DIR);
  const cookie = process.env.BILI_COOKIE?.trim();

  if (!cookie) {
    throw new Error("Missing BILI_COOKIE environment variable.");
  }

  await ensureDir(outputDir);
  const headers = buildHeaders(cookie);
  const { imgKey, subKey } = await getWbiKeys(headers);
  const { total, videos: fetchedListVideos } = await getVideoList({ mid, ps, headers, imgKey, subKey });
  const listVideos =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? fetchedListVideos.slice(0, limit)
      : fetchedListVideos;

  const results = [];

  for (let index = 0; index < listVideos.length; index += 1) {
    const listVideo = listVideos[index];
    const bvid = listVideo.bvid;
    process.stderr.write(`[${index + 1}/${listVideos.length}] ${bvid} ${listVideo.title}\n`);

    let detail = null;
    let subtitleMeta = null;
    let subtitleBody = null;
    let error = null;

    try {
      detail = await getVideoDetail(bvid, headers);
      const firstPage = Array.isArray(detail.pages) ? detail.pages[0] : null;
      const cid = firstPage?.cid;

      if (detail?.aid && cid) {
        subtitleMeta = await getSubtitleTrack({
          aid: detail.aid,
          cid,
          headers,
          imgKey,
          subKey,
        });
        const chosenTrack = chooseChineseSubtitle(subtitleMeta.allTracks);
        if (chosenTrack?.subtitleUrl) {
          subtitleBody = await getSubtitleBody(chosenTrack.subtitleUrl, headers);
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    results.push({
      bvid,
      aid: detail?.aid ?? null,
      cid: detail?.pages?.[0]?.cid ?? null,
      title: detail?.title ?? listVideo.title ?? "",
      pubdate: formatDate(detail?.pubdate ?? listVideo.created),
      durationSeconds: detail?.duration ?? null,
      desc: detail?.desc ?? "",
      play: listVideo.play ?? null,
      comment: listVideo.comment ?? null,
      track: subtitleMeta?.track
        ? {
            lan: subtitleMeta.track.lan,
            lanDoc: subtitleMeta.track.lanDoc,
            subtitleUrl: subtitleMeta.track.subtitleUrl,
          }
        : null,
      allTracks: subtitleMeta?.allTracks ?? [],
      needLoginSubtitle: subtitleMeta?.needLoginSubtitle ?? null,
      subtitleLineCount: subtitleBody?.lineCount ?? 0,
      subtitleText: subtitleBody?.text ?? null,
      subtitleSegments: subtitleBody?.segments ?? [],
      error,
    });

    await sleep(250);
  }

  const withSubtitleCount = results.filter((video) => video.subtitleText).length;
  const withoutSubtitleCount = results.length - withSubtitleCount;

  const meta = {
    exportedAt: new Date().toISOString(),
    mid,
    requestedTotal: total,
    videoCount: results.length,
    withSubtitleCount,
    withoutSubtitleCount,
  };

  const jsonPath = path.join(outputDir, "corpus.json");
  const markdownPath = path.join(outputDir, "corpus.md");
  const metaPath = path.join(outputDir, "meta.json");

  await fs.writeFile(jsonPath, JSON.stringify({ meta, videos: results }, null, 2));
  await fs.writeFile(markdownPath, toMarkdown(results, meta));
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

  process.stdout.write(
    JSON.stringify(
      {
        outputDir,
        jsonPath,
        markdownPath,
        metaPath,
        ...meta,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
