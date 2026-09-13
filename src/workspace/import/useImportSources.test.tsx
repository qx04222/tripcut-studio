// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 断言迁自 `src/ImportPageRuntime.test.tsx:161-202`(拖放四例)+ 关注文件夹操作。
const apiMock = await vi.hoisted(async () => (await import("../testApiMock")).createTestApiMock({}));
vi.mock("../../api", () => apiMock);

const webview = vi.hoisted(() => ({ dropHandler: null as ((e: unknown) => void) | null, unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: unknown) => void) => {
      webview.dropHandler = cb;
      return Promise.resolve(() => {
        webview.dropHandler = null;
        webview.unlisten();
      });
    },
  }),
}));

import { useImportSources } from "./useImportSources";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  webview.dropHandler = null;
  apiMock.listWatchedFolders.mockResolvedValue([]);
});

describe("useImportSources(迁自 ImportPageRuntime.test 的拖放与关注文件夹)", () => {
  it("拖入高亮,松手导入并调 onImported,空 drop 只清高亮", async () => {
    apiMock.importPaths.mockResolvedValue([{ folder: "/a", total: 2, enqueued: 2, skipped: 0 }]);
    const onImported = vi.fn();
    const { result } = renderHook(() => useImportSources({ onImported }));
    await act(async () => { await Promise.resolve(); });
    act(() => webview.dropHandler!({ payload: { type: "enter" } }));
    expect(result.current.dragActive).toBe(true);
    act(() => webview.dropHandler!({ payload: { type: "leave" } }));
    expect(result.current.dragActive).toBe(false);
    act(() => webview.dropHandler!({ payload: { type: "over" } }));
    expect(result.current.dragActive).toBe(true);
    await act(async () => {
      webview.dropHandler!({ payload: { type: "drop", paths: ["/a/1.mp4", "/a/2.mp4"] } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.importPaths).toHaveBeenCalledWith(["/a/1.mp4", "/a/2.mp4"]);
    expect(result.current.dragActive).toBe(false);
    expect(result.current.notice).toBe("已发现 2 个视频，新增 2 项");
    expect(onImported).toHaveBeenCalled();
    act(() => webview.dropHandler!({ payload: { type: "enter" } }));
    await act(async () => { webview.dropHandler!({ payload: { type: "drop", paths: [] } }); });
    expect(apiMock.importPaths).toHaveBeenCalledTimes(1);
    expect(result.current.dragActive).toBe(false);
  });

  it("拖放导入失败进 error,不吞", async () => {
    apiMock.importPaths.mockRejectedValue(new Error("移动硬盘已断开"));
    const { result } = renderHook(() => useImportSources());
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      webview.dropHandler!({ payload: { type: "drop", paths: ["/a/1.mp4"] } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toContain("移动硬盘已断开");
  });

  it("卸载后不再监听拖放", async () => {
    const { unmount } = renderHook(() => useImportSources());
    await act(async () => { await Promise.resolve(); });
    expect(webview.dropHandler).not.toBeNull();
    unmount();
    expect(webview.dropHandler).toBeNull();
    expect(webview.unlisten).toHaveBeenCalledTimes(1);
  });

  it("立即扫描:NAS 断线时说清「未扫描」而不是「没有新素材」", async () => {
    apiMock.rescanWatchedFolders.mockResolvedValue({ enqueued: 0, scanned: 1, unavailable: 1 });
    const { result } = renderHook(() => useImportSources());
    await act(async () => { await result.current.rescan(); });
    expect(result.current.notice).toBe("没有新素材;1 个文件夹当前不可用(未挂载或已移除),本轮未扫描");
  });

  it("立即扫描:发现新素材 / 没有可扫描的关注文件夹", async () => {
    apiMock.rescanWatchedFolders.mockResolvedValueOnce({ enqueued: 3, scanned: 1, unavailable: 0 });
    const { result } = renderHook(() => useImportSources());
    await act(async () => { await result.current.rescan(); });
    expect(result.current.notice).toBe("发现 3 条新素材,已开始导入");
    apiMock.rescanWatchedFolders.mockResolvedValueOnce({ enqueued: 0, scanned: 0, unavailable: 0 });
    await act(async () => { await result.current.rescan(); });
    expect(result.current.notice).toBe("没有可扫描的关注文件夹");
  });

  it("选择文件夹:取消不启动导入;成功后通知含 skipped 说明", async () => {
    apiMock.pickImportFolder.mockResolvedValueOnce(null).mockResolvedValueOnce("/Volumes/CARD");
    apiMock.startImport.mockResolvedValue({ folder: "/Volumes/CARD", total: 5, enqueued: 3, skipped: 2 });
    const onImported = vi.fn();
    const { result } = renderHook(() => useImportSources({ onImported }));
    await act(async () => { await result.current.chooseFolder(); });
    expect(apiMock.startImport).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    await act(async () => { await result.current.chooseFolder(); });
    expect(result.current.folder).toBe("/Volumes/CARD");
    expect(result.current.notice).toBe("已发现 5 个视频，新增 3 项，跳过 2 项已入库或已排队素材（可能属于其他集）");
    expect(result.current.choosing).toBe(false);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("导入失败进 error,成功刷新不清掉它", async () => {
    apiMock.pickImportFolder.mockResolvedValue("/missing-card");
    apiMock.startImport.mockRejectedValue(new Error("移动硬盘已断开"));
    const { result } = renderHook(() => useImportSources());
    await act(async () => { await result.current.chooseFolder(); });
    expect(result.current.error).toContain("移动硬盘已断开");
    await act(async () => { await result.current.refreshWatched(); });
    expect(result.current.error).toContain("移动硬盘已断开");
  });

  it("tripcut:action import-pick 触发选择文件夹", async () => {
    apiMock.pickImportFolder.mockResolvedValue(null);
    renderHook(() => useImportSources());
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:action", { detail: "import-pick" }));
      await Promise.resolve();
    });
    expect(apiMock.pickImportFolder).toHaveBeenCalledTimes(1);
  });

  it("关注文件夹:自动同步开关与移除都回读列表;失败进 notice", async () => {
    apiMock.listWatchedFolders.mockResolvedValue([
      { id: 1, path: "/Volumes/TRIP_2026", auto_sync: true, added_at: "", last_scan_at: null },
    ]);
    const { result } = renderHook(() => useImportSources());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.watched).toHaveLength(1);
    await act(async () => { await result.current.setAutoSync(1, false); });
    expect(apiMock.setWatchedFolderSync).toHaveBeenCalledWith(1, false);
    expect(apiMock.listWatchedFolders).toHaveBeenCalledTimes(2);
    apiMock.removeWatchedFolder.mockRejectedValueOnce(new Error("NAS 未挂载"));
    await act(async () => { await result.current.remove(1); });
    expect(result.current.notice).toContain("NAS 未挂载");
  });

  it("工具链缺失时 toolchainMissing=true;状态读不到当作可用", async () => {
    apiMock.getSettingsStatus.mockResolvedValueOnce({ ffmpeg: { available: false }, ffprobe: { available: true } } as never);
    const { result, unmount } = renderHook(() => useImportSources());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.toolchainMissing).toBe(true);
    unmount();
    apiMock.getSettingsStatus.mockRejectedValueOnce(new Error("no status"));
    const second = renderHook(() => useImportSources());
    await act(async () => { await Promise.resolve(); });
    expect(second.result.current.toolchainMissing).toBe(false);
  });
});

describe("R10 U-07:选择中 / 扫描中分开,添加后立刻列出关注文件夹", () => {
  it("面板开着是 choosing,选完在扫是 scanning;两者互斥", async () => {
    let resolvePick: (value: string | null) => void = () => undefined;
    let resolveStart: (value: { folder: string; total: number; enqueued: number; skipped: number }) => void = () => undefined;
    apiMock.pickImportFolder.mockImplementation(() => new Promise((resolve) => { resolvePick = resolve; }));
    apiMock.startImport.mockImplementation(() => new Promise((resolve) => { resolveStart = resolve; }));
    const { result } = renderHook(() => useImportSources());
    let done: Promise<void> = Promise.resolve();
    act(() => { done = result.current.chooseFolder(); });
    expect(result.current.choosing).toBe(true);
    expect(result.current.scanning).toBe(false);
    await act(async () => { resolvePick("/Volumes/CARD"); await Promise.resolve(); });
    expect(result.current.choosing).toBe(false);
    expect(result.current.scanning).toBe(true);
    await act(async () => { resolveStart({ folder: "/Volumes/CARD", total: 1, enqueued: 1, skipped: 0 }); await done; });
    expect(result.current.scanning).toBe(false);
  });

  it("取消选择:choosing 回落,scanning 从没亮过,不调 startImport", async () => {
    apiMock.pickImportFolder.mockResolvedValue(null);
    const { result } = renderHook(() => useImportSources());
    await act(async () => { await result.current.chooseFolder(); });
    expect(result.current.choosing).toBe(false);
    expect(result.current.scanning).toBe(false);
    expect(apiMock.startImport).not.toHaveBeenCalled();
  });

  it("startImport 成功后重新拉 listWatchedFolders,新文件夹当场出现在 watched 里", async () => {
    apiMock.listWatchedFolders.mockResolvedValueOnce([]);
    apiMock.pickImportFolder.mockResolvedValue("/Volumes/CARD/walk-media");
    apiMock.startImport.mockImplementation(async () => {
      apiMock.listWatchedFolders.mockResolvedValue([
        { id: 3, path: "/Volumes/CARD/walk-media", auto_sync: false, last_scan_at: null } as never,
      ]);
      return { folder: "/Volumes/CARD/walk-media", total: 21, enqueued: 21, skipped: 0 };
    });
    const { result } = renderHook(() => useImportSources());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.watched).toEqual([]);
    await act(async () => { await result.current.chooseFolder(); });
    expect(result.current.watched.map((item) => item.path)).toEqual(["/Volumes/CARD/walk-media"]);
  });
});
