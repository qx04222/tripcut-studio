// @vitest-environment jsdom
// R19 P-05:「显示全部功能」开关(设置 › 关于,默认关)。关时只留四步流水线上的常规操作;开时被藏的每一项原样回来。
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({
    getClipsRevision: vi.fn(async () => "rev-1"),
    getCurrentEpisode: vi.fn(async () => ({ id: 1, title: "EP01", theme: "", target_platform: "general", canvas_orientation: "landscape" })),
    // 检查器选中素材后读这几条(默认替身回 [] 会在 `.tags.length` 处抛)。
    getAiDescription: vi.fn(async () => null),
    getClipBrief: vi.fn(async () => null),
    getLlmStatus: vi.fn(async () => ({ enabled: false, provider: "none", budget_exhausted: false, remaining_calls: 0, providers: [] })),
  });
});
vi.mock("../api", () => apiMocks);
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import type { ClipListItem } from "../api";
import { BAND_TABS } from "./BandAccessory";
import { INSPECTOR_SECTIONS } from "./Inspector";
import { SETTINGS_GROUPS, visibleQuickLinks, visibleSettingsGroups, visibleSettingsSections } from "./settings/settingsGroups";
import { SHOW_ALL_FEATURES_KEY, __resetShowAllFeaturesForTests, __setShowAllFeaturesForTests, getShowAllFeatures, hydrateShowAllFeatures, setShowAllFeatures } from "./showAllFeatures";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests, dispatchWorkspace } from "./WorkspaceStore";

const CLIP = {
  kind: "video", id: 1, episode_id: 1, folder_label: null, cover_url: null, path: "/x/a.mov", file_name: "a.mov", byte_size: 1, quick_hash: null, full_hash: null,
  tb_num: 1, tb_den: 1000, duration_ticks: 12_000, fps_num: 25, fps_den: 1, is_vfr: false, codec: "h264", width: 1920, height: 1080, captured_at: null,
  status: "ready", error: null, analysis: null, analysis_status: "done", analysis_error: null, motion: null, motion_status: null, motion_error: null,
  binary_rating: null, star_rating: null, select_count: 0,
} as unknown as ClipListItem;

/** 冒烟脚本视角的「可交互 AX 节点」:按钮 / tab / 开关 / 输入 / 下拉 / 滑杆 / 网格格 / 菜单项 / 链接。 */
const INTERACTIVE = ["button", "tab", "switch", "textbox", "combobox", "slider", "checkbox", "radio", "gridcell", "menuitem", "link", "spinbutton", "searchbox"] as const;
function countInteractive(root: ParentNode): number {
  let total = 0;
  for (const role of INTERACTIVE) total += within(root as HTMLElement).queryAllByRole(role).length;
  return total;
}

beforeEach(() => {
  __resetWorkspaceForTests();
  __resetClipsFeedForTests();
  __resetShowAllFeaturesForTests();
  apiMocks.getSettings.mockResolvedValue({});
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
  apiMocks.listClips.mockResolvedValue([CLIP] as never);
});
afterEach(cleanup);

describe("P-05 store:默认关,存 ui.show_all_features", () => {
  it("默认 false;设置里 true 才开;setShowAllFeatures 立刻生效并写设置", async () => {
    expect(getShowAllFeatures()).toBe(false);
    apiMocks.getSettings.mockResolvedValue({ [SHOW_ALL_FEATURES_KEY]: "true" });
    await hydrateShowAllFeatures();
    expect(getShowAllFeatures()).toBe(true);
    setShowAllFeatures(false);
    expect(getShowAllFeatures()).toBe(false);
    expect(apiMocks.setSetting).toHaveBeenCalledWith(SHOW_ALL_FEATURES_KEY, "false");
  });
});

describe("P-05 纯函数:被藏的清单", () => {
  it("关:设置只剩 项目 / 播放与导出 / 工具 / 关于,工具里没有云端补镜,直达没有「云端补镜」;开:六块全在", () => {
    expect(visibleSettingsGroups(false).map((group) => group.id)).toEqual(["project", "playback", "tools", "about"]);
    expect(visibleSettingsGroups(true)).toEqual(SETTINGS_GROUPS);
    const tools = SETTINGS_GROUPS.find((group) => group.id === "tools")!;
    expect(visibleSettingsSections(tools, false)).toEqual(["tools", "analysis"]);
    expect(visibleSettingsSections(tools, true)).toEqual(["tools", "generation", "analysis"]);
    expect(visibleQuickLinks(false).map((link) => link.label)).toEqual(["隐私与诊断"]);
    expect(visibleQuickLinks(true).map((link) => link.label)).toEqual(["云端补镜", "隐私与诊断"]);
    // 程序直落到被藏的分区(openSettings("keymap"))时那一块照样在。
    expect(visibleSettingsGroups(false, "keymap").map((group) => group.id)).toEqual(["project", "keymap", "playback", "tools", "about"]);
    expect(visibleSettingsSections(tools, false, "generation")).toEqual(["tools", "generation", "analysis"]);
  });
});

