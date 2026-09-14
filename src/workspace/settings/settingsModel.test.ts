import { describe, expect, it } from "vitest";

import { ICON_NAMES } from "../ui/icons";
import {
  bytesLabel,
  clampMinimaxBudgetInput,
  clockSourceLabel,
  generationLedgerStatusLabel,
  llmLedgerPurposeLabel,
  llmLedgerStatusLabel,
  MINIMAX_MONTHLY_BUDGET_MAX,
  noticeTone,
  SETTINGS_TABS,
  deviceClockEmptyCopy,
  deviceClockLibraryState,
} from "./settingsModel";

// R17:旧壳 `src/SettingsPage.tsx` 已删除。这里原来对着它的导出做"逐字对等"
// 双跑,现在改成钉死这些纯函数自己的期望值——断言内容不变(迁移,不是删除)。
describe("settingsModel 纯函数", () => {
  it("clampMinimaxBudgetInput 按上下限夹紧,非法输入夹到 0", () => {
    expect(clampMinimaxBudgetInput("10")).toEqual({ value: 10, clamped: false });
    expect(clampMinimaxBudgetInput("999999")).toEqual({ value: 500, clamped: true });
    expect(clampMinimaxBudgetInput("-5")).toEqual({ value: 0, clamped: true });
    expect(clampMinimaxBudgetInput("not-a-number")).toEqual({ value: 0, clamped: true });
    expect(clampMinimaxBudgetInput("")).toEqual({ value: 0, clamped: true });
    expect(clampMinimaxBudgetInput("500")).toEqual({ value: 500, clamped: false });
    expect(clampMinimaxBudgetInput("500.5")).toEqual({ value: 500, clamped: true });
    expect(MINIMAX_MONTHLY_BUDGET_MAX).toBe(500);
  });

  it("三张标签表文案固定", () => {
    expect(llmLedgerStatusLabel("running")).toBe("调用中");
    expect(llmLedgerStatusLabel("succeeded")).toBe("已成功");
    expect(llmLedgerStatusLabel("failed")).toBe("调用失败");
    expect(llmLedgerStatusLabel("parse_failed")).toBe("解析失败");

    expect(generationLedgerStatusLabel("draft")).toBe("草稿");
    expect(generationLedgerStatusLabel("submitted")).toBe("已提交");
    expect(generationLedgerStatusLabel("queued")).toBe("排队中");
    expect(generationLedgerStatusLabel("succeeded")).toBe("生成成功");
    expect(generationLedgerStatusLabel("failed")).toBe("失败");
    expect(generationLedgerStatusLabel("cancelled")).toBe("已取消");
    expect(generationLedgerStatusLabel("imported")).toBe("已入库");
    expect(generationLedgerStatusLabel("zzz")).toBe("zzz");

    expect(llmLedgerPurposeLabel("ai_description")).toBe("AI 描述");
    expect(llmLedgerPurposeLabel("director_qa")).toBe("导演问答");
    expect(llmLedgerPurposeLabel("narrate_episode")).toBe("叙事编排");
    expect(llmLedgerPurposeLabel("other")).toBe("other");
  });

  it("clockSourceLabel / bytesLabel", () => {
    expect(clockSourceLabel("manual")).toBe("人工校正");
    expect(clockSourceLabel("auto")).toBe("高置信自动对齐");
    expect(clockSourceLabel("reference")).toBe("参考设备");
    expect(bytesLabel(512)).toBe("512 B");
    expect(bytesLabel(2_048)).toBe("2.00 KB");
    expect(bytesLabel(15.5 * 1_048_576)).toBe("15.5 MB");
    expect(bytesLabel(200 * 1_048_576)).toBe("200 MB");
  });

  it("九个分区 tab 顺序与文案固定,图标都在套件里,只有「缓存与重建」是 danger 且靠底", () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      "appearance", "performance", "timeline", "tools", "analysis", "generation", "privacy", "about", "cache",
    ]);
    SETTINGS_TABS.forEach((tab) => {
      expect(ICON_NAMES).toContain(tab.icon);
      expect("eyebrow" in tab).toBe(false);
    });
    expect(SETTINGS_TABS.filter((tab) => tab.danger).map((tab) => tab.id)).toEqual(["cache"]);
    expect(SETTINGS_TABS.at(-1)!.id).toBe("cache");
  });

  it("noticeTone 按文案分三档", () => {
    expect(noticeTone("正在读取本地设置…")).toBe("info");
    expect(noticeTone("设置已从本地项目载入")).toBe("info");
    expect(noticeTone("已保存")).toBe("ok");
    expect(noticeTone("已保存，worker 并发将在重启后生效")).toBe("ok");
    expect(noticeTone("保存失败：磁盘只读")).toBe("warn");
    expect(noticeTone("核心设置尚未载入，暂不能编辑")).toBe("warn");
    expect(noticeTone("请再次点击确认；评级、片段和原始素材不会被删除")).toBe("warn");
  });
});

describe("R10 U-35:旅行时间空态分三种", () => {
  it("没素材 → empty;还在索引 → indexing;全索引完 → indexed", () => {
    expect(deviceClockLibraryState({ total: 0, done: 0, failed: 0, running: 0 })).toBe("empty");
    expect(deviceClockLibraryState({ total: 21, done: 10, failed: 0, running: 2 })).toBe("indexing");
    expect(deviceClockLibraryState({ total: 21, done: 20, failed: 0, running: 0 })).toBe("indexing");
    expect(deviceClockLibraryState({ total: 21, done: 20, failed: 1, running: 0 })).toBe("indexed");
  });
  it("跑完了仍为空要说清「本批素材没有设备信息」,不再让人等 device_model", () => {
    expect(deviceClockEmptyCopy("indexed").title).toBe("本批素材没有设备信息");
    expect(deviceClockEmptyCopy("indexed").body).not.toContain("device_model");
    expect(deviceClockEmptyCopy("indexing").title).toBe("正在索引素材");
    expect(deviceClockEmptyCopy("empty").title).toBe("还没有导入素材");
  });
});
