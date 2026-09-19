// @vitest-environment jsdom
// R19 U-09:首次自动挑选零决定 —— 库里无收藏无星时不弹面板,直接按全部 + 平台预算跑;面板只在第二次或手动点时出现。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  // R19 P-03(results 车道):自动挑选统一走带参数的入口(`autoSelectEpisodeWith`),旧断言只换函数名。
  autoSelectEpisodeWith: vi.fn(),
  undoAutoSelect: vi.fn(),
  listAutoSelectRun: vi.fn(),
  getCurrentEpisode: vi.fn(),
  listPlatformPresets: vi.fn(),
  getMomentsProgress: vi.fn(),
  getLlmStatus: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...apiMocks }));
const feedMock = vi.hoisted(() => ({ clips: [] as unknown[] }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => ({ clips: feedMock.clips }), refreshClipsFeed: vi.fn(async () => undefined) }));

import { BandAutoSelect, autoSelectToast, autoSelectToastActions, type AutoSelectResult } from "./BandAutoSelect";
import { OPEN_AUTO_SELECT_EVENT } from "./onboarding";
import { PROMPT_INPUT_NAME } from "./results/PromptInput";
import { RESULTS_LIST_NAME, RESULTS_PANEL_NAME } from "./results/ResultsPanel";
import { SELECT_PROMPT_EVENT } from "./selectPrompt";
import { __resetUndoForTests, canUndo, runUndo } from "./undoStack";

const uncurated = { id: 1, binary_rating: null, star_rating: null, select_count: 0, analysis_status: "done" };
const OUTCOME: AutoSelectResult = { created: [1, 2, 3], total_secs: 44.6, chapters_covered: 2, batch_id: "auto-7", run_id: "auto-7", placed: 3, arrange_batch_id: "arr-7", scope_used: "all", fell_back: false };
const RUN_ROW = { clip_id: 1, in_ticks: 0, out_ticks: 5000, tb_num: 1, tb_den: 1000, secs: 5, score: 0.8, reasons: ["清晰"], siblings: [] };
const RUN_VIEW = { run_id: "auto-7", params: { budget_secs: 45, scope: "all", weights: null, pick: "chapters", prompt: null, target_secs: 5 }, rows: [1, 2, 3].map((id) => ({ ...RUN_ROW, segment_id: id })) };