async function mountWorkspace(): Promise<void> {
  render(<WorkspaceShell />);
  await screen.findByRole("gridcell");
  await act(async () => {
    dispatchWorkspace({ type: "select-clip", clipId: 1 });
    await Promise.resolve();
  });
  await screen.findByRole("region", { name: "检查器" });
}

describe("P-05 消费点:关时藏、开时原样回来", () => {
  it("镜头带附属 tab:关 = 故事 / 音乐;开 = 冻结的五个", async () => {
    await mountWorkspace();
    // R19 合并:band V-07 把五个 tab 收进「附属：{当前} ⌄」触发钮下的浮层,要先展开才摸得到 tablist(名与 role 不变)。
    fireEvent.click(screen.getByRole("button", { name: /^附属：/ }));
    const list = screen.getByRole("tablist", { name: "镜头带附属视图" });
    expect(within(list).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["故事", "音乐"]);
    act(() => __setShowAllFeaturesForTests(true));
    expect(within(list).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(BAND_TABS.map((tab) => tab.label));
    expect(BAND_TABS.map((tab) => tab.label)).toEqual(["故事", "音乐", "旅程", "地点卡", "模板"]);
  });

  it("检查器折叠段:关 = 没有 技术检查 / 画面评分 / 声音与调色,AI 描述与相似镜头照旧;开 = 五段全在", async () => {
    await mountWorkspace();
    const inspector = screen.getByRole("region", { name: "检查器" });
    const titles = () => [...inspector.querySelectorAll("details.inspector-collapsible .inspector-section-title")].map((node) => node.textContent);
    await waitFor(() => expect(titles()).toContain("AI 描述"));
    expect(titles()).toEqual(["AI 描述", "相似镜头"]);
    act(() => __setShowAllFeaturesForTests(true));
    await waitFor(() => expect(titles()).toEqual(INSPECTOR_SECTIONS.map((section) => section.title)));
    expect(INSPECTOR_SECTIONS).toHaveLength(5);
  });

  it("设置 sheet:关 = 四个 tab、直达只有「隐私与诊断」;关于里有「显示全部功能」开关;打开后六个 tab 与「云端补镜」直达回来", async () => {
    await mountWorkspace();
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "settings" });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    const tabs = () => within(dialog).getAllByRole("tab").map((tab) => tab.textContent?.replace(/\s.*$/, ""));
    expect(within(within(dialog).getByRole("tablist", { name: "设置分区" })).getAllByRole("tab")).toHaveLength(4);
    expect(within(dialog).queryByRole("button", { name: "云端补镜" })).toBeNull();
    await act(async () => {
      within(dialog).getByRole("tab", { name: /关于/ }).click();
      await Promise.resolve();
    });
    const toggle = await within(dialog).findByRole("switch", { name: "显示全部功能" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    expect(apiMocks.setSetting).toHaveBeenCalledWith(SHOW_ALL_FEATURES_KEY, "true");
    expect(within(within(dialog).getByRole("tablist", { name: "设置分区" })).getAllByRole("tab")).toHaveLength(6);
    expect(within(dialog).getByRole("button", { name: "云端补镜" })).toBeTruthy();
    expect(tabs().length).toBeGreaterThanOrEqual(6);
  });

  it("AX 交互节点:关时比开时(≈0.9.1 现状)少 —— 数字写进报告;开时五个附属 tab 全在", async () => {
    await mountWorkspace();
    // R19 合并:先展开 band V-07 的「附属」浮层,两态计数里才都含 tab(关 2 / 开 5);触发钮本身两态都在,不影响差值。
    fireEvent.click(screen.getByRole("button", { name: /^附属：/ }));
    const off = countInteractive(document.body);
    act(() => __setShowAllFeaturesForTests(true));
    await waitFor(() => expect(screen.getByRole("tablist", { name: "镜头带附属视图" }).querySelectorAll("[role='tab']")).toHaveLength(5));
    const on = countInteractive(document.body);
    // eslint-disable-next-line no-console
    console.info(`[P-05] interactive AX nodes: off=${off} on=${on} (${Math.round((1 - off / on) * 100)}% fewer)`);
    expect(off).toBeLessThan(on);
    expect(on - off).toBeGreaterThanOrEqual(3);
  });
});
