import { describe, expect, it } from "vitest";
import type { ClipListItem, Storyboard } from "../api";
import {
  derivePipeline,
  pipelineInputFrom,
  pipelineNextLabel,
  pipelineStepCount,
  type PipelineInput,
} from "./pipelineModel";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

/** R12 §0 的那张表,逐行变成断言。 */
describe("derivePipeline", () => {
  it.each<[string, Partial<PipelineInput>, number, boolean[]]>([
    ["空库:第 ① 步", {}, 1, [false, false, false, false]],
    ["有素材但还在分析:① 不打勾但不挡路,当前已是第 ② 步", { clipCount: 21, analysisPending: 3 }, 2, [false, false, false, false]],
    ["分析中但后面都做完了:① 没勾所以不算全完成,停在 ④", { clipCount: 21, analysisPending: 3, segmentCount: 4, chapters: [{ id: 1, shotCount: 3 }], exportCount: 1 }, 4, [false, true, true, true]],
    ["分析完、没精选段:第 ② 步", { clipCount: 21 }, 2, [true, false, false, false]],
    ["有段、章还有空的:第 ③ 步", { clipCount: 21, segmentCount: 4, chapters: [{ id: 1, shotCount: 3 }, { id: 2, shotCount: 0 }] }, 3, [true, true, false, false]],
    ["有段、但根本没有章:第 ③ 步(没章不算排好)", { clipCount: 21, segmentCount: 4 }, 3, [true, true, false, false]],
    ["每章都有镜、没导出过:第 ④ 步", { clipCount: 21, segmentCount: 4, chapters: [{ id: 1, shotCount: 3 }, { id: 2, shotCount: 1 }] }, 4, [true, true, true, false]],
    ["空章被「这章够了」跳过:也算排好", { clipCount: 21, segmentCount: 4, chapters: [{ id: 1, shotCount: 3 }, { id: 2, shotCount: 0 }], skippedChapterIds: new Set([2]) }, 4, [true, true, true, false]],
    ["导出过一次:四步全完成,停在 ④", { clipCount: 21, segmentCount: 4, chapters: [{ id: 1, shotCount: 3 }], exportCount: 1 }, 4, [true, true, true, true]],
    ["导出过但又清空了精选段:回到第 ② 步(状态由数据推导,不记忆)", { clipCount: 21, chapters: [{ id: 1, shotCount: 3 }], exportCount: 1 }, 2, [true, false, true, true]],
  ])("%s", (_name, patch, step, done) => {
    const state = derivePipeline({ ...base, ...patch });
    expect(state.step).toBe(step);
    expect([...state.done]).toEqual(done);
    expect(state.complete).toBe(done.every(Boolean));
    expect(state.step).toBeGreaterThanOrEqual(1);
  });

  it("counts:章数按「有镜或被跳过」计", () => {
    const state = derivePipeline({
      ...base,
      clipCount: 5,
      analysisPending: 2,
      segmentCount: 7,
      chapters: [{ id: 1, shotCount: 2 }, { id: 2, shotCount: 0 }, { id: 3, shotCount: 0 }],
      skippedChapterIds: new Set([3]),
      exportCount: 2,
    });
    expect(state.counts).toEqual({ clips: 5, analysisPending: 2, segments: 7, chaptersFilled: 2, chaptersTotal: 3, exports: 2, openChapters: 1 });
  });
});

