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
    ).toBe("4 项 · 3 段精选片段 · 1 条整条收藏 · 预计 3:05");
  });
});
