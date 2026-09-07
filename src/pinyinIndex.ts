import type * as PinyinPro from "pinyin-pro";

import type { GlobalSearchHit } from "./api";

type PinyinModule = typeof PinyinPro;

/** 拼音索引能覆盖的候选来源:文件名、八维标签、章节标题。 */
export type PinyinEntryKind = "file" | "tag" | "chapter";

export interface PinyinIndexEntry {
  kind: PinyinEntryKind;
  /** 点击命中后要跳转到的素材;章节/标签命中用其代表素材(如该章节第一条素材)。 */
  clip_id: number;
  /** 命中所属的集;不在当前集则点击应打开只读历史视图,而不是套用当前集过滤器。 */
  episode_id: number | null;
  /** 展示用原文——文件名 / 标签文案 / 章节标题。 */
  text: string;
}

interface PinyinIndexItem extends PinyinIndexEntry {
  fullPinyin: string;
  initials: string;
  textLower: string;
}

/** 只对纯 ASCII 字母、长度 >= 2 的查询走拼音匹配——中文查询/数字/符号一律跳过。 */
const ASCII_QUERY_RE = /^[a-zA-Z]{2,}$/;

export function isPinyinQuery(query: string): boolean {
  return ASCII_QUERY_RE.test(query.trim());
}

/**
 * pinyin-pro 体积不小(是它把主分块从 265kB 撑到 555kB、触发 fast-gates 的 500kB
 * 门禁),而绝大多数查询是中文或太短、根本用不到它。所以真正的 import 推迟到第一次
 * 出现拼音查询时才发生,并把返回的 Promise 缓存住——重复查询不会重复 import。
 */
let pinyinModulePromise: Promise<PinyinModule> | null = null;
function loadPinyinModule(): Promise<PinyinModule> {
  if (!pinyinModulePromise) pinyinModulePromise = import("pinyin-pro");
  return pinyinModulePromise;
}

/** 原始候选条目的别名——拼音字段(fullPinyin/initials)延后到第一次拼音查询时才计算。 */
export type PinyinIndex = PinyinIndexEntry[];

export function buildPinyinIndex(entries: PinyinIndexEntry[]): PinyinIndex {
  return entries;
}

/** 按索引数组身份缓存已算出拼音字段的条目,避免同一批数据在多次查询里重复转换。 */
const builtIndexCache = new WeakMap<PinyinIndex, Promise<PinyinIndexItem[]>>();

function ensureBuiltIndex(index: PinyinIndex): Promise<PinyinIndexItem[]> {
  let cached = builtIndexCache.get(index);
  if (!cached) {
    cached = loadPinyinModule().then(({ pinyin }) =>
      index.map((entry) => {
        const fullPinyin = pinyin(entry.text, { toneType: "none", type: "array", v: true })
          .join("")
          .toLowerCase();
        const initials = pinyin(entry.text, { pattern: "first", type: "array", v: true })
          .join("")
          .toLowerCase();
        return { ...entry, fullPinyin, initials, textLower: entry.text.toLowerCase() };
      }),
    );
    builtIndexCache.set(index, cached);
  }
  return cached;
}

/** 拼音命中——形状对齐 GlobalSearchHit,kind 固定为 "pinyin",便于合并进统一结果列表与徽章表。 */
export async function matchPinyin(index: PinyinIndex, query: string): Promise<GlobalSearchHit[]> {
  const trimmed = query.trim();
  if (!isPinyinQuery(trimmed)) return [];
  const needle = trimmed.toLowerCase();
  const items = await ensureBuiltIndex(index);
  const hits: GlobalSearchHit[] = [];
  for (const item of items) {
    if (
      item.fullPinyin.includes(needle) ||
      item.initials.includes(needle) ||
      item.textLower.includes(needle)
    ) {
      hits.push({
        kind: "pinyin",
        clip_id: item.clip_id,
        file_name: item.text,
        excerpt: item.text,
        episode_id: item.episode_id,
      });
    }
  }
  return hits;
}

/**
 * 合并后端命中与拼音命中:同一素材(clip_id)后端命中优先——拼音路只是补一条
 * "输入法友好"的入口,已有权威命中(文件/转写/AI/标签/画面文字)时不重复展示。
 */
export function mergeSearchHits(
  backendHits: GlobalSearchHit[],
  pinyinHits: GlobalSearchHit[],
): GlobalSearchHit[] {
  const coveredClipIds = new Set(backendHits.map((hit) => hit.clip_id));
  const merged = [...backendHits];
  const seenPinyinClipIds = new Set<number>();
  for (const hit of pinyinHits) {
    if (coveredClipIds.has(hit.clip_id)) continue;
    if (seenPinyinClipIds.has(hit.clip_id)) continue;
    seenPinyinClipIds.add(hit.clip_id);
    merged.push(hit);
  }
  return merged;
}
