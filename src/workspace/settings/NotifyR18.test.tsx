// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { GUIDES, GUIDE_IDS, nextGuide } from "../guides";
import { NOTIFY_SWITCHES, PrivacySection, notifyOn } from "./PrivacySection";
import { SettingsFormContext } from "./SettingsFormContext";
import type { SettingsForm } from "./useSettingsForm";

function mount(settings: Record<string, string>, save = vi.fn(async () => true)) {
  const form = { settings, save } as unknown as SettingsForm;
  render(
    <SettingsFormContext.Provider value={form}>
      <PrivacySection />
    </SettingsFormContext.Provider>,
  );
  return save;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

/**
 * R18 车道 settings F1:两条系统通知各自一个开关。这里钉的是界面这一侧
 * (默认开、点一下写 "false"、两条互不牵连);后端「关掉后 MockSink 零调用」
 * 由 `src-tauri/src/notify.rs::post_gated_stays_silent_when_switched_off` 钉。
 */
describe("F1 通知开关", () => {
  it("没存过时两条都显示为开", () => {
    mount({});
    expect(screen.getByRole("switch", { name: NOTIFY_SWITCHES.exportComplete }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: NOTIFY_SWITCHES.batchComplete }).getAttribute("aria-checked")).toBe("true");
  });

  it("只有显式 false 才算关,且两条互不牵连", () => {
    mount({ "notification.export_complete": "false" });
    expect(screen.getByRole("switch", { name: NOTIFY_SWITCHES.exportComplete }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: NOTIFY_SWITCHES.batchComplete }).getAttribute("aria-checked")).toBe("true");
  });

  it("点一下把对应的键写成 false", () => {
    const save = mount({});
    fireEvent.click(screen.getByRole("switch", { name: NOTIFY_SWITCHES.batchComplete }));
    expect(save).toHaveBeenCalledWith("notification.batch_complete", "false");
    expect(save).not.toHaveBeenCalledWith("notification.export_complete", expect.anything());
  });

  it("notifyOn 与 Rust 的 notification_enabled 同一条规则:只有 'false' 算关", () => {
    expect(notifyOn({}, "notification.export_complete")).toBe(true);
    expect(notifyOn({ "notification.export_complete": "" }, "notification.export_complete")).toBe(true);
    expect(notifyOn({ "notification.export_complete": "false" }, "notification.export_complete")).toBe(false);
  });

  it("首次说明是一只只出一次的气泡,排在 nav 之后、在用户进到工作区时出", () => {
    expect(GUIDE_IDS).toContain("notify");
    expect(GUIDES.notify.text).toContain("系统会问你要不要允许");
    // nav 先出;nav 看过之后轮到 notify。
    const signals = { inWorkspace: true, backgroundRunning: true, selectedClipHasSuggestions: false, pipelineStep: 1 as const, bandHasShots: false, gapVisible: false, exportDrawerOpen: false, overlayOpen: false, playbackEnded: false };
    expect(nextGuide(signals, new Set(), new Set(), new Set())).toBe("nav");
    expect(nextGuide(signals, new Set(["guide.nav.viewed"]), new Set(), new Set())).toBe("notify");
    expect(nextGuide(signals, new Set(["guide.nav.viewed", "guide.notify.viewed"]), new Set(), new Set())).not.toBe("notify");
  });
});
