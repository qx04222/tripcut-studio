// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import { SEGMENT_DELETED_TOAST } from "./copy";
import { SelectSegmentsSection } from "./InspectorSegments";
import { ToastHost } from "./ui/Toast";
import { __resetToastsForTests, getToastSnapshot } from "./ui/toastStore";
import { __resetUndoForTests, canUndo, runUndo } from "./undoStack";

const seg = (id: number) => ({ id, clip_id: 3, in_ticks: 0, out_ticks: 1000, tb_num: 1, tb_den: 1000 });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  __resetToastsForTests();
  __resetUndoForTests();
});
afterEach(cleanup);

describe("R16 P1-2:删精选段可撤销", () => {
  it("删掉后 toast「已删除精选段 · 撤销」;点撤销调 restore_select_segment 并重取;⌘Z 栈里那条随之消失", async () => {
    apiMock.listSelectSegments.mockResolvedValue([seg(7), seg(8)]);
    render(
      <>
        <SelectSegmentsSection clipId={3} selectCount={2} readOnly={false} />
        <ToastHost />
      </>,
    );
    await screen.findByRole("list", { name: "精选段列表" });
    apiMock.listSelectSegments.mockResolvedValue([seg(8)]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "删除精选段 1" }));
    });
    await waitFor(() => expect(apiMock.deleteSelectSegment).toHaveBeenCalledWith(7));
    expect(getToastSnapshot()?.text).toBe(SEGMENT_DELETED_TOAST);
    expect(canUndo()).toBe(true);
    expect(screen.queryByText("已删除精选段", { selector: ".inspector-notice" })).toBeNull();

    apiMock.listSelectSegments.mockResolvedValue([seg(7), seg(8)]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.restoreSelectSegment).toHaveBeenCalledWith(7));
    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(2));
    expect(canUndo()).toBe(false);
    expect(await runUndo()).toBeNull();
  });

  it("不点 toast 直接 ⌘Z(栈顶)也能恢复", async () => {
    apiMock.listSelectSegments.mockResolvedValue([seg(7)]);
    render(<SelectSegmentsSection clipId={3} selectCount={1} readOnly={false} />);
    await screen.findByRole("list", { name: "精选段列表" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "删除精选段 1" }));
    });
    await waitFor(() => expect(apiMock.deleteSelectSegment).toHaveBeenCalledWith(7));
    await act(async () => {
      expect((await runUndo())?.label).toBe("删除精选段");
    });
    expect(apiMock.restoreSelectSegment).toHaveBeenCalledWith(7);
  });
});
