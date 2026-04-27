import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict";

const jieba = Jieba.withDict(dict);
const stopTokens = new Set(["的", "了", "和", "是", "我", "你", "他", "她", "它", "在", "有", "就", "都", "而", "及", "与", "或", "啊", "吗", "呢", "吧"]);

function normalizeToken(token: string) {
  return token.trim().toLowerCase();
}

function isSearchToken(token: string) {
  return /[\p{L}\p{N}]/u.test(token) && !stopTokens.has(token);
}

export function tokenizeForSqlSearch(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  const tokens = jieba
    .cutForSearch(value, true)
    .map(normalizeToken)
    .filter((token) => token.length > 0 && isSearchToken(token));

  return [...new Set(tokens)].join(" ");
}

export function buildFtsQuery(value: unknown) {
  const tokens = tokenizeForSqlSearch(value).split(/\s+/u).filter(Boolean);

  return tokens
    .map((token) => `"${token.replace(/"/g, "\"\"")}"`)
    .join(" AND ");
}
