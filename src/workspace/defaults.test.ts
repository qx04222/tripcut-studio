import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  getCurrentEpisode: vi.fn(async () => ({ id: 1, title: "EP01", target_platform: "generic" })),
  listPlatformPresets: vi.fn(async () => [{ platform: "generic", duration_budget_ticks: 45_000, tb_num: 1, tb_den: 1000 }]),
  autoSelectEpisode: vi.fn(),
  setSetting: vi.fn(),
  getSettings: vi.fn(async () => ({})),
}));

import { AUTO_SELECT_DEFAULT_SCOPE, AUTO_SELECT_FALLBACK_BUDGET_SECS, AUTO_SELECT_SCOPES, platformBudgetSecs } from "./BandAutoSelect";
import { DEFAULT_EXPORT_MODE } from "./deliver/quickExportModel";
import { STEPS_SEEN_KEY } from "./onboarding";
import { UI_SETTING_DEFAULTS, readUiBool } from "./uiSettings";

/**
 * R11 简化专项 #6:业主原则「新功能默认开且默认值合理,不需要用户先去设置」。
 * 这张表就是默认值的契约 —— 改任何一项都要在这里改,并说明为什么新手需要先去设置页。
 */
describe("开包即用的默认值表", () => {
  it("播放器:选中从最精彩处开播、播完自动播下一条,默认开;不静音", () => {
    expect(UI_SETTING_DEFAULTS["ui.player.start_at_best"]).toBe("true");
    expect(UI_SETTING_DEFAULTS["ui.player.auto_advance"]).toBe("true");
    expect(UI_SETTING_DEFAULTS["ui.player.muted"]).toBe("false");
    // 没写过任何设置(空表)也是开的 —— 不用先去设置页。
    expect(readUiBool({}, "ui.player.start_at_best")).toBe(true);
    expect(readUiBool({}, "ui.player.auto_advance")).toBe(true);
  });

  it("交付抽屉:默认快速导出", () => {
    expect(DEFAULT_EXPORT_MODE).toBe("quick");
  });

  it("自动挑选:默认范围「收藏 + 3 星以上」,预算取平台默认(拉不到时 30 秒)", async () => {
    expect(AUTO_SELECT_DEFAULT_SCOPE).toBe("favorites_or_rated3");
    expect(AUTO_SELECT_SCOPES.find((item) => item.scope === AUTO_SELECT_DEFAULT_SCOPE)?.label).toBe("收藏 + 3 星以上");
    // V-02:标签写「收藏 + 3 星以上」,发给后端的就得是并集;`rated3` 在 Rust 里是纯 ≥3 星,
    // 只收藏不评星的新手按默认「开始挑选」会得到 0 段。
    expect(AUTO_SELECT_SCOPES.map((item) => item.scope)).toEqual(["favorites", "favorites_or_rated3", "all"]);
    expect(await platformBudgetSecs()).toBe(45);
    expect(AUTO_SELECT_FALLBACK_BUDGET_SECS).toBe(30);
  });

  it("首启:三步引导默认未看过(第一次打开就出现);新壳默认开", () => {
    expect(UI_SETTING_DEFAULTS[STEPS_SEEN_KEY]).toBe("false");
    expect(UI_SETTING_DEFAULTS["ui.workspace_v2"]).toBe("true");
  });
});
