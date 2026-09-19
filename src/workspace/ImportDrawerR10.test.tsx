// @vitest-environment jsdom
// R10 车道 E 对导入抽屉的回归(U-07 / U-08),从 ImportDrawer.test.tsx 分出来守 400 行;
// api 替身与拖放桩与那份一致。
import { act } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({
    getCurrentEpisode: vi.fn(async () => ({ id: 1, title: "EP01", theme: "通用" })),
    getClipsRevision: vi.fn(async () => "rev-0"),
    startImport: vi.fn(async () => ({ imported: 0, duplicates: 0, failed: 0 })),
    getClipArtifacts: vi.fn(async () => ({})),
    pickImportFolder: vi.fn(async () => null),
  });
});
vi.mock("../api", () => apiMocks);
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import type { ClipAnalysis, ClipListItem, ClipMotion } from "../api";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

beforeEach(() => {
  __resetWorkspaceForTests();
  apiMocks.listWatchedFolders.mockResolvedValue([]);
  apiMocks.listImportBatches.mockResolvedValue([]);
  apiMocks.listMissingClips.mockResolvedValue([]);
});
afterEach(cleanup);

async function openImportDrawer(): Promise<void> {
  await act(async () => {
    screen.getByRole("button", { name: "导入素材" }).click();
    await Promise.resolve();
  });
}

describe("R10 U-07:来源分页按钮三态与路径中间省略", () => {
  it("系统面板开着时按钮写「选择中…」而不是「正在扫描…」;选完在扫才写「扫描中…」", async () => {
    let resolvePick: (value: string | null) => void = () => undefined;
    let resolveStart: (value: { folder: string; total: number; enqueued: number; skipped: number }) => void = () => undefined;
    apiMocks.pickImportFolder.mockImplementation(() => new Promise((resolve) => { resolvePick = resolve; }));
    apiMocks.startImport.mockImplementation(() => new Promise((resolve) => { resolveStart = resolve; }));
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    // R19 U-05:没有关注文件夹时只有拖放区的「选择文件夹」一颗(三态文案照旧落在它身上)。
    await act(async () => {
      within(dialog).getByRole("button", { name: "选择文件夹" }).click();
      await Promise.resolve();
    });
    expect(within(dialog).getByRole("button", { name: "选择中…" })).toBeTruthy();
    expect(within(dialog).queryByText("正在扫描…")).toBeNull();
    await act(async () => {
      resolvePick("/Volumes/CARD/walk-media");
      await Promise.resolve();
    });
    expect(within(dialog).getByRole("button", { name: "扫描中…" })).toBeTruthy();
    await act(async () => {
      resolveStart({ folder: "/Volumes/CARD/walk-media", total: 1, enqueued: 1, skipped: 0 });
      await Promise.resolve();
      await Promise.resolve();
    });
    // U-04/P-10「导入即有地图」:断言迁移——批次真落地(enqueued>0)后抽屉自动收起,
    // 不会再回到「选择文件夹」这颗按钮的三态循环(抽屉都不在了)。
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导入素材" })).toBeNull());
  });

  it("关注文件夹与「最近添加」的路径拆成头 / 尾两段(中间省略),AX 名仍是整条路径", async () => {
    apiMocks.listWatchedFolders.mockResolvedValue([
      { id: 1, path: "/Users/xin/Movies/2026/trip/walk-media", auto_sync: true, last_scan_at: null } as never,
    ]);
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    const path = await within(dialog).findByLabelText("/Users/xin/Movies/2026/trip/walk-media");
    expect(path.className).toContain("import-path--middle");
    expect(path.querySelector(".import-path-head")?.textContent).toBe("/Users/xin/Movies/2026/trip/");
    expect(path.querySelector(".import-path-tail")?.textContent).toBe("walk-media");
  });
});

