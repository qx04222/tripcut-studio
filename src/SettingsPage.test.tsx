import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell } from "./App";
import {
  DEFAULT_SETTINGS,
  SETTINGS_SECTIONS,
  SettingsPage,
  appearanceAttributes,
} from "./SettingsPage";

describe("P5-F5 settings page redesign", () => {
  it("maps all four interface scale values to root data values", () => {
    expect(appearanceAttributes({ "appearance.ui_scale": "0.9" }).uiScale).toBe("90");
    expect(appearanceAttributes({ "appearance.ui_scale": "1.0" }).uiScale).toBe("100");
    expect(appearanceAttributes({ "appearance.ui_scale": "1.15" }).uiScale).toBe("115");
    expect(appearanceAttributes({ "appearance.ui_scale": "1.3" }).uiScale).toBe("130");
  });

  it("maps system theme to no override and preserves explicit themes", () => {
    expect(appearanceAttributes({ "appearance.theme": "system" }).theme).toBeNull();
    expect(appearanceAttributes({ "appearance.theme": "light" }).theme).toBe("light");
    expect(appearanceAttributes({ "appearance.theme": "dark" }).theme).toBe("dark");
  });

  it("renders every settings group and the destructive cache confirmation entry", () => {
    const markup = renderToStaticMarkup(<SettingsPage />);

    for (const heading of ["外观", "性能", "设备时钟校正", "工具链", "分析阈值", "订阅大模型增强", "缓存", "帮助", "关于"]) {
      expect(markup).toContain(heading);
    }
    expect(markup).toContain("清空缓存并重建");
    expect(markup).toContain("组件尚未提供");
    expect(markup).toContain("打开中文帮助");
    expect(markup).toContain("打开日志目录");
    expect(markup).toContain("开源许可清单");
  });

  it("renders the settings route as navigation step 04 with safe defaults", () => {
    const markup = renderToStaticMarkup(<AppShell route="/settings" />);

    expect(markup).toContain("04");
    expect(markup).toContain("SETTINGS");
    expect(markup).toContain("100%");
    expect(DEFAULT_SETTINGS["performance.worker_count"]).toBe("4");
    expect(DEFAULT_SETTINGS["analysis.scene_threshold"]).toBe("0.35");
    expect(DEFAULT_SETTINGS["best_take.weight.technical"]).toBe("0.28");
    expect(markup).toContain("AI Best Take 六轴权重");
    expect(DEFAULT_SETTINGS.llm_enabled).toBe("false");
    expect(DEFAULT_SETTINGS.llm_provider).toBe("none");
    expect(DEFAULT_SETTINGS.llm_monthly_budget).toBe("200");
  });

  it("defines the seven sidebar categories including canonical journey time", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      "appearance",
      "performance",
      "timeline",
      "tools",
      "analysis",
      "about",
      "cache",
    ]);
    expect(SETTINGS_SECTIONS.at(-2)?.label).toBe("帮助与关于");
    expect(SETTINGS_SECTIONS.at(-1)?.label).toBe("缓存与重建");
  });

  it("renders one sidebar route target for every settings category", () => {
    const markup = renderToStaticMarkup(<SettingsPage />);

    for (const section of SETTINGS_SECTIONS) {
      expect(markup).toContain(`data-settings-nav="${section.id}"`);
      expect(markup).toContain(`aria-controls="settings-panel-${section.id}"`);
      expect(markup).toContain(`id="settings-panel-${section.id}"`);
    }
  });

  it("uses the unified icon-copy-control row structure for editable settings", () => {
    const markup = renderToStaticMarkup(<SettingsPage />);

    expect(markup).toContain("settings-row-copy");
    expect(markup).toContain("settings-row-control");
    expect(markup).toContain("settings-icon");
    expect(markup).toContain("data-setting-row");
  });

  it("merges analysis with LLM and help with about into shared navigation categories", () => {
    const markup = renderToStaticMarkup(<SettingsPage />);

    expect(markup.match(/data-settings-section="analysis"/g)).toHaveLength(2);
    expect(markup.match(/data-settings-section="about"/g)).toHaveLength(2);
    expect(markup).toContain("分析与 AI");
    expect(markup).toContain("帮助与关于");
  });

  it("places the isolated destructive cache action after the about category", () => {
    const markup = renderToStaticMarkup(<SettingsPage />);
    const aboutIndex = markup.lastIndexOf('data-settings-section="about"');
    const cacheIndex = markup.indexOf('id="settings-panel-cache"');
    const dangerIndex = markup.indexOf("danger-zone");

    expect(cacheIndex).toBeGreaterThan(aboutIndex);
    expect(dangerIndex).toBeGreaterThan(cacheIndex);
    expect(markup).toContain("评级、片段和原始素材不会被删除");
  });
});
