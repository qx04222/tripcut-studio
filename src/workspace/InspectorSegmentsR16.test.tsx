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
import { PLAYER_STATUS_REFRESH_EVENT } from "../PlayerOverlay";
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

describe("2026-09-19 frozen-video:复播精选段", () => {
  it("seek_abs + play 之后广播状态刷新,监视器的停表能接上(否则时间码 / 播放键停在旧值)", async () => {
    apiMock.listSelectSegments.mockResolvedValue([{ id: 7, clip_id: 3, in_ticks: 3000, out_ticks: 6000, tb_num: 1, tb_den: 600 }]);
    apiMock.playerCommand.mockResolvedValue(undefined);
    const heard = vi.fn();
    window.addEventListener(PLAYER_STATUS_REFRESH_EVENT, heard);
    render(<SelectSegmentsSection clipId={3} selectCount={1} readOnly={false} />);
    await screen.findByRole("list", { name: "精选段列表" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复播精选段 1" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.playerCommand).toHaveBeenCalledWith({ type: "play" }, 3));
    expect(apiMock.playerCommand).toHaveBeenCalledWith({ type: "seek_abs", seconds: 5 }, 3);
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    window.removeEventListener(PLAYER_STATUS_REFRESH_EVENT, heard);
  });

  it("换了素材再按「复播」:命令带的是当前素材的 id,不是首次挂载时那条(R17 起后端按归属拒旧 id,复播就整个哑掉)", async () => {
    apiMock.listSelectSegments.mockResolvedValue([{ id: 7, clip_id: 3, in_ticks: 3000, out_ticks: 6000, tb_num: 1, tb_den: 600 }]);
    apiMock.playerCommand.mockResolvedValue(undefined);
    const view = render(<SelectSegmentsSection clipId={3} selectCount={1} readOnly={false} />);
    await screen.findByRole("list", { name: "精选段列表" });
    apiMock.listSelectSegments.mockResolvedValue([{ id: 9, clip_id: 5, in_ticks: 6005, out_ticks: 9005, tb_num: 1, tb_den: 600 }]);
    view.rerender(<SelectSegmentsSection clipId={5} selectCount={1} readOnly={false} />);
    await waitFor(() => expect(apiMock.listSelectSegments).toHaveBeenLastCalledWith(5));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复播精选段 1" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.playerCommand).toHaveBeenCalledWith({ type: "play" }, 5));
    expect(apiMock.playerCommand).toHaveBeenCalledWith({ type: "seek_abs", seconds: 6005 / 600 }, 5);
    expect(apiMock.playerCommand).not.toHaveBeenCalledWith(expect.anything(), 3);
  });
});
