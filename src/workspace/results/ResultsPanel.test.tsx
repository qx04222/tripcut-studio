// @vitest-environment jsdom
// R19 P-03「为什么是这些」结果面板:行数 = 本批段数;「不要这一段」行消失;「换一段」重取;「全部撤销」走撤销栈;Esc 收起。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutoSelectRunRow, AutoSelectRunView } from "../../api";

const apiMocks = vi.hoisted(() => ({
  listAutoSelectRun: vi.fn(),
  replaceAutoSegment: vi.fn(),
  deleteSelectSegment: vi.fn(),
  restoreSelectSegment: vi.fn(),
}));
vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...apiMocks }));
const feedMock = vi.hoisted(() => ({ clips: [] as unknown[] }));
vi.mock("../useClipsFeed", () => ({ useClipsFeed: () => ({ clips: feedMock.clips }), refreshClipsFeed: vi.fn(async () => undefined) }));

import { __resetUndoForTests, canUndo } from "../undoStack";
import { RESULTS_LIST_NAME, RESULTS_PANEL_NAME, ResultsPanel } from "./ResultsPanel";
import { paramsText, reasonText, summaryText } from "./resultsModel";

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
