import { describe, expect, it } from "vitest";

import { SETTINGS_GROUPS, SETTINGS_QUICK_LINKS, groupForSection, isAdvancedSection } from "./settingsGroups";
import { SETTINGS_TABS } from "./settingsModel";

/** R11 简化专项 #2:三分区 + 高级,九个旧分区一个不少、一个不重。 */
describe("settingsGroups", () => {
  it("三个分区:常用 / 工具与模型 / 关于", () => {
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual(["常用", "工具与模型", "关于"]);
  });

  it("九个旧分区恰好各出现一次(常用或高级)", () => {
    const placed = SETTINGS_GROUPS.flatMap((group) => [...group.primary, ...group.advanced]);
    expect([...placed].sort()).toEqual(SETTINGS_TABS.map((tab) => tab.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("旧分区 → 新组的映射(报告里的搬迁表)", () => {
    expect(groupForSection("appearance")).toBe("general");
    expect(groupForSection("performance")).toBe("general");
    expect(groupForSection("timeline")).toBe("general");
    expect(groupForSection("tools")).toBe("tools");
    expect(groupForSection("generation")).toBe("tools");
    expect(groupForSection("analysis")).toBe("tools");
    expect(groupForSection("about")).toBe("about");
    expect(groupForSection("cache")).toBe("about");
    expect(groupForSection("privacy")).toBe("about");
    expect(["performance", "timeline", "analysis", "privacy"].every((id) => isAdvancedSection(id as never))).toBe(true);
    expect(["appearance", "tools", "generation", "about", "cache"].some((id) => isAdvancedSection(id as never))).toBe(false);
  });

  it("冻结的两个冒烟锚点以快捷入口常驻左轨", () => {
    expect(SETTINGS_QUICK_LINKS.map((link) => link.label)).toEqual(["云端补镜", "隐私与诊断"]);
  });
});
