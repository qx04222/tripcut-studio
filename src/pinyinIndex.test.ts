import { afterEach, describe, expect, it, vi } from "vitest";
import type * as PinyinPro from "pinyin-pro";

import type { GlobalSearchHit } from "./api";

const entries = [
  { kind: "file" as const, clip_id: 1, episode_id: 10, text: "旅拍" },
  { kind: "tag" as const, clip_id: 2, episode_id: 10, text: "夜市小吃" },
];

describe("pinyinIndex", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("matches full pinyin without tones (lvpai) against 「旅拍」", async () => {
    const { buildPinyinIndex, matchPinyin } = await import("./pinyinIndex");
    const index = buildPinyinIndex(entries);
    const hits = await matchPinyin(index, "lvpai");
    expect(hits.map((h) => h.clip_id)).toContain(1);
    expect(hits[0].kind).toBe("pinyin");
  });

  it("matches initials (lp) against 「旅拍」", async () => {
    const { buildPinyinIndex, matchPinyin } = await import("./pinyinIndex");
    const index = buildPinyinIndex(entries);
    const hits = await matchPinyin(index, "lp");
    expect(hits.map((h) => h.clip_id)).toContain(1);
  });

  it("is case-insensitive: LP also matches 「旅拍」", async () => {
    const { buildPinyinIndex, matchPinyin } = await import("./pinyinIndex");
    const index = buildPinyinIndex(entries);
    const hits = await matchPinyin(index, "LP");
    expect(hits.map((h) => h.clip_id)).toContain(1);
  });

  it("does not treat a Chinese query as a pinyin query", async () => {
    const { buildPinyinIndex, isPinyinQuery, matchPinyin } = await import("./pinyinIndex");
    expect(isPinyinQuery("旅")).toBe(false);
    const index = buildPinyinIndex(entries);
    expect(await matchPinyin(index, "旅")).toEqual([]);
  });

  it("requires at least 2 ASCII letters", async () => {
    const { isPinyinQuery } = await import("./pinyinIndex");
    expect(isPinyinQuery("l")).toBe(false);
    expect(isPinyinQuery("l3")).toBe(false);
    expect(isPinyinQuery("lp")).toBe(true);
  });

  it("carries episode_id through so callers can detect historical hits", async () => {
    const { buildPinyinIndex, matchPinyin } = await import("./pinyinIndex");
    const index = buildPinyinIndex(entries);
    const hits = await matchPinyin(index, "lvpai");
    expect(hits[0].episode_id).toBe(10);
  });
});

describe("pinyinIndex lazy-loads pinyin-pro (P1 chunk gate)", () => {
  afterEach(() => {
    vi.doUnmock("pinyin-pro");
    vi.resetModules();
  });

  it("never imports pinyin-pro for a non-pinyin (Chinese/short) query", async () => {
    const pinyinSpy = vi.fn();
    vi.doMock("pinyin-pro", () => {
      pinyinSpy();
      return { pinyin: vi.fn() };
    });
    const { buildPinyinIndex, matchPinyin } = await import("./pinyinIndex");
    const index = buildPinyinIndex(entries);

    await matchPinyin(index, "旅");
    await matchPinyin(index, "l");

    expect(pinyinSpy).not.toHaveBeenCalled();
  });

  it("imports pinyin-pro exactly once even across repeated pinyin queries (module promise cached)", async () => {
    const pinyinSpy = vi.fn();
    vi.doMock("pinyin-pro", () => {
      pinyinSpy();
      return {
        pinyin: (text: string, options: { pattern?: string }) =>
          options.pattern === "first" ? [text[0] ?? ""] : [text],
      };
    });
    const { buildPinyinIndex, matchPinyin } = await import("./pinyinIndex");
    const index = buildPinyinIndex(entries);

    await matchPinyin(index, "lvpai");
    await matchPinyin(index, "lp");
    await matchPinyin(index, "lvpai");

    // dynamic import() itself only ever resolves once — repeated pinyin
    // queries reuse the cached module promise, so the mock factory only
    // fires once too.
    expect(pinyinSpy).toHaveBeenCalledTimes(1);
  });

  it("still matches correctly once the lazy import resolves", async () => {
    vi.doMock("pinyin-pro", async () => {
      const actual = await vi.importActual<typeof PinyinPro>("pinyin-pro");
      return actual;
    });
    const { buildPinyinIndex, matchPinyin } = await import("./pinyinIndex");
    const index = buildPinyinIndex(entries);
    const hits = await matchPinyin(index, "lvpai");
    expect(hits.map((h) => h.clip_id)).toContain(1);
  });
});

describe("mergeSearchHits", () => {
  it("lets a backend hit win over a pinyin duplicate for the same clip", async () => {
    const { mergeSearchHits } = await import("./pinyinIndex");
    const backendHits: GlobalSearchHit[] = [
      { kind: "file", clip_id: 1, file_name: "旅拍花絮.mov", excerpt: "", episode_id: 10 },
    ];
    const pinyinHits: GlobalSearchHit[] = [
      { kind: "pinyin", clip_id: 1, file_name: "旅拍", excerpt: "旅拍", episode_id: 10 },
      { kind: "pinyin", clip_id: 2, file_name: "夜市小吃", excerpt: "夜市小吃", episode_id: 10 },
    ];
    const merged = mergeSearchHits(backendHits, pinyinHits);
    expect(merged).toHaveLength(2);
    expect(merged.filter((hit) => hit.clip_id === 1)).toHaveLength(1);
    expect(merged.find((hit) => hit.clip_id === 1)?.kind).toBe("file");
    expect(merged.find((hit) => hit.clip_id === 2)?.kind).toBe("pinyin");
  });
});
