import { describe, expect, it } from "vitest";

import { SETTINGS_GROUPS, SETTINGS_QUICK_LINKS, groupForSection } from "./settingsGroups";
import { SETTINGS_TABS } from "./settingsModel";

/** R13 §2:剪映式六分区,没有「高级…」;九个旧分区 + 新的「快捷键」一个不少、一个不重。 */
describe("settingsGroups", () => {
  it("六个分区按剪映顺序:项目与缓存 / 快捷键 / 播放与导出 / 性能 / 工具与模型 / 关于", () => {
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual(["项目与缓存", "快捷键", "播放与导出", "性能", "工具与模型", "关于"]);
  });

  it("每个分区都有一句「这里管什么」,且没有任何折叠层", () => {
    for (const group of SETTINGS_GROUPS) {
      expect(group.intro.length).toBeGreaterThan(8);
      expect(group.sections.length).toBeGreaterThan(0);
      expect("advanced" in group).toBe(false);
    }
  });

  it("九个旧分区 + 「快捷键」恰好各出现一次", () => {
    const placed = SETTINGS_GROUPS.flatMap((group) => [...group.sections]);
    expect([...placed].sort()).toEqual([...SETTINGS_TABS.map((tab) => tab.id), "keymap"].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("旧分区 → 六块的映射(报告里的搬迁表)", () => {
    expect(groupForSection("cache")).toBe("project");
    expect(groupForSection("timeline")).toBe("project");
    expect(groupForSection("keymap")).toBe("keymap");
    expect(groupForSection("appearance")).toBe("playback");
    expect(groupForSection("performance")).toBe("performance");
    expect(groupForSection("tools")).toBe("tools");
    expect(groupForSection("generation")).toBe("tools");
    expect(groupForSection("analysis")).toBe("tools");
    expect(groupForSection("about")).toBe("about");
    expect(groupForSection("privacy")).toBe("about");
  });

  it("冻结的两个冒烟锚点以快捷入口常驻左轨", () => {
    expect(SETTINGS_QUICK_LINKS.map((link) => link.label)).toEqual(["云端补镜", "隐私与诊断"]);
  });
});
