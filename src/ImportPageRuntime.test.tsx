// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportPage, analysisProgress } from "./ImportPage";
import type { ClipListItem } from "./api";

const api = vi.hoisted(() => ({
  getImportProgress: vi.fn(), listClips: vi.fn(), getCurrentEpisode: vi.fn(),
  getSettingsStatus: vi.fn(), listWatchedFolders: vi.fn(), pickImportFolder: vi.fn(),
  startImport: vi.fn(), getClipArtifacts: vi.fn(), setWatchedFolderSync: vi.fn(),
  removeWatchedFolder: vi.fn(), rescanWatchedFolders: vi.fn(), importPaths: vi.fn(),
  getClipsRevision: vi.fn(),
}));
vi.mock("./api", () => api);
vi.mock("./ImportManagement", () => ({ ImportManagement: () => null }));
vi.mock("./MissingMediaPanel", () => ({ MissingMediaPanel: () => null }));

type DragDropPayload =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "drop"; paths: string[] }
  | { type: "leave" };
const webview = vi.hoisted(() => ({
  dragDropCallback: undefined as ((event: { payload: DragDropPayload }) => void) | undefined,
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: { payload: DragDropPayload }) => void) => {
      webview.dragDropCallback = handler;
      return Promise.resolve(webview.unlisten);
    },
  }),
}));
const fireDragDrop = (payload: DragDropPayload) => webview.dragDropCallback!({ payload });
let root: Root;
let host: HTMLDivElement;
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.getImportProgress.mockResolvedValue({ total: 3, done: 2, failed: 1, running: 0, waiting_for_permit: 0, paused_for_memory: false });
  api.listClips.mockResolvedValue([]);
  // 默认每次调用都返回不同的修订号,保持既有用例"每轮都全量拉取"的行为;
  // 想测跳过逻辑的用例自己覆盖成固定值。
  let revisionCounter = 0;
  api.getClipsRevision.mockImplementation(() => Promise.resolve(`rev-${revisionCounter++}`));
  api.getCurrentEpisode.mockResolvedValue({ id: 1 });
  api.getSettingsStatus.mockResolvedValue({ ffmpeg: { available: true }, ffprobe: { available: true } });
  api.listWatchedFolders.mockResolvedValue([]);
  webview.dragDropCallback = undefined;
  webview.unlisten.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function render() { await act(async () => root.render(<ImportPage />)); }

