// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlayerStatus } from "../../api";
import { Scrubber } from "./Scrubber";

const status = { phase: "ready", clip_id: 9, pos: 3, duration: 60, paused: true } as PlayerStatus;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("PointerEvent", MouseEvent); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * F-R22-05 真机(WKWebView + 合成 CGEvent 拖动):偶发 pointerup 没送到被捕获的轨道 —— 拖动态卡住:
 * 本地播放头停在最后位置、松手的 seek 一直不发,直到下一次按下时旧捕获被释放才补发一条陈旧 seek。
 * 松手 / 取消事件改在 window 上也听一份:在哪松手都能收尾。
 */
it("a pointerup that lands on window (not the track) still ends the drag with the release seek", () => {
  const onSeek = vi.fn();
  render(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={onSeek} />);
  const slider = screen.getByRole("slider", { name: "播放位置" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 600, top: 0, height: 56 } as DOMRect);
  fireEvent.pointerDown(slider, { clientX: 50 });
  fireEvent.pointerMove(slider, { clientX: 120 });
  act(() => { vi.advanceTimersByTime(20); });
  expect(onSeek).toHaveBeenLastCalledWith(12);
  fireEvent.pointerUp(window, { clientX: 130 });
  expect(onSeek).toHaveBeenLastCalledWith(13);
  // 拖动已结束:再动鼠标不再 seek,播放头回到状态里的位置。
  fireEvent.pointerMove(slider, { clientX: 300 });
  act(() => { vi.advanceTimersByTime(20); });
  expect(onSeek).toHaveBeenCalledTimes(3);
  expect(slider.getAttribute("aria-valuenow")).toBe("3");
});

it("a pointercancel on window ends the drag too, and the window listener is gone afterwards", () => {
  const onSeek = vi.fn();
  render(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={onSeek} />);
  const slider = screen.getByRole("slider", { name: "播放位置" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 600, top: 0, height: 56 } as DOMRect);
  fireEvent.pointerDown(slider, { clientX: 50 });
  fireEvent.pointerCancel(window);
  expect(onSeek).toHaveBeenCalledTimes(2);
  fireEvent.pointerUp(window, { clientX: 400 });
  expect(onSeek).toHaveBeenCalledTimes(2);
});

/** 真机:macOS 把 ⇧ + 滚轮变成横向滚动(deltaX,deltaY=0),十帧一格在真机上一动不动。 */
it("shift+wheel arrives as deltaX on macOS and still steps ten frames", () => {
  const onSeek = vi.fn();
  render(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={onSeek} />);
  const slider = screen.getByRole("slider", { name: "播放位置" });
  fireEvent.wheel(slider, { deltaX: 100, deltaY: 0, shiftKey: true });
  expect(onSeek).toHaveBeenLastCalledWith(3 + 10 / 25);
  fireEvent.wheel(slider, { deltaX: -100, deltaY: 0, shiftKey: true });
  expect(onSeek).toHaveBeenLastCalledWith(3 + 10 / 25 - 10 / 25);
});
