// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => (await import("./testApiMock")).createTestApiMock({}));
vi.mock("../api", () => apiMock);

const webview = vi.hoisted(() => ({
  dropHandler: null as ((e: unknown) => void) | null,
  unlisten: vi.fn(),
  attachCount: 0,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: unknown) => void) => {
      webview.dropHandler = cb;
      webview.attachCount += 1;
      return Promise.resolve(() => {
        webview.dropHandler = null;
        webview.unlisten();
      });
    },
  }),
}));

const events = vi.hoisted(() => ({ handler: null as ((e: { payload: string[] }) => void) | null }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (e: { payload: string[] }) => void) => {
    events.handler = cb;
    return Promise.resolve(() => {
      events.handler = null;
    });
  },
}));

import { useGlobalDrop } from "./useGlobalDrop";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  webview.dropHandler = null;
  webview.attachCount = 0;
  events.handler = null;
});

describe("useGlobalDrop(M-06①:整窗拖放 + Dock 打开)", () => {
  it("拖入高亮,松手导入一次并广播给每个订阅者", async () => {
    apiMock.importPaths.mockResolvedValue([{ folder: "/a", total: 2, enqueued: 2, skipped: 0 }]);
    const first = { onImported: vi.fn(), onNotice: vi.fn(), onError: vi.fn(), onStart: vi.fn() };
    const second = { onImported: vi.fn(), onNotice: vi.fn(), onError: vi.fn(), onStart: vi.fn() };
    const a = renderHook(() => useGlobalDrop(first));
    const b = renderHook(() => useGlobalDrop(second));
    await act(async () => { await Promise.resolve(); });

    // 两个订阅者只装一次 webview 监听——否则一次松手会导入两遍。
    expect(webview.attachCount).toBe(1);

    act(() => webview.dropHandler!({ payload: { type: "enter" } }));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);
    act(() => webview.dropHandler!({ payload: { type: "leave" } }));
    expect(a.result.current).toBe(false);

    await act(async () => {
      webview.dropHandler!({ payload: { type: "drop", paths: ["/a/1.mp4", "/a/2.mp4"] } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.importPaths).toHaveBeenCalledTimes(1);
    expect(first.onNotice).toHaveBeenCalledWith("已发现 2 个视频，新增 2 项");
    expect(second.onNotice).toHaveBeenCalledWith("已发现 2 个视频，新增 2 项");
    expect(first.onStart).toHaveBeenCalledTimes(1);
    expect(second.onImported).toHaveBeenCalledTimes(1);
  });

  it("Dock 图标 / 「打开方式」发来的路径走同一个导入入口", async () => {
    apiMock.importPaths.mockResolvedValue([{ folder: "/card", total: 7, enqueued: 7, skipped: 0 }]);
    const handlers = { onNotice: vi.fn(), onImported: vi.fn() };
    renderHook(() => useGlobalDrop(handlers));
    await act(async () => { await Promise.resolve(); });
    expect(events.handler).not.toBeNull();
    await act(async () => {
      events.handler!({ payload: ["/card"] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.importPaths).toHaveBeenCalledWith(["/card"]);
    expect(handlers.onNotice).toHaveBeenCalledWith("已发现 7 个视频，新增 7 项");
  });

  it("导入失败广播 onError,空 drop 只清高亮", async () => {
    apiMock.importPaths.mockRejectedValue(new Error("移动硬盘已断开"));
    const handlers = { onError: vi.fn() };
    const { result } = renderHook(() => useGlobalDrop(handlers));
    await act(async () => { await Promise.resolve(); });
    act(() => webview.dropHandler!({ payload: { type: "over" } }));
    expect(result.current).toBe(true);
    await act(async () => {
      webview.dropHandler!({ payload: { type: "drop", paths: [] } });
      await Promise.resolve();
    });
    expect(apiMock.importPaths).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
    await act(async () => {
      webview.dropHandler!({ payload: { type: "drop", paths: ["/a/1.mp4"] } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(handlers.onError.mock.calls[0][0]).toContain("移动硬盘已断开");
  });

  it("最后一个订阅者卸载后才摘监听", async () => {
    const a = renderHook(() => useGlobalDrop({}));
    const b = renderHook(() => useGlobalDrop({}));
    await act(async () => { await Promise.resolve(); });
    a.unmount();
    expect(webview.unlisten).not.toHaveBeenCalled();
    expect(webview.dropHandler).not.toBeNull();
    b.unmount();
    expect(webview.unlisten).toHaveBeenCalledTimes(1);
    expect(webview.dropHandler).toBeNull();
  });
});

describe("triageConditions(M-10:盘拔了 / iCloud 没下载 / 真没了)", () => {
  it("盘拔了不是错误,带上卷名说「插回去」", async () => {
    const { triageConditions } = await import("./useGlobalDrop");
    const triage = triageConditions([
      { path: "/Volumes/TRIP_2026/a.mp4", state: "ejected", volume: "TRIP_2026" },
      { path: "/Volumes/TRIP_2026/b.mp4", state: "ejected", volume: "TRIP_2026" },
    ]);
    expect(triage.importable).toEqual([]);
    expect(triage.cloudOnly).toEqual([]);
    expect(triage.message).toBe("「TRIP_2026」这块盘现在不在,插回去再试一次。");
    expect(triage.tone).toBe("neutral");
  });

  it("iCloud 只有占位的那几条报出来,能下载的路径单列", async () => {
    const { triageConditions } = await import("./useGlobalDrop");
    const triage = triageConditions([
      { path: "/i/a.mp4", state: "cloud_only", volume: null },
      { path: "/i/b.mp4", state: "cloud_only", volume: null },
      { path: "/i/c.mp4", state: "ok", volume: null },
    ]);
    expect(triage.importable).toEqual(["/i/c.mp4"]);
    expect(triage.cloudOnly).toEqual(["/i/a.mp4", "/i/b.mp4"]);
    expect(triage.message).toBe("有 2 条在 iCloud 里没下载到本机,其余 1 条已开始导入。");
  });

  it("全都在本机时一句话都不说", async () => {
    const { triageConditions } = await import("./useGlobalDrop");
    const triage = triageConditions([{ path: "/i/c.mp4", state: "ok", volume: null }]);
    expect(triage.importable).toEqual(["/i/c.mp4"]);
    expect(triage.message).toBeNull();
  });

  it("真没了的那几条说「找不到」,不冒充盘拔了", async () => {
    const { triageConditions } = await import("./useGlobalDrop");
    const triage = triageConditions([{ path: "/i/x.mp4", state: "gone", volume: null }]);
    expect(triage.importable).toEqual([]);
    expect(triage.message).toBe("有 1 条找不到了(可能被删了或改了名)。");
    expect(triage.tone).toBe("danger");
  });

  it("后端答非所问(条数对不上)时照原样导入——不能因为体检没做成就不干活", async () => {
    const { triageConditions } = await import("./useGlobalDrop");
    const triage = triageConditions([], ["/a/1.mp4", "/a/2.mp4"]);
    expect(triage.importable).toEqual(["/a/1.mp4", "/a/2.mp4"]);
    expect(triage.message).toBeNull();
  });
});
