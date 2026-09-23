import { __resetPlayerPrefsForTests, getPlayerPrefs } from "../playerPrefs";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlayerStatus } from "../../api";
import { Scrubber } from "./Scrubber";
import { EditableTimecode } from "./EditableTimecode";
const status = { phase: "ready", clip_id: 9, pos: 3, duration: 60, paused: true } as PlayerStatus;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("PointerEvent", MouseEvent); localStorage.clear(); __resetPlayerPrefsForTests(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup(extra = {}) {
  const onSeek = vi.fn(); const onPause = vi.fn(async () => {}); const onResume = vi.fn(); const onTrim = vi.fn();
  const view = render(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={onSeek} onPause={onPause} onResume={onResume} onTrim={onTrim} {...extra} />);
  const slider = screen.getByRole("slider", { name: "播放位置" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 600, top: 0, height: 56 } as DOMRect);
  return { ...view, slider, onSeek, onPause, onResume, onTrim };
}
it("draws ticks, playhead and fill without native range; pointer moves only seek on rAF", () => {
  const { slider, onSeek } = setup();
  expect(slider.tagName).toBe("DIV");
  expect(document.querySelector(".scrubber-r22-ticks")).toBeTruthy();
  fireEvent.pointerDown(slider, { clientX: 100 });
  expect(onSeek).toHaveBeenLastCalledWith(10);
  fireEvent.pointerMove(slider, { clientX: 201 });
  fireEvent.pointerMove(slider, { clientX: 302 });
  expect(onSeek).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(20));
  expect(onSeek).toHaveBeenLastCalledWith(30.2);
  fireEvent.pointerUp(slider, { clientX: 303 });
  expect(onSeek).toHaveBeenLastCalledWith(30.32);
});
it("accumulates keyboard/wheel frames without stale status; Home/End respect marks", () => {
  const { slider, onSeek } = setup({ inPoint: 10, outPoint: 20 });
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
  expect(onSeek).toHaveBeenLastCalledWith(3.44);
  fireEvent.wheel(slider, { deltaY: -100 });
  expect(onSeek).toHaveBeenLastCalledWith(3.4);
  fireEvent.keyDown(slider, { key: "Home" }); expect(onSeek).toHaveBeenLastCalledWith(10);
  fireEvent.keyDown(slider, { key: "End" }); expect(onSeek).toHaveBeenLastCalledWith(20);
});
it("pauses a playing clip before seeking and resumes only on release", async () => {
  const { slider, onPause, onSeek, onResume } = setup({ status: { ...status, paused: false } });
  fireEvent.pointerDown(slider, { clientX: 200 });
  expect(onPause).toHaveBeenCalledOnce();
  await act(async () => {});
  expect(onSeek).toHaveBeenCalledWith(20);
  expect(onResume).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider, { clientX: 300 });
  await act(async () => {});
  expect(onSeek).toHaveBeenLastCalledWith(30);
  expect(onResume).toHaveBeenCalledOnce();
});
it("defaults to full and persists zoom via settings; handles clamp", () => {
  const { onTrim } = setup({ inPoint: 10, outPoint: 20 });
  expect(screen.getByRole("button", { name: "切换进度条范围" }).textContent).toBe("完整素材");
  fireEvent.click(screen.getByRole("button", { name: "切换进度条范围" }));
  expect(getPlayerPrefs().scrubberView).toBe("zoom");
  const handle = screen.getByRole("slider", { name: "入点" });
  fireEvent.keyDown(handle, { key: "End" });
  expect(onTrim).toHaveBeenLastCalledWith("in", 19.96);
});
it("timecode edits seek on Enter and cancel on Escape", () => {
  const onSeek = vi.fn();
  render(<EditableTimecode seconds={3} fps={25} duration={60} onSeek={onSeek} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "当前时间码" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "4.12" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(onSeek).toHaveBeenCalledWith(4.48);
  fireEvent.click(screen.getByRole("button", { name: "当前时间码" }));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(onSeek).toHaveBeenCalledOnce();
});
it("never overlaps slow seeks and releases at the last pointer position before resuming", async () => {
  let resolveSeek: (() => void) | undefined;
  const onSeek = vi.fn(() => new Promise<void>(resolve => { resolveSeek = resolve; }));
  const { slider, onResume } = setup({ status: { ...status, paused: false }, onSeek });
  fireEvent.pointerDown(slider, { clientX: 100 });
  await act(async () => {});
  fireEvent.pointerMove(slider, { clientX: 200 });
  act(() => vi.advanceTimersByTime(20));
  fireEvent.pointerUp(slider, { clientX: 300 });
  expect(onSeek).toHaveBeenCalledTimes(1);
  expect(onResume).not.toHaveBeenCalled();
  await act(async () => resolveSeek?.());
  expect(onSeek).toHaveBeenCalledTimes(2);
  expect(onSeek).toHaveBeenLastCalledWith(30);
  await act(async () => resolveSeek?.());
  expect(onResume).toHaveBeenCalledOnce();
});
it("cancels a pending move and late pause on clip change without seeking/resuming another clip", async () => {
  let finishPause: (() => void) | undefined;
  const onPause = vi.fn(() => new Promise<void>(resolve => { finishPause = resolve; }));
  const { slider, rerender, onSeek, onResume } = setup({ status: { ...status, paused: false }, onPause });
  fireEvent.pointerDown(slider, { clientX: 100 });
  fireEvent.pointerMove(slider, { clientX: 200 });
  rerender(<Scrubber status={{ ...status, clip_id: 10, pos: 0 }} fps={25} inPoint={null} outPoint={null} onSeek={onSeek} onResume={onResume} />);
  await act(async () => { finishPause?.(); vi.advanceTimersByTime(50); });
  expect(onSeek).not.toHaveBeenCalled(); expect(onResume).not.toHaveBeenCalled();
  expect(screen.getByRole("slider", { name: "播放位置" }).getAttribute("aria-valuenow")).toBe("0");
});
it("keeps I/O and J/K/L available while the custom slider owns arrow keys", () => {
  const onMark = vi.fn(), onShuttle = vi.fn(); const { slider } = setup({ onMark, onShuttle });
  for (const key of ["i", "o", "j", "k", "l"]) fireEvent.keyDown(slider, { key });
  expect(onMark.mock.calls).toEqual([["in"], ["out"]]);
  expect(onShuttle.mock.calls).toEqual([["j"], ["k"], ["l"]]);
});
it("hover waits 150 ms and hides immediately on leaving", async () => {
  const { slider } = setup();
  fireEvent.pointerMove(slider, { clientX: 100 });
  expect(screen.queryByRole("tooltip")).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(150));
  expect(screen.getByRole("tooltip").textContent).toContain("00:00:10.00");
  fireEvent.pointerLeave(slider);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("rejects invalid/out-of-range editable timecode without issuing seek", () => {
  const onSeek = vi.fn();
  render(<EditableTimecode seconds={3} fps={25} duration={60} onSeek={onSeek} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "当前时间码" }));
  for (const text of ["99.00", "abc", "1.25"]) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
  }
  expect(onSeek).not.toHaveBeenCalled();
});
it("a cancelled rAF cannot block the next drag after reopening the player", () => {
  const { slider, rerender, onSeek } = setup();
  fireEvent.pointerDown(slider, { clientX: 100 });
  fireEvent.pointerMove(slider, { clientX: 200 });
  rerender(<Scrubber status={null} fps={25} inPoint={null} outPoint={null} onSeek={onSeek} />);
  rerender(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={onSeek} />);
  fireEvent.pointerDown(slider, { clientX: 300 });
  fireEvent.pointerMove(slider, { clientX: 400 });
  act(() => vi.advanceTimersByTime(20));
  expect(onSeek).toHaveBeenLastCalledWith(40);
});
it("grabbing the side of an in handle does not move its boundary until the pointer moves", () => {
  localStorage.setItem("tripcut.scrubber.range", "full");
  const { onTrim } = setup({ inPoint: 10, outPoint: 20 });
  const handle = screen.getByRole("slider", { name: "入点" });
  fireEvent.pointerDown(handle, { clientX: 94 });
  expect(onTrim).toHaveBeenLastCalledWith("in", 10);
  fireEvent.pointerMove(handle, { clientX: 104 });
  act(() => vi.advanceTimersByTime(20));
  expect(onTrim).toHaveBeenLastCalledWith("in", 11);
});
it("hides hover outside the track even while pointer capture continues dragging", async () => {
  const { slider } = setup();
  fireEvent.pointerDown(slider, { clientX: 100 });
  await act(async () => vi.advanceTimersByTimeAsync(150));
  expect(screen.getByRole("tooltip")).toBeTruthy();
  fireEvent.pointerMove(slider, { clientX: 700 });
  fireEvent.pointerLeave(slider);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
