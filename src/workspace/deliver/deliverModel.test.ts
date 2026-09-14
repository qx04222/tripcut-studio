import { describe, expect, it } from "vitest";
import {
  EMPTY_STATUS,
  closestTargetWithinBudget,
  formatDuration,
  itemStatusLabel,
  presetBudgetSeconds,
  roughCutTargetFromKey,
  roughCutTargetKey,
  summaryLine,
  canvasLabel,
  readCanvas,
  rememberedDeliverChoices,
  wholeFavoritesNote,
} from "./deliverModel";

describe("deliverModel", () => {
  it("presetBudgetSeconds:ticks 按 tb 换算成整数秒;无预设 / 非正预算 = 0", () => {
    expect(presetBudgetSeconds(undefined)).toBe(0);
    expect(
      presetBudgetSeconds({
        platform: "xiaohongshu",
        display_name: "小红书",
        portrait: [1080, 1440],
        landscape: [1920, 1080],
        duration_budget_ticks: 90_000_000,
        tb_num: 1,
        tb_den: 1_000_000,
        subtitle_style: {},
      }),
    ).toBe(90);
    expect(
      presetBudgetSeconds({
        platform: "general",
        display_name: "通用",
        portrait: [1080, 1920],
        landscape: [1920, 1080],
        duration_budget_ticks: 0,
        tb_num: 1,
        tb_den: 1_000_000,
        subtitle_style: {},
      }),
    ).toBe(0);
  });

  it("closestTargetWithinBudget:取不超预算的最大档;无预算或没有档位可选 = 完整(null)", () => {
    expect(closestTargetWithinBudget(0)).toBeNull();
    expect(closestTargetWithinBudget(10)).toBeNull();
    expect(closestTargetWithinBudget(90)).toBe(60);
    expect(closestTargetWithinBudget(600)).toBe(180);
  });

  it("roughCutTargetKey 与 roughCutTargetFromKey 互逆", () => {
    expect(roughCutTargetKey(null)).toBe("full");
    expect(roughCutTargetKey(30)).toBe("30");
    expect(roughCutTargetFromKey("full")).toBeNull();
    expect(roughCutTargetFromKey("180")).toBe(180);
  });

  it("formatDuration:分:秒,超一小时带小时", () => {
    expect(formatDuration(185)).toBe("3:05");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(-3)).toBe("0:00");
  });

  it("itemStatusLabel 四态", () => {
    expect(itemStatusLabel("running")).toBe("处理中");
    expect(itemStatusLabel("done")).toBe("已完成");
    expect(itemStatusLabel("failed")).toBe("失败");
    expect(itemStatusLabel("queued")).toBe("等待中");
  });

  it("summaryLine 是一行汇总", () => {
    expect(
      summaryLine({
        ...EMPTY_STATUS,
        selected_count: 4,
        selected_segment_count: 3,
        selected_whole_count: 1,
        total_duration_seconds: 185,
      }),
    ).toBe("4 项 · 3 段精选片段 · 1 条收藏的整条视频 · 预计 3:05");
  });
});

describe("R10 U-20:记住上次选择与画布尺寸", () => {
  it("rememberedDeliverChoices:没记过 → platform null / targetSeconds undefined / 联系表 true / 剪映 false", () => {
    expect(rememberedDeliverChoices({})).toEqual({ platform: null, targetSeconds: undefined, includeContactSheet: true, useJianyingDraft: false });
  });
  it("记过的值按类型读回;「full」= 完整(null);坏值当没记", () => {
    expect(rememberedDeliverChoices({ "ui.deliver.platform": "douyin", "ui.deliver.target_seconds": "full", "ui.deliver.contact_sheet": "false", "ui.deliver.jianying_draft": "true" }))
      .toEqual({ platform: "douyin", targetSeconds: null, includeContactSheet: false, useJianyingDraft: true });
    expect(rememberedDeliverChoices({ "ui.deliver.target_seconds": "180" }).targetSeconds).toBe(180);
    expect(rememberedDeliverChoices({ "ui.deliver.platform": "myspace", "ui.deliver.target_seconds": "99" })).toMatchObject({ platform: null, targetSeconds: undefined });
  });
  it("readCanvas 按顺序取第一个带合法 canvas 的来源;canvasLabel 拼「画布 W×H」", () => {
    expect(readCanvas(undefined, null, { canvas: { width: 0, height: 10 } }, { canvas: { width: 1080, height: 1920 } })).toEqual({ width: 1080, height: 1920 });
    expect(readCanvas({}, { canvas: "no" })).toBeNull();
    expect(canvasLabel({ width: 1920, height: 1080 })).toBe("横版 1920×1080");
    expect(canvasLabel(null)).toBeNull();
  });
});

describe("R10 U-33:收藏的整条视频 0 条时说明收藏去了哪", () => {
  it("有精选段、整条 0 条 → 摘要补「有精选段的收藏已按片段导出」;整条 > 0 或没精选段不补", () => {
    const base = { ...EMPTY_STATUS, selected_count: 1, selected_segment_count: 2, selected_whole_count: 0, total_duration_seconds: 5 };
    expect(wholeFavoritesNote(base)).toBe("有精选段的收藏已按片段导出");
    expect(summaryLine(base)).toBe("1 项 · 2 段精选片段 · 0 条收藏的整条视频（有精选段的收藏已按片段导出） · 预计 0:05");
    expect(wholeFavoritesNote({ ...base, selected_whole_count: 1 })).toBeNull();
    expect(wholeFavoritesNote({ ...base, selected_segment_count: 0 })).toBeNull();
  });
});
