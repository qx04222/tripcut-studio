// @vitest-environment jsdom
// R19 U-09:首次自动挑选零决定 —— 库里无收藏无星时不弹面板,直接按全部 + 平台预算跑;面板只在第二次或手动点时出现。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  autoSelectEpisode: vi.fn(),
  getCurrentEpisode: vi.fn(),
  listPlatformPresets: vi.fn(),
  getMomentsProgress: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...apiMocks }));
const feedMock = vi.hoisted(() => ({ clips: [] as unknown[] }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => ({ clips: feedMock.clips }), refreshClipsFeed: vi.fn(async () => undefined) }));

import { BandAutoSelect, autoSelectToast, autoSelectToastActions, type AutoSelectResult } from "./BandAutoSelect";
import { OPEN_AUTO_SELECT_EVENT } from "./onboarding";

const uncurated = { id: 1, binary_rating: null, star_rating: null, select_count: 0, analysis_status: "done" };
const OUTCOME: AutoSelectResult = { created: [1, 2, 3], total_secs: 44.6, chapters_covered: 2, batch_id: "auto-7", placed: 3, arrange_batch_id: "arr-7", scope_used: "all", fell_back: false };

beforeEach(() => {
  feedMock.clips = [uncurated, { ...uncurated, id: 2 }];
  apiMocks.autoSelectEpisode.mockReset().mockResolvedValue(OUTCOME);
  apiMocks.getCurrentEpisode.mockReset().mockResolvedValue({ id: 1, title: "EP01", target_platform: "douyin" });
  apiMocks.listPlatformPresets.mockReset().mockResolvedValue([
    { platform: "douyin", display_name: "抖音", portrait: [1080, 1920], landscape: [1920, 1080], duration_budget_ticks: 45_000, tb_num: 1, tb_den: 1_000, subtitle_style: {} },
  ]);
  apiMocks.getMomentsProgress.mockReset().mockResolvedValue({ total: 2, done: 2, failed: 0, running: 0, pending: 0 });
});
afterEach(cleanup);

function open(detail?: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(OPEN_AUTO_SELECT_EVENT, { detail }));
  });
}

describe("R19 U-09:首次自动挑选零决定", () => {
  it("全新库(0 收藏 0 打星 0 精选段)点主按钮:不弹面板,直接按全部 + 平台预算(45 s)跑;结果带 first_run + 预算来源", async () => {
    const onOutcome = vi.fn<(outcome: AutoSelectResult) => void>();
    render(<BandAutoSelect onOutcome={onOutcome} onError={() => undefined} />);
    open();
    await waitFor(() => expect(apiMocks.autoSelectEpisode).toHaveBeenCalledTimes(1));
    expect(apiMocks.autoSelectEpisode).toHaveBeenCalledWith({ scope: "all", budgetSecs: 45 });
    expect(screen.queryByRole("group", { name: "自动挑选精选段" })).toBeNull();
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    const outcome = onOutcome.mock.calls[0]![0];
    expect(outcome.first_run).toBe(true);
    expect(outcome.fell_back).toBe(true);
    expect(outcome.budget_secs).toBe(45);
    expect(outcome.platform_label).toBe("抖音");
    expect(autoSelectToast(outcome)).toBe("你还没收藏或打星,已按全部素材挑了 3 段 · 共 45 s(本集平台:抖音)· 覆盖 2 章");
    // 第二次:面板出现,不再自动跑。
    open();
    expect(await screen.findByRole("group", { name: "自动挑选精选段" })).toBeTruthy();
    expect(apiMocks.autoSelectEpisode).toHaveBeenCalledTimes(1);
  });

  it("toast 的「改范围 / 改时长」入口:只在 first_run 的结果上有;点了派发带 panel 的事件,面板直接开,哪怕是第一次", async () => {
    expect(autoSelectToastActions(OUTCOME)).toEqual([]);
    const [action] = autoSelectToastActions({ ...OUTCOME, first_run: true });
    expect(action?.label).toBe("改范围 / 改时长");
    render(<BandAutoSelect onOutcome={() => undefined} onError={() => undefined} />);
    act(() => action!.onClick());
    expect(await screen.findByRole("group", { name: "自动挑选精选段" })).toBeTruthy();
    expect(apiMocks.autoSelectEpisode).not.toHaveBeenCalled();
  });

  it("库里已有收藏 / 星 / 精选段:第一次也弹面板(有决定可做);手动点工具条按钮永远是面板", async () => {
    feedMock.clips = [{ ...uncurated, binary_rating: 1 }];
    render(<BandAutoSelect onOutcome={() => undefined} onError={() => undefined} />);
    open();
    expect(await screen.findByRole("group", { name: "自动挑选精选段" })).toBeTruthy();
    expect(apiMocks.autoSelectEpisode).not.toHaveBeenCalled();
    cleanup();

    feedMock.clips = [{ ...uncurated, select_count: 2 }];
    render(<BandAutoSelect onOutcome={() => undefined} onError={() => undefined} />);
    open();
    expect(await screen.findByRole("group", { name: "自动挑选精选段" })).toBeTruthy();
    cleanup();

    feedMock.clips = [uncurated];
    render(<BandAutoSelect onOutcome={() => undefined} onError={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "自动挑选精选段" }));
    expect(screen.getByRole("group", { name: "自动挑选精选段" })).toBeTruthy();
    expect(apiMocks.autoSelectEpisode).not.toHaveBeenCalled();
  });
});
