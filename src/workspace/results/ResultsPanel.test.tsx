// @vitest-environment jsdom
// R19 P-03「为什么是这些」结果面板:行数 = 本批段数;「不要这一段」行消失;「换一段」重取;「全部撤销」走撤销栈;Esc 收起。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutoSelectRunRow, AutoSelectRunView } from "../../api";
import { DUEL_CHANGED } from "../duel/duelBus";

const apiMocks = vi.hoisted(() => ({
  listAutoSelectRun: vi.fn(),
  replaceAutoSegment: vi.fn(),
  undoReplaceAutoSegment: vi.fn(async () => true),
  deleteSelectSegment: vi.fn(),
  restoreSelectSegment: vi.fn(),
}));
vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...apiMocks }));
const feedMock = vi.hoisted(() => ({ clips: [] as Array<{ id: number; binary_rating?: number | null; [key: string]: unknown }> }));
vi.mock("../useClipsFeed", () => ({ useClipsFeed: () => ({ clips: feedMock.clips, clipsById: new Map(feedMock.clips.map((clip) => [clip.id, clip])) }), refreshClipsFeed: vi.fn(async () => undefined) }));

import { __resetUndoForTests, canUndo, runUndo } from "../undoStack";
import { RESULTS_LIST_NAME, RESULTS_PANEL_NAME, ResultsPanel } from "./ResultsPanel";
import { paramsText, reasonText, summaryText } from "./resultsModel";
import { getToastSnapshot } from "../ui/toastStore";

function row(segmentId: number, clipId: number, extra: Partial<AutoSelectRunRow> = {}): AutoSelectRunRow {
  return { segment_id: segmentId, clip_id: clipId, in_ticks: 1000, out_ticks: 6000, tb_num: 1, tb_den: 1000, secs: 5, score: 0.86, reasons: ["清晰", "运动适中"], siblings: [], ...extra };
}

function view(rows: AutoSelectRunRow[]): AutoSelectRunView {
  return { run_id: "auto-1", params: { budget_secs: 45, scope: "all", weights: null, pick: "chapters", prompt: null, target_secs: 5 }, rows };
}

/** list「挑选结果」的直接子行(兄弟段的折叠列表是嵌套的另一个 list,不算行)。 */
function rowsOf(list: HTMLElement): HTMLElement[] {
  return within(list).getAllByRole("listitem").filter((item) => item.parentElement === list);
}

const ROWS = [row(901, 1, { siblings: [{ clip_id: 4, score: 0.7 }, { clip_id: 5, score: 0.6 }] }), row(902, 2), row(903, 3)];