beforeEach(() => {
  __resetUndoForTests();
  feedMock.clips = [uncurated, { ...uncurated, id: 2 }];
  apiMocks.autoSelectEpisodeWith.mockReset().mockResolvedValue(OUTCOME);
  apiMocks.undoAutoSelect.mockReset().mockResolvedValue(3);
  apiMocks.listAutoSelectRun.mockReset().mockResolvedValue(RUN_VIEW);
  apiMocks.getCurrentEpisode.mockReset().mockResolvedValue({ id: 1, title: "EP01", target_platform: "douyin" });
  apiMocks.listPlatformPresets.mockReset().mockResolvedValue([
    { platform: "douyin", display_name: "抖音", portrait: [1080, 1920], landscape: [1920, 1080], duration_budget_ticks: 45_000, tb_num: 1, tb_den: 1_000, subtitle_style: {} },
  ]);
  apiMocks.getMomentsProgress.mockReset().mockResolvedValue({ total: 2, done: 2, failed: 0, running: 0, pending: 0 });
  apiMocks.getLlmStatus.mockReset().mockResolvedValue({ enabled: false, provider: "none", monthly_budget: 0, calls_this_month: 0, remaining_calls: 0, budget_exhausted: false, providers: [] });
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
    await waitFor(() => expect(apiMocks.autoSelectEpisodeWith).toHaveBeenCalledTimes(1));
    expect(apiMocks.autoSelectEpisodeWith).toHaveBeenCalledWith({ scope: "all", budgetSecs: 45 });
    expect(screen.queryByRole("group", { name: "自动挑选精选段" })).toBeNull();
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    const outcome = onOutcome.mock.calls[0]![0];
    expect(outcome.first_run).toBe(true);
    expect(outcome.fell_back).toBe(true);
    expect(outcome.budget_secs).toBe(45);
    expect(outcome.platform_label).toBe("抖音");
    // F-R19-07:toast 要报实际时长(与结果面板同源的 total_secs),预算只作为「目标约」的参考,不能拿预算冒充实际。
    expect(autoSelectToast(outcome)).toBe("你还没收藏或打星,已按全部素材挑了 3 段 · 共 44.6 s(本集平台:抖音,目标约 45 s)· 覆盖 2 章");
    // 第二次:面板出现,不再自动跑。
    open();
    expect(await screen.findByRole("group", { name: "自动挑选精选段" })).toBeTruthy();
    expect(apiMocks.autoSelectEpisodeWith).toHaveBeenCalledTimes(1);
  });

  it("toast 的「改范围 / 改时长」入口:只在 first_run 的结果上有;点了派发带 panel 的事件,面板直接开,哪怕是第一次", async () => {
    expect(autoSelectToastActions(OUTCOME)).toEqual([]);
    const [action] = autoSelectToastActions({ ...OUTCOME, first_run: true });
    expect(action?.label).toBe("改范围 / 改时长");
    render(<BandAutoSelect onOutcome={() => undefined} onError={() => undefined} />);
    act(() => action!.onClick());
    expect(await screen.findByRole("group", { name: "自动挑选精选段" })).toBeTruthy();
    expect(apiMocks.autoSelectEpisodeWith).not.toHaveBeenCalled();
  });

  it("库里已有收藏 / 星 / 精选段:第一次也弹面板(有决定可做);手动点工具条按钮永远是面板", async () => {
    feedMock.clips = [{ ...uncurated, binary_rating: 1 }];
    render(<BandAutoSelect onOutcome={() => undefined} onError={() => undefined} />);
    open();
    expect(await screen.findByRole("group", { name: "自动挑选精选段" })).toBeTruthy();
    expect(apiMocks.autoSelectEpisodeWith).not.toHaveBeenCalled();
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
    expect(apiMocks.autoSelectEpisodeWith).not.toHaveBeenCalled();
  });
});

describe("R19 P-03:挑完出结果面板,整批进 ⌘Z 栈", () => {
  it("自动挑选完成 → group「为什么是这些」出现,list「挑选结果」行数 = 本批段数;结果带 undo_id", async () => {
    const onOutcome = vi.fn<(outcome: AutoSelectResult) => void>();
    render(<BandAutoSelect onOutcome={onOutcome} onError={() => undefined} />);
    expect(screen.queryByRole("group", { name: RESULTS_PANEL_NAME })).toBeNull();
    open();
    expect(await screen.findByRole("group", { name: RESULTS_PANEL_NAME })).toBeTruthy();
    const list = await screen.findByRole("list", { name: RESULTS_LIST_NAME });
    await waitFor(() => expect(within(list).getAllByRole("listitem").filter((item) => item.parentElement === list)).toHaveLength(OUTCOME.created.length));
    expect(apiMocks.listAutoSelectRun).toHaveBeenCalledWith("auto-7");
    expect(onOutcome.mock.calls[0]![0].undo_id).toEqual(expect.any(Number));
    expect(canUndo()).toBe(true);
  });

  it("⌘Z(撤销栈顶)= 撤这一批:undoAutoSelect 一次、面板收起;之后「全部撤销」不再撤第二次", async () => {
    render(<BandAutoSelect onOutcome={() => undefined} onError={() => undefined} />);
    open();
    await screen.findByRole("group", { name: RESULTS_PANEL_NAME });
    await act(async () => {
      await runUndo();
    });
    expect(apiMocks.undoAutoSelect).toHaveBeenCalledWith("auto-7");
    await waitFor(() => expect(screen.queryByRole("group", { name: RESULTS_PANEL_NAME })).toBeNull());
    expect(canUndo()).toBe(false);
  });

  it("面板的「全部撤销」= 同一条栈:撤一次、栈清空、面板收起", async () => {
    render(<BandAutoSelect onOutcome={() => undefined} onError={() => undefined} />);
    open();
    await screen.findByRole("group", { name: RESULTS_PANEL_NAME });
    await screen.findAllByRole("button", { name: "不要这一段 · 素材 1" });
    fireEvent.click(screen.getByRole("button", { name: "全部撤销" }));
    await waitFor(() => expect(apiMocks.undoAutoSelect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("group", { name: RESULTS_PANEL_NAME })).toBeNull());
    expect(canUndo()).toBe(false);
  });
});

