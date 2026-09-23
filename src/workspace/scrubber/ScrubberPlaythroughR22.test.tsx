// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlayerStatus } from "../../api";
import { Scrubber } from "./Scrubber";
import { MonitorControls } from "../MonitorControls";

const status = { phase: "ready", clip_id: 9, pos: 3, duration: 60, paused: false } as PlayerStatus;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("PointerEvent", MouseEvent); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * R22 接线:镜头带连播(R22-B)经 props 把当前段 `{ inPoint, outPoint, index, total }` 交给进度条(R22-A)。
 * 连播中轨道上要看得见「这一段从哪到哪」和「第几段」;不连播时什么都不画。
 */
it("draws the playthrough segment band and n/m label only while a playthrough range is given", () => {
  const { rerender } = render(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={vi.fn()} />);
  expect(document.querySelector("[data-playing]")).toBeNull();
  expect(screen.queryByText(/第 \d+\/\d+ 段/)).toBeNull();

  rerender(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={vi.fn()} playthrough={{ inPoint: 6, outPoint: 18, index: 1, total: 6 }} />);
  const band = document.querySelector<HTMLElement>(".scrubber-r22-track [data-playing]");
  expect(band).toBeTruthy();
  // R25:连播遵守完整素材视图,段 6→18 在 60 秒素材上占 10%→30%。
  expect(band!.style.left).toBe("10%");
  expect(band!.style.width).toMatch(/^calc\((30% - 10%|20%)\)$/);
  expect(screen.getByText("第 2/6 段")).toBeTruthy();
});

it("a drag during playthrough is a plain user seek (onSeek, no source) — the transport turns it into a stop", async () => {
  const onSeek = vi.fn();
  render(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={onSeek} onPause={vi.fn(async () => {})} onResume={vi.fn()}
    playthrough={{ inPoint: 6, outPoint: 18, index: 1, total: 6 }} />);
  const slider = screen.getByRole("slider", { name: "播放位置" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 600, top: 0, height: 56 } as DOMRect);
  fireEvent.pointerDown(slider, { clientX: 300 });
  await act(async () => {});
  // R25 默认完整素材:轨道正中是 30 秒。
  expect(onSeek).toHaveBeenCalledWith(30);
  expect(onSeek.mock.calls[0]).toHaveLength(1);
});

it("MonitorControls passes the playthrough range through to the scrubber", () => {
  const clip = { id: 9, fps_num: 25, fps_den: 1, kind: "video" } as never;
  const noop = () => undefined;
  render(<MonitorControls clip={clip} status={status} inPoint={null} outPoint={null} notice={null} saving={false} muted={false}
    onPlayPause={noop} onNudge={noop} onToggleMute={noop} onMarkIn={noop} onMarkOut={noop} onSaveSegment={noop} onRequestImmersive={noop}
    onSeek={noop} playthrough={{ inPoint: 12, outPoint: 24, index: 4, total: 5 }} />);
  expect(screen.getByText("第 5/5 段")).toBeTruthy();
  expect(document.querySelector(".scrubber-r22-track [data-playing]")).toBeTruthy();
});

it("P-2 stopping keeps old segment position; loading commits the new AX pair; free playback text is unchanged", () => {
  const view = render(<Scrubber status={{ ...status, pos: 12.4 }} fps={25} inPoint={null} outPoint={null} onSeek={vi.fn()}
    playthrough={{ inPoint: 4.5, outPoint: 12.5, index: 0, total: 2, stage: 'stopping', switching: true }} />);
  const slider = screen.getByRole('slider', { name: '播放位置' });
  expect(slider.getAttribute('aria-valuenow')).toBe('12.4');
  expect(slider.getAttribute('aria-valuetext')).toBe('00:00:12.10 · 第 1/2 段');
  view.rerender(<Scrubber status={{ ...status, pos: 12.4 }} fps={25} inPoint={null} outPoint={null} onSeek={vi.fn()}
    playthrough={{ inPoint: 46.5, outPoint: 54.5, index: 1, total: 2, stage: 'loading', switching: true }} />);
  expect(slider.getAttribute('aria-valuenow')).toBe('46.5');
  expect(slider.getAttribute('aria-valuetext')).toBe('00:00:46.12 · 第 2/2 段');
  view.rerender(<Scrubber status={{ ...status, pos: 12.4 }} fps={25} inPoint={null} outPoint={null} onSeek={vi.fn()} />);
  expect(slider.getAttribute('aria-valuetext')).toBe('00:00:12.10');
});
