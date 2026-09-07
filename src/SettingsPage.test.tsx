import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell } from "./App";
import { helpTopicForSection } from "./helpContent";
import { downloadProgressLabel, updateFoundMessage, updaterErrorMessage } from "./updaterClient";
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

    for (const heading of ["外观", "性能", "设备时钟校正", "工具链", "分析阈值", "订阅大模型增强", "隐私与诊断", "缓存", "帮助", "关于"]) {
      expect(markup).toContain(heading);
    }
    expect(markup).toContain("清空缓存并重建");
    expect(markup).toContain("组件尚未提供");
    expect(markup).toContain("打开中文帮助");
    expect(markup).toContain("打开日志目录");
    expect(markup).toContain("由系统设置控制");
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

  it("defines the eight sidebar categories including canonical journey time and privacy", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      "appearance",
      "performance",
      "timeline",
      "tools",
      "analysis",
      "privacy",
      "about",
      "cache",
    ]);
    expect(SETTINGS_SECTIONS.at(-3)?.label).toBe("隐私与诊断");
    expect(SETTINGS_SECTIONS.at(-2)?.label).toBe("帮助与关于");
    expect(SETTINGS_SECTIONS.at(-1)?.label).toBe("缓存与重建");
  });

  it("gives every settings section id a matching help topic", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(helpTopicForSection(section.id)).not.toBeNull();
    }
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

describe("R6-T1 in-app updater", () => {
  it("renders the check-for-update control and an always-present status line", () => {
    const markup = renderToStaticMarkup(<SettingsPage />);

    expect(markup).toContain("检查更新");
    expect(markup).toContain('data-updater-action="check"');
    // 状态行必须无条件渲染:负例的判据就是这一行的文字。如果它只在有更新时才挂载,
    // 签名校验失败时它会连同「下载并安装」一起被卸载,界面上什么都不剩(F-R5 类事故)。
    expect(markup).toContain('data-updater-status="idle"');
    expect(markup).toContain("尚未检查更新。");
    expect(markup).toContain("minisign");
  });

  it("does not offer install or restart before a check has found anything", () => {
    const markup = renderToStaticMarkup(<SettingsPage />);

    expect(markup).not.toContain('data-updater-action="install"');
    expect(markup).not.toContain('data-updater-action="restart"');
  });

  it("translates a minisign verification failure into the refusal wording the e2e asserts", () => {
    const message = updaterErrorMessage(new Error("The signature verification failed"));

    expect(message).toContain("签名");
    expect(message).toContain("校验失败");
    expect(message).toContain("The signature verification failed");
  });

  it("still catches signature errors that are phrased as a decode failure", () => {
    // tauri-plugin-updater 的 Error::SignatureUtf8 文案本身就带 "signature"
    // ("The signature {0} could not be decoded, ..."),所以这一类真正的签名错误
    // 依旧要被分类为签名失败。
    const message = updaterErrorMessage(new Error("The signature abc could not be decoded"));
    expect(message).toContain("校验失败");
  });

  it(
    "M2 review fix: a bare decode/base64 error with no 'signature' word is NOT " +
      "misclassified as a signature failure",
    () => {
      // 这是本轮 review 发现的假阳性:旧正则还挂了 /decod|base64|verif/,任何传输层错误
      // 只要恰好带上这几个词(哪怕跟签名无关)就会被误判成签名失败,负例断言就会在错误的
      // 原因上通过。收紧到只认 "signature" 之后,这些错误必须落回通用文案。
      for (const detail of [
        "Invalid encoding in minisign data",
        "Invalid symbol 46, offset 11",
        "error decoding response body",
      ]) {
        const message = updaterErrorMessage(new Error(detail));
        expect(message).toBe(`更新失败：${detail}`);
        expect(message).not.toContain("签名");
        expect(message).not.toContain("校验失败");
      }
    },
  );

  it("keeps non-signature failures out of the signature wording", () => {
    const message = updaterErrorMessage(new Error("error sending request for url"));

    expect(message).toBe("更新失败：error sending request for url");
    expect(message).not.toContain("签名");
  });

  it("reports download progress as a percentage only when the total is known", () => {
    expect(downloadProgressLabel(524288, 1048576)).toContain("50%");
    expect(downloadProgressLabel(2048, null)).toBe("已下载 2.0 KB");
    expect(downloadProgressLabel(2048, 0)).toBe("已下载 2.0 KB");
  });

  it("shows the new version and its notes when they exist", () => {
    expect(updateFoundMessage("0.1.2", "QA 更新链路验证")).toContain("0.1.2");
    expect(updateFoundMessage("0.1.2", "QA 更新链路验证")).toContain("QA 更新链路验证");
    expect(updateFoundMessage("0.1.2", "   ")).toBe("发现新版本 0.1.2，当前版本可继续使用。");
  });
});
