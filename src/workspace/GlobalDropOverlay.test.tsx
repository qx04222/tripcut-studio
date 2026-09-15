// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => (await import("./testApiMock")).createTestApiMock({}));
vi.mock("../api", () => apiMock);

const webview = vi.hoisted(() => ({ dropHandler: null as ((e: unknown) => void) | null }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: unknown) => void) => {
      webview.dropHandler = cb;
      return Promise.resolve(() => {
        webview.dropHandler = null;
      });
    },
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));

import { GlobalDropOverlay } from "./GlobalDropOverlay";
import { dispatchWorkspace } from "./WorkspaceStore";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  webview.dropHandler = null;
  dispatchWorkspace({ type: "close-drawer" });
});

describe("GlobalDropOverlay(M-06①:整窗高亮)", () => {
  it("没拖东西时不在 DOM 里;拖入后整窗高亮说「松开即导入」", async () => {
    render(<GlobalDropOverlay />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByLabelText("拖放导入")).toBeNull();
    act(() => webview.dropHandler!({ payload: { type: "enter" } }));
    const overlay = screen.getByLabelText("拖放导入");
    expect(overlay.textContent).toContain("松开即导入");
    act(() => webview.dropHandler!({ payload: { type: "leave" } }));
    expect(screen.queryByLabelText("拖放导入")).toBeNull();
  });

  it("导入抽屉开着时让位给抽屉自己的那层,不叠两个「松开即导入」", async () => {
    render(<GlobalDropOverlay />);
    await act(async () => { await Promise.resolve(); });
    act(() => dispatchWorkspace({ type: "open-drawer", drawer: "import" }));
    act(() => webview.dropHandler!({ payload: { type: "enter" } }));
    expect(screen.queryByLabelText("拖放导入")).toBeNull();
  });
});