describe("导航条计数与主按钮文案", () => {
  it("计数短语:导入 21 条 / 分析中 18/21 条 / 挑选 4 段 / 排列 1/2 章 / 导出 1 次;没数据就空串", () => {
    const empty = derivePipeline(base);
    expect([1, 2, 3, 4].map((step) => pipelineStepCount(empty, step as 1))).toEqual(["", "", "", ""]);
    const mid = derivePipeline({ ...base, clipCount: 21, segmentCount: 4, chapters: [{ id: 1, shotCount: 1 }, { id: 2, shotCount: 0 }], exportCount: 1 });
    expect([1, 2, 3, 4].map((step) => pipelineStepCount(mid, step as 1))).toEqual(["21 条", "4 段", "1/2 章", "1 次"]);
    expect(pipelineStepCount(derivePipeline({ ...base, clipCount: 21, analysisPending: 3 }), 1)).toBe("18/21 条");
  });

  it("主按钮文案随步变化;分析中也不挡路;四步全完成变「再导出一次」", () => {
    expect(pipelineNextLabel(derivePipeline(base))).toBe("下一步:导入素材");
    // R19 U-01:分析中的文案改说「先挑已分析的 x/N 条」(pipelineR19.test 钉住三种形态)。
    expect(pipelineNextLabel(derivePipeline({ ...base, clipCount: 3, analysisPending: 1 }))).toBe("先挑已分析的 2/3 条");
    expect(pipelineNextLabel(derivePipeline({ ...base, clipCount: 3 }))).toBe("下一步:自动挑选");
    expect(pipelineNextLabel(derivePipeline({ ...base, clipCount: 3, segmentCount: 1 }))).toBe("下一步:排到镜头带");
    expect(pipelineNextLabel(derivePipeline({ ...base, clipCount: 3, segmentCount: 1, chapters: [{ id: 1, shotCount: 1 }] }))).toBe("下一步:导出");
    expect(pipelineNextLabel(derivePipeline({ ...base, clipCount: 3, segmentCount: 1, chapters: [{ id: 1, shotCount: 1 }], exportCount: 1 }))).toBe("再导出一次");
  });
});

describe("pipelineInputFrom:从 feed 原始数据拼输入", () => {
  const clip = (id: number, patch: Partial<ClipListItem>): ClipListItem =>
    ({ id, kind: "video", analysis_status: "done", select_count: 0, ...patch }) as ClipListItem;
  const board = {
    chapters: [{ id: 10, title: "a" }, { id: 11, title: "b" }],
    items: [
      { key: "1", clip_id: 1, chapter_id: 10 },
      { key: "2", clip_id: 2, chapter_id: 10 },
      { key: "3", clip_id: 3, chapter_id: null },
    ],
    candidates: [],
  } as unknown as Storyboard;

  it("pending/running 计入分析中;select_count 求和;镜按 chapter_id 归章;导出次数取集记录", () => {
    const input = pipelineInputFrom(
      [clip(1, { analysis_status: "pending", select_count: 2 }), clip(2, { analysis_status: "running" }), clip(3, { analysis_status: "failed", select_count: 1 }), clip(4, {})],
      board,
      { export_count: 3 } as never,
    );
    expect(input).toEqual({
      clipCount: 4,
      analysisPending: 2,
      segmentCount: 3,
      chapters: [{ id: 10, shotCount: 2 }, { id: 11, shotCount: 0 }],
      skippedChapterIds: undefined,
      exportCount: 3,
      unplacedCount: 0,
    });
  });

  it("storyboard / 集为 null 时也不炸", () => {
    expect(pipelineInputFrom([], null, null)).toEqual({ clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], skippedChapterIds: undefined, exportCount: 0, unplacedCount: 0 });
  });

  it("视频工作台的素材、分析、精选、章镜与候选统计严格排除照片和缺失 kind", () => {
    const mixedBoard = {
      chapters: [{ id: 10 }, { id: 11 }],
      items: [
        { clip_id: 1, chapter_id: 10 },
        { clip_id: 2, chapter_id: 11 },
        { clip_id: 3, chapter_id: 11 },
      ],
      candidates: [{ clip_id: 1 }, { clip_id: 2 }, { clip_id: 3 }],
    } as unknown as Storyboard;
    const input = pipelineInputFrom(
      [
        clip(1, { analysis_status: "pending", select_count: 2 }),
        clip(2, { kind: "photo", analysis_status: "running", select_count: 5 }),
        clip(3, { kind: undefined, analysis_status: "pending", select_count: 7 }),
      ],
      mixedBoard,
      { export_count: 0 } as never,
    );
    expect(input).toEqual({
      clipCount: 1,
      analysisPending: 1,
      segmentCount: 2,
      chapters: [{ id: 10, shotCount: 1 }, { id: 11, shotCount: 0 }],
      skippedChapterIds: undefined,
      exportCount: 0,
      unplacedCount: 1,
    });
  });
});
