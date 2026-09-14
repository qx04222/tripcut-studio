// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./LegacyShell";
import { helpTopicForSection } from "./helpContent";
import { downloadProgressLabel, updateFoundMessage, updaterErrorMessage } from "./updaterClient";

const apiMocks = vi.hoisted(() => ({
  clearCacheAndRebuild: vi.fn(async () => ({ removed_database_rows: 0, reset_jobs: 0, removed_disk_bytes: 0 })),
  clearMinimaxKey: vi.fn(async () => undefined),
  generationAvailability: vi.fn(async () => ({ enabled: false, has_key: false, budget_remaining_usd: 10 })),
  generationLedgerSummary: vi.fn(async () => ({ month: "2026-09", spent_usd: 0, budget_usd: 10, entries: [] })),
  getAppInfo: vi.fn(async () => ({ version: "0.0.0", db_schema_version: 41, worker_count: 4, read_only: false })),
  getComponentStatuses: vi.fn(async () => []),
  getLlmStatus: vi.fn(async () => ({
    enabled: false,
    provider: "none",
    monthly_budget: 200,
    calls_this_month: 0,
    remaining_calls: 200,
    budget_exhausted: false,
    providers: [],
  })),
  getSettings: vi.fn(async () => ({})),
  getSettingsStatus: vi.fn(async () => ({
    ffmpeg: { configured_path: "", resolved_path: "ffmpeg", available: true, version: "6.0", note: null },
    ffprobe: { configured_path: "", resolved_path: "ffprobe", available: true, version: "6.0", note: null },
    whisper: {
      binary: { configured_path: "", resolved_path: "whisper-cli", available: true, version: "1.0", note: null },
      model_tier: "large-v3-turbo",
      model_path: "",
      model_available: true,
      models_directory: "",
    },
    clip_sidecar: {
      venv_path: "",
      service_path: "",
      setup_script: "",
      available: true,
      service_available: true,
      note: "",
    },
    cache: { database_bytes: 0, disk_bytes: 0 },
  })),
  hasMinimaxKey: vi.fn(async () => false),
  listDeviceClocks: vi.fn(async () => []),
  listLlmLedger: vi.fn(async () => []),
  openLogsDirectory: vi.fn(async () => undefined),
  rollbackComponent: vi.fn(async () => ({})),
  runClipSelfCheck: vi.fn(async () => ({})),
  setMinimaxKey: vi.fn(async () => undefined),
  setSetting: vi.fn(async () => undefined),
  setDeviceClockOffset: vi.fn(async () => undefined),
}));

vi.mock("./api", () => apiMocks);

import {
  DEFAULT_SETTINGS,
  SETTINGS_SECTIONS,
  SettingsPage,
  appearanceAttributes,
  clampMinimaxBudgetInput,
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
    // R13 §5:第四档「剪映风格深色」是自己的 data-theme 值,不折成 dark;坏值仍回落跟随系统。
    expect(appearanceAttributes({ "appearance.theme": "jianying-dark" }).theme).toBe("jianying-dark");
    expect(appearanceAttributes({ "appearance.theme": "neon" }).theme).toBeNull();
  });

  it("renders every settings group and the destructive cache confirmation entry", () => {
    const markup = renderToStaticMarkup(<SettingsPage />);

    for (const heading of ["外观", "性能", "设备时钟校正", "工具链", "分析阈值", "订阅大模型增强", "云端补镜（MiniMax）", "隐私与诊断", "缓存", "帮助", "关于"]) {
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
    expect(DEFAULT_SETTINGS.minimax_enabled).toBe("false");
    expect(DEFAULT_SETTINGS.minimax_model).toBe("MiniMax-H3-Max");
    expect(DEFAULT_SETTINGS.minimax_resolution).toBe("768P");
    expect(DEFAULT_SETTINGS.minimax_monthly_budget_usd).toBe("10");
  });

  it("defines the nine sidebar categories including canonical journey time, cloud generation and privacy", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      "appearance",
      "performance",
      "timeline",
      "tools",
      "analysis",
      "generation",
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

describe("R7 Task 7: 云端补镜（MiniMax）设置分区", () => {
  it("renders disabled-by-default state, the persistent generated/ note, and never echoes a stored key", () => {
    const markup = renderToStaticMarkup(<SettingsPage />);

    expect(markup).toContain("云端补镜（MiniMax）");
    expect(markup).toContain("未配置");
    expect(markup).not.toContain("已保存，如需更换请输入新的 Key");
    expect(markup).toContain('type="password"');
    expect(markup).toContain("生成的片段会存到素材库的 generated/ 目录，原素材目录不会被写入");
    expect(markup).toContain("扣费以 MiniMax 平台账单为准");
    expect(markup).toContain("本月尚无生成记录");
  });

  it("clamps the monthly budget input to 500 and reports the clamp", () => {
    expect(clampMinimaxBudgetInput("10")).toEqual({ value: 10, clamped: false });
    expect(clampMinimaxBudgetInput("999999")).toEqual({ value: 500, clamped: true });
    expect(clampMinimaxBudgetInput("-5")).toEqual({ value: 0, clamped: true });
    expect(clampMinimaxBudgetInput("not-a-number")).toEqual({ value: 0, clamped: true });
  });

  const mounted: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

  afterEach(async () => {
    while (mounted.length > 0) {
      const current = mounted.pop();
      if (!current) continue;
      await act(async () => current.root.unmount());
      current.container.remove();
    }
    vi.clearAllMocks();
  });

  async function mountSettingsPage() {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    await act(async () => {
      root.render(<SettingsPage />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    return container;
  }

  it("only shows 已配置 (never the key) after a successful save, and calls setMinimaxKey", async () => {
    apiMocks.hasMinimaxKey.mockResolvedValueOnce(false);
    const container = await mountSettingsPage();

    const input = container.querySelector('input[aria-label="MiniMax API Key"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(container.textContent).toContain("未配置");

    apiMocks.hasMinimaxKey.mockResolvedValue(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "sk-test-secret-value",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const saveButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "保存");
    expect(saveButton).toBeTruthy();
    await act(async () => {
      saveButton!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.setMinimaxKey).toHaveBeenCalledWith("sk-test-secret-value");
    expect(container.textContent).toContain("已配置");
    expect(container.innerHTML).not.toContain("sk-test-secret-value");
    const inputAfter = container.querySelector('input[aria-label="MiniMax API Key"]') as HTMLInputElement;
    expect(inputAfter.value).toBe("");
  });
});
