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
  // R23 §8C:连播中轨道的刻度范围就是活动选段(monitorRange == activeSegment),
  // 所以这条带铺满整条轨。旧断言(10% / 20%)量的是「段在整条素材里的位置」——
  // 那个刻度正是 ISSUE-B 里指针被 clamp 在边缘的来源。
  expect(band!.style.left).toBe("0%");
  expect(band!.style.width).toMatch(/^calc\((100% - 0%|100%)\)$/);
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
  // R23 §8C:轨道此刻代表的是 6→18 这一段,点正中 = 12 s(不再是整条素材的 30 s)。
  expect(onSeek).toHaveBeenCalledWith(12);
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