beforeEach(() => {
  __resetUndoForTests();
  feedMock.clips = [1, 2, 3, 4, 5].map((id) => ({ id, file_name: `DAY1_00${id}.MOV`, cover_url: `/c/${id}.jpg` }));
  apiMocks.listAutoSelectRun.mockReset().mockResolvedValue(view(ROWS));
  apiMocks.replaceAutoSegment.mockReset();
  apiMocks.deleteSelectSegment.mockReset().mockResolvedValue(undefined);
  apiMocks.restoreSelectSegment.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("R19 P-03 结果面板", () => {
  it("照片结果面板的再挑一次沿用照片张数与质量提示", () => {
    render(<ResultsPanel runId="auto-1" mode="photo" onPrompt={() => undefined} onClose={() => undefined} onUndoAll={async () => true} />);
    const input = screen.getByRole("textbox", { name: "一句话挑片" }) as HTMLInputElement;
    expect(input.placeholder).toBe("例如：挑 20 张，优先清晰、构图完整，按拍摄时间排序");
  });

  it("视频结果面板的再挑一次保留视频时长提示", () => {
    render(<ResultsPanel runId="auto-1" onPrompt={() => undefined} onClose={() => undefined} onUndoAll={async () => true} />);
    const input = screen.getByRole("textbox", { name: "一句话挑片" }) as HTMLInputElement;
    expect(input.placeholder).toBe("例如:挑 60 秒,风景为主,少人脸,按时间顺序");
  });

  it("照片模式使用换一张/不要这张", async () => {
    const opened = vi.fn();
    window.addEventListener("tripcut:open-duel", opened, { once: true });
    render(<ResultsPanel runId="auto-1" mode="photo" onClose={() => undefined} onUndoAll={async () => true} />);
    expect(await screen.findByRole("button", { name: "不要这张 · DAY1_001" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "换一张 · DAY1_001" }).getAttribute("title")).toBe("换成同一相似组里的另一张");
    fireEvent.click(screen.getByRole("button", { name: "进擂台" }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      clipIds: [1, 4, 5],
      segmentId: 901,
      source: "results",
    });
  });
  it("照片擂台换成 B 后刷新同一结果行，整批账本不会空掉", async () => {
    apiMocks.listAutoSelectRun
      .mockResolvedValueOnce(view([row(901, 1, { siblings: [{ clip_id: 4, score: 0.7 }] })]))
      .mockResolvedValue(view([row(901, 4, { reasons: ["擂台胜出"] })]));
    render(<ResultsPanel runId="auto-1" mode="photo" onClose={() => undefined} onUndoAll={async () => true} />);
    expect(await screen.findByRole("button", { name: "不要这张 · DAY1_001" })).toBeTruthy();
    act(() => window.dispatchEvent(new Event(DUEL_CHANGED)));
    expect(await screen.findByRole("button", { name: "不要这张 · DAY1_004" })).toBeTruthy();
    const list = screen.getByRole("list", { name: RESULTS_LIST_NAME });
    expect(rowsOf(list)).toHaveLength(1);
    expect(rowsOf(list)[0]!.getAttribute("data-segment-id")).toBe("901");
  });

  it("照片面板已打开时，feed 中 X 会立即同步行、张数、siblings 与操作", async () => {
    const rendered = render(<ResultsPanel runId="auto-1" mode="photo" onClose={() => undefined} onUndoAll={async () => true} />);
    const list = await screen.findByRole("list", { name: RESULTS_LIST_NAME });
    await waitFor(() => expect(rowsOf(list)).toHaveLength(3));
    feedMock.clips = feedMock.clips.map((clip) => clip.id === 1 || clip.id === 4 ? { ...clip, binary_rating: -1 } : clip);
    rendered.rerender(<ResultsPanel runId="auto-1" mode="photo" onClose={() => undefined} onUndoAll={async () => true} />);
    await waitFor(() => expect(rowsOf(list)).toHaveLength(2));
    expect(screen.getByText(/2 张/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "不要这张 · DAY1_001" })).toBeNull();
    expect(screen.queryByText(/DAY1_004/)).toBeNull();

    feedMock.clips = feedMock.clips.map((clip) => clip.id === 1 ? { ...clip, binary_rating: 0 } : clip);
    rendered.rerender(<ResultsPanel runId="auto-1" mode="photo" onClose={() => undefined} onUndoAll={async () => true} />);
    await waitFor(() => expect(rowsOf(list)).toHaveLength(3));
    expect(screen.getByText(/3 张/)).toBeTruthy();
  });
  it("R20: 每行可修提示及未选原因显示中文", async () => {
    apiMocks.listAutoSelectRun.mockResolvedValue({ ...view([row(901, 1, { fixable: ["exposure_bright"] })]), unselected: [{ clip_id: 2, blockers: ["defocus"] }] });
    render(<ResultsPanel runId="auto-1" onClose={() => undefined} onUndoAll={async () => true} />);
    expect(await screen.findByText("可修:曝光偏亮")).toBeTruthy();
    expect(await screen.findByText(/DAY1_002.*未选:失焦/)).toBeTruthy();
    expect(screen.getByRole("group", { name: RESULTS_PANEL_NAME }).textContent).not.toMatch(/exposure_bright|defocus/);
  });
  it("list「挑选结果」行数 = 本批段数;每行有缩略图 / 时长 / 中文理由;被去重掉的兄弟可展开", async () => {
    render(<ResultsPanel runId="auto-1" onClose={() => undefined} onUndoAll={async () => true} />);
    expect(screen.getByRole("group", { name: RESULTS_PANEL_NAME })).toBeTruthy();
    const list = await screen.findByRole("list", { name: RESULTS_LIST_NAME });
    await waitFor(() => expect(rowsOf(list)).toHaveLength(3));
    expect(apiMocks.listAutoSelectRun).toHaveBeenCalledWith("auto-1");
    const first = rowsOf(list)[0]!;
    expect(first.textContent).toContain("DAY1_001");
    expect(first.textContent).toContain("5.0 s");
    expect(first.textContent).toContain("清晰 · 运动适中");
    expect(first.querySelector("img")?.getAttribute("src")).toBe("/c/1.jpg");
    // 兄弟段折叠行:标题带条数,展开后列出名字与分数。
    const details = first.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toBe("还有 2 条相似的没选");
    expect(details?.textContent).toContain("DAY1_004 · 70 分");
    // 其它两行没有兄弟 → 没有折叠行。
    expect(rowsOf(list)[1]!.querySelector("details")).toBeNull();
    expect(screen.getByText(`${summaryText(ROWS)} · ${paramsText(view(ROWS))}`)).toBeTruthy();
    expect(reasonText([])).toBe("这一段分数最高");
  });

  it("「不要这一段」:软删那一段(进 ⌘Z 栈)并重取 → 行消失、行数 −1", async () => {
    render(<ResultsPanel runId="auto-1" onClose={() => undefined} onUndoAll={async () => true} />);
    const list = await screen.findByRole("list", { name: RESULTS_LIST_NAME });
    await waitFor(() => expect(rowsOf(list)).toHaveLength(3));
    apiMocks.listAutoSelectRun.mockResolvedValue(view(ROWS.filter((item) => item.segment_id !== 902)));
    fireEvent.click(screen.getByRole("button", { name: "不要这一段 · DAY1_002" }));
    await waitFor(() => expect(apiMocks.deleteSelectSegment).toHaveBeenCalledWith(902));
    await waitFor(() => expect(rowsOf(list)).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "不要这一段 · DAY1_002" })).toBeNull();
    expect(canUndo()).toBe(true);
  });

  it("「换一段」:调 replace 后重取,换进来的那条顶上", async () => {
    render(<ResultsPanel runId="auto-1" onClose={() => undefined} onUndoAll={async () => true} />);
    const list = await screen.findByRole("list", { name: RESULTS_LIST_NAME });
    await waitFor(() => expect(rowsOf(list)).toHaveLength(3));
    apiMocks.replaceAutoSegment.mockResolvedValue(row(904, 4, { reasons: ["曝光正常"] }));
    apiMocks.listAutoSelectRun.mockResolvedValue(view([row(904, 4, { reasons: ["曝光正常"] }), ROWS[1]!, ROWS[2]!]));
    fireEvent.click(screen.getByRole("button", { name: "换一段 · DAY1_001" }));
    await waitFor(() => expect(apiMocks.replaceAutoSegment).toHaveBeenCalledWith(901));
    await waitFor(() => expect(screen.queryByRole("button", { name: "换一段 · DAY1_004" })).toBeTruthy());
    expect(rowsOf(list)).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "换一段 · DAY1_001" })).toBeNull();
    expect(canUndo()).toBe(true);
    apiMocks.listAutoSelectRun.mockResolvedValue(view(ROWS));
    await act(async () => { await runUndo(); });
    expect(apiMocks.undoReplaceAutoSegment).toHaveBeenCalledWith("auto-1", 901);
    expect(await screen.findByRole("button", { name: "换一段 · DAY1_001" })).toBeTruthy();
  });

  it("「全部撤销」走传进来的整批撤销并收起;Esc 也收起;「收起挑选结果」按钮收起", async () => {
    const onClose = vi.fn();
    const onUndoAll = vi.fn(async () => true);
    render(<ResultsPanel runId="auto-1" onClose={onClose} onUndoAll={onUndoAll} />);
    await screen.findByRole("button", { name: "不要这一段 · DAY1_001" });
    fireEvent.click(screen.getByRole("button", { name: "全部撤销" }));
    await waitFor(() => expect(onUndoAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "收起挑选结果" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("这批一条都不剩:空态一句 + 「全部撤销」禁用", async () => {
    apiMocks.listAutoSelectRun.mockResolvedValue(view([]));
    render(<ResultsPanel runId="auto-1" onClose={() => undefined} onUndoAll={async () => true} />);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect((screen.getByRole("button", { name: "全部撤销" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

it("R21 §0.5 照片结果只说张数与照片语义，不把 hold_ms 当视频时长", async () => {
  feedMock.clips = [{ id: 1, file_name: "photo.jpg", kind: "photo", duration_ticks: 0, photo: { hold_ms: 3000 } }];
  apiMocks.listAutoSelectRun.mockResolvedValue(view([row(901, 1, { in_ticks: 0, out_ticks: 0, secs: 0, reasons: [], siblings: [{ clip_id: 4, score: 0.7 }] })]));
  render(<ResultsPanel mode="photo" runId="auto-1" onClose={() => undefined} onUndoAll={async () => true} />);
  const panel = await screen.findByRole("group", { name: RESULTS_PANEL_NAME });
  expect(panel.textContent).toContain("1 张");
  expect(panel.textContent).toContain("这张照片分数最高");
  expect(panel.textContent).toContain("还有 1 张相似的没选");
  expect(panel.textContent).not.toMatch(/3\.0 s|共\s*\d+(?:\.\d+)?\s*s|\d+(?:\.\d+)?\s*s · 86 分/);
});

it("R21 §0.5 照片删除失败 toast 使用『不要这张』，视频措辞保持不变", async () => {
  feedMock.clips = [{ id: 1, file_name: "photo.jpg", kind: "photo", duration_ticks: 0, photo: { hold_ms: 3000 } }];
  apiMocks.listAutoSelectRun.mockResolvedValue(view([row(901, 1)]));
  apiMocks.deleteSelectSegment.mockRejectedValueOnce(new Error("数据库忙"));
  render(<ResultsPanel mode="photo" runId="auto-1" onClose={() => undefined} onUndoAll={async () => true} />);
  fireEvent.click(await screen.findByRole("button", { name: "不要这张 · photo" }));
  await waitFor(() => expect(getToastSnapshot()?.text).toContain("不要这张"));
  expect(getToastSnapshot()?.text).not.toContain("不要这一段");
  expect(summaryText(ROWS)).toBe("3 段 · 共 15.0 s");
  expect(reasonText([])).toBe("这一段分数最高");
});
