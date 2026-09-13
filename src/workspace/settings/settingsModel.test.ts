import { describe, expect, it } from "vitest";

import {
  clampMinimaxBudgetInput as legacyClamp,
  generationLedgerStatusLabel as legacyGenerationLabel,
  llmLedgerPurposeLabel as legacyPurposeLabel,
  llmLedgerStatusLabel as legacyStatusLabel,
  SETTINGS_SECTIONS,
} from "../../SettingsPage";
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

describe("settingsModel:与旧 SettingsPage 的纯函数逐字对等", () => {
  it("clampMinimaxBudgetInput 与旧实现同值同上限", () => {
    for (const raw of ["10", "999999", "-5", "not-a-number", "", "500", "500.5"]) {
      expect(clampMinimaxBudgetInput(raw)).toEqual(legacyClamp(raw));
    }
    expect(MINIMAX_MONTHLY_BUDGET_MAX).toBe(500);
  });

  it("三张标签表与旧实现一字不差", () => {
    for (const status of ["running", "succeeded", "failed", "parse_failed"] as const) {
      expect(llmLedgerStatusLabel(status)).toBe(legacyStatusLabel(status));
    }
    for (const status of ["draft", "submitted", "queued", "succeeded", "failed", "cancelled", "imported", "zzz"]) {
      expect(generationLedgerStatusLabel(status)).toBe(legacyGenerationLabel(status));
    }
    for (const purpose of ["ai_description", "director_qa", "narrate_episode", "other"]) {
      expect(llmLedgerPurposeLabel(purpose)).toBe(legacyPurposeLabel(purpose));
    }
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

  it("九个分区 tab 与 SETTINGS_SECTIONS 同序同文案,图标都在套件里,只有「缓存与重建」是 danger 且靠底", () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual(SETTINGS_SECTIONS.map((section) => section.id));
    SETTINGS_TABS.forEach((tab, index) => {
      expect(tab.label).toBe(SETTINGS_SECTIONS[index]!.label);
      expect(tab.description).toBe(SETTINGS_SECTIONS[index]!.description);
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