/** 任务分页的素材夹具:媒体池同时会渲染这些 clips,字段必须齐全(含分析结果本体)。 */
type StageStatus = ClipListItem["analysis_status"];
function jobsClip(id: number, analysis: StageStatus, motion: StageStatus): ClipListItem {
  const analysisBody: ClipAnalysis = {
    clip_id: id, exposure_yavg: 110, overexposed_ratio: 0, audio_peak_db: -6, audio_clipped: false, has_audio: true,
    focus_scores: [100], scene_count: 1, analyzed_at: "2026-09-13T00:00:00Z", tool_versions: {}, underexposed_ratio: 0,
    dynamic_range: 0.6, blur_mean: 0.1, entropy_mean: 0.5, motion_mean: 0.2, out_of_focus_ratio: 0,
  };
  const motionBody: ClipMotion = {
    clip_id: id, class: "static", pan_ratio: 0, tilt_ratio: 0, zoom_corr: 0, shake_score: 0, is_shaky: false, sample_pairs: 8, tool_version: "t",
  };
  return {
    id, episode_id: 1, folder_label: null, cover_url: null, path: `/Volumes/CARD/clip-${id}.mov`,
    file_name: `clip-${id}.mov`, byte_size: 2048, quick_hash: null, full_hash: null, tb_num: 1, tb_den: 1000,
    duration_ticks: 12_000, fps_num: 25, fps_den: 1, is_vfr: false, codec: "h264", width: 1920, height: 1080,
    captured_at: null, status: "ready", error: null,
    analysis: analysis === "done" ? analysisBody : null, analysis_status: analysis, analysis_error: null,
    motion: motion === "done" ? motionBody : null, motion_status: motion, motion_error: null,
    binary_rating: null, star_rating: null, select_count: 0,
  };
}

describe("R10 U-08:任务分页顶部三段式,内部状态码不直出", () => {
  it("索引 21/21 100% 时标题写「登记完成，分析进行中」,画质 / 运镜各有自己的计数与百分比", async () => {
    apiMocks.getImportProgress.mockResolvedValue({ total: 21, done: 21, failed: 0, running: 0, waiting_for_permit: 38, paused_for_memory: false });
    __resetClipsFeedForTests();
    apiMocks.getClipsRevision.mockResolvedValue("rev-u08" as never);
    apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "多伦多两日" } as never);
    apiMocks.listClips.mockResolvedValue([
      ...Array.from({ length: 10 }, (_, i) => jobsClip(i + 1, "done", null)),
      ...Array.from({ length: 4 }, (_, i) => jobsClip(i + 11, "running", null)),
      ...Array.from({ length: 7 }, (_, i) => jobsClip(i + 15, null, null)),
    ]);
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "jobs" });
    render(<WorkspaceShell />);
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    await within(dialog).findByText("登记完成，分析进行中");
    const tiles = within(dialog).getAllByRole("listitem").filter((node) => node.className.includes("import-pipeline-tile"));
    expect(tiles.map((tile) => tile.querySelector(".import-pipeline-count")?.textContent)).toEqual(["已处理 21 / 21", "已处理 10 / 21", "已处理 0 / 21"]);
    expect(tiles.map((tile) => tile.querySelector(".import-pipeline-percent")?.textContent)).toEqual(["100%", "48%", "0%"]);
    expect(within(dialog).getByRole("progressbar", { name: "画质分析进度" }).getAttribute("aria-valuenow")).toBe("10");
    // 内部状态码不直出:没有「等待解码许可」,换成人话。
    expect(dialog.textContent).not.toContain("等待解码许可");
    expect(dialog.textContent).toContain("解码通道已占满，还有 38 个任务在排队");
  });

  it("全部收尾后陈旧的许可计数不再显示;内存暂停优先于许可排队", async () => {
    apiMocks.getImportProgress.mockResolvedValue({ total: 2, done: 2, failed: 0, running: 0, waiting_for_permit: 5, paused_for_memory: false });
    __resetClipsFeedForTests();
    apiMocks.getClipsRevision.mockResolvedValue("rev-u08b" as never);
    apiMocks.getCurrentEpisode.mockResolvedValue({ id: 1, title: "x" } as never);
    apiMocks.listClips.mockResolvedValue([jobsClip(1, "done", "done"), jobsClip(2, "done", "done")]);
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "jobs" });
    render(<WorkspaceShell />);
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    await within(dialog).findByText("登记与分析全部完成");
    expect(dialog.textContent).not.toContain("解码通道");
    expect(dialog.textContent).not.toContain("等待解码许可");
  });
});