describe("import refresh and recovery", () => {
  it("waits for a slow refresh before scheduling another and stops after unmount", async () => {
    let resolve!: (value: never[]) => void;
    api.listClips.mockReturnValueOnce(new Promise<never[]>((done) => { resolve = done; }));
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(api.listClips).toHaveBeenCalledTimes(1);
    await act(async () => resolve([]));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(api.listClips).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(api.listClips).toHaveBeenCalledTimes(2);
    root = createRoot(host);
  });

  it("keeps an import failure visible through successful background refreshes", async () => {
    api.pickImportFolder.mockResolvedValue("/missing-card");
    api.startImport.mockRejectedValue(new Error("移动硬盘已断开"));
    await render();
    const choose = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("选择素材文件夹"))!;
    await act(async () => choose.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("移动硬盘已断开");
    await act(async () => vi.advanceTimersByTimeAsync(4_500));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("移动硬盘已断开");
    expect(host.textContent).not.toContain("本批素材已全部处理完成");
    expect(host.textContent).toContain("1 项未能导入");
  });

  it("shows transient refresh failures and recovers on the next successful request", async () => {
    api.listClips.mockRejectedValueOnce(new Error("数据库忙"));
    await render();
    expect(host.textContent).toContain("刷新暂时失败");
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await flush();
    expect(host.textContent).not.toContain("刷新暂时失败");
  });

  it("skips listClips while the clips revision is unchanged across polls", async () => {
    api.getClipsRevision.mockResolvedValue("rev-A");
    await render();
    expect(api.listClips).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(api.listClips).toHaveBeenCalledTimes(1);
  });

  it("fetches listClips again once the clips revision changes", async () => {
    api.getClipsRevision.mockResolvedValue("rev-A");
    await render();
    expect(api.listClips).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(api.listClips).toHaveBeenCalledTimes(1);
    api.getClipsRevision.mockResolvedValue("rev-B");
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(api.listClips).toHaveBeenCalledTimes(2);
  });

  it("falls back to a full fetch when getClipsRevision rejects", async () => {
    api.getClipsRevision.mockRejectedValue(new Error("no revision command"));
    await render();
    expect(api.listClips).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(api.listClips).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and refreshes immediately when visible", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await render();
    visibility.mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(api.listClips).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(api.listClips).toHaveBeenCalledTimes(2);
  });

  it("does not let an older poll overwrite a completed import refresh", async () => {
    let resolve!: (value: never[]) => void;
    api.getImportProgress.mockResolvedValueOnce({ total: 3, done: 0, failed: 0, running: 1, waiting_for_permit: 0, paused_for_memory: false });
    api.listClips.mockReturnValueOnce(new Promise<never[]>((done) => { resolve = done; }));
    api.pickImportFolder.mockResolvedValue("/test-fixtures");
    api.startImport.mockResolvedValue({ total: 3, enqueued: 3, skipped: 0 });
    await render();
    const choose = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("选择素材文件夹"))!;
    await act(async () => choose.click());
    expect(host.querySelector(".progress-copy strong")?.textContent).toBe("3");
    await act(async () => resolve([]));
    expect(host.querySelector(".progress-copy strong")?.textContent).toBe("3");
  });

  it("highlights the drop target while a drag is over the page", async () => {
    await render();
    await flush();
    act(() => fireDragDrop({ type: "enter", paths: ["/Volumes/CARD"] }));
    expect(host.querySelector(".import-panel")?.className).toContain("drop-target");
    expect(host.textContent).toContain("松开即导入");
    act(() => fireDragDrop({ type: "leave" }));
    expect(host.querySelector(".import-panel")?.className).not.toContain("drop-target");
  });

  it("imports the dropped paths and refreshes the clip list", async () => {
    api.importPaths.mockResolvedValue([{ folder: "/Volumes/CARD", total: 2, enqueued: 2, skipped: 0 }]);
    await render();
    await flush();
    act(() => fireDragDrop({ type: "enter", paths: ["/Volumes/CARD/旅拍 🎬.mp4"] }));
    await act(async () => fireDragDrop({ type: "drop", paths: ["/Volumes/CARD/旅拍 🎬.mp4"] }));
    await flush();
    expect(api.importPaths).toHaveBeenCalledWith(["/Volumes/CARD/旅拍 🎬.mp4"]);
    expect(host.querySelector(".import-panel")?.className).not.toContain("drop-target");
    expect(host.textContent).toContain("已发现 2 个视频，新增 2 项");
    expect(api.listClips.mock.calls.length).toBeGreaterThan(1);
  });

  it("clears highlight on empty drop without importing", async () => {
    await render();
    await flush();
    act(() => fireDragDrop({ type: "enter", paths: [] }));
    expect(host.querySelector(".import-panel")?.className).toContain("drop-target");
    act(() => fireDragDrop({ type: "drop", paths: [] }));
    expect(host.querySelector(".import-panel")?.className).not.toContain("drop-target");
    expect(api.importPaths).not.toHaveBeenCalled();
  });

  it("stops listening for drag-drop events after unmount", async () => {
    await render();
    await flush();
    expect(webview.dragDropCallback).toBeDefined();
    await act(async () => root.unmount());
    expect(webview.unlisten).toHaveBeenCalledTimes(1);
    root = createRoot(host);
  });

  it("does not count an old result as complete while reanalysis is queued or failed", () => {
    const clips = [
      { analysis: {}, analysis_status: "pending", motion: {}, motion_status: "running" },
      { analysis: {}, analysis_status: "blocked", motion: null, motion_status: null },
      { analysis: {}, analysis_status: "done", motion: {}, motion_status: "done" },
    ] as ClipListItem[];
    expect(analysisProgress(clips, "analysis")).toEqual({ done: 1, running: 0, failed: 1, waiting: 1 });
    expect(analysisProgress(clips, "motion")).toEqual({ done: 1, running: 1, failed: 0, waiting: 1 });
  });
});