describe("R19 P-01:一句话挑片(面板顶部输入框 → Enter → 参数 → 结果面板)", () => {
  it("输入「挑 60 秒,风景为主,少人脸,按时间顺序」→ Enter:后端收到 60 秒 / 权重偏置 / 按时间顺序 / 原句;镜头带段数 ≥ 1 且每段 reason 非空;⌘Z 后回 0", async () => {
    render(<BandAutoSelect onOutcome={() => undefined} onError={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "自动挑选精选段" }));
    const input = screen.getByRole("textbox", { name: PROMPT_INPUT_NAME });
    fireEvent.change(input, { target: { value: "挑 60 秒,风景为主,少人脸,按时间顺序" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(apiMocks.autoSelectEpisodeWith).toHaveBeenCalledTimes(1));
    const params = apiMocks.autoSelectEpisodeWith.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({ budgetSecs: 60, pick: "chapters", prompt: "挑 60 秒,风景为主,少人脸,按时间顺序", scope: "all" });
    expect(params.weights).toEqual(expect.objectContaining({ interest: expect.any(Number) }));
    // 面板收起、结果面板出现、每段 reason 非空。
    await waitFor(() => expect(screen.queryByRole("group", { name: "自动挑选精选段" })).toBeNull());
    const list = await screen.findByRole("list", { name: RESULTS_LIST_NAME });
    await waitFor(() => expect(within(list).getAllByRole("listitem").filter((item) => item.parentElement === list).length).toBeGreaterThanOrEqual(1));
    for (const row of within(list).getAllByRole("listitem").filter((item) => item.parentElement === list)) {
      expect(row.querySelector(".results-row-reason")?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
    await act(async () => {
      await runUndo();
    });
    expect(apiMocks.undoAutoSelect).toHaveBeenCalledWith("auto-7");
    await waitFor(() => expect(screen.queryByRole("list", { name: RESULTS_LIST_NAME })).toBeNull());
  });

  it("空句不提交;首页预设卡广播的 tripcut:select-prompt 直接跑(不弹面板);LLM 不可用不报错", async () => {
    const onError = vi.fn();
    render(<BandAutoSelect onOutcome={() => undefined} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "自动挑选精选段" }));
    const input = screen.getByRole("textbox", { name: PROMPT_INPUT_NAME });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(apiMocks.autoSelectEpisodeWith).not.toHaveBeenCalled();
    apiMocks.getLlmStatus.mockRejectedValue(new Error("no llm"));
    act(() => {
      window.dispatchEvent(new CustomEvent(SELECT_PROMPT_EVENT, { detail: { sentence: "30 秒快节奏,多运动,按分数" } }));
    });
    await waitFor(() => expect(apiMocks.autoSelectEpisodeWith).toHaveBeenCalledTimes(1));
    expect(apiMocks.autoSelectEpisodeWith.mock.calls[0]![0]).toMatchObject({ budgetSecs: 30, pick: "score" });
    expect(onError).not.toHaveBeenCalled();
    expect(await screen.findByRole("group", { name: RESULTS_PANEL_NAME })).toBeTruthy();
    // 结果面板顶部也有输入框(再挑一次)。
    expect(screen.getByRole("textbox", { name: PROMPT_INPUT_NAME })).toBeTruthy();
  });
});
