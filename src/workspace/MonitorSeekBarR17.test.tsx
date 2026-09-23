// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerStatus } from "../api";
import { MonitorSeekBar } from "./MonitorSeekBar";

const ready = (clipId: number, pos: number, duration: number): PlayerStatus => ({
  phase: "ready",
  clip_id: clipId,
  pos,
  duration,
  paused: true,
  frame: null,
  error: null,
  seek_samples: 0,
  seek_p50_ms: null,
  seek_p95_ms: null,
  last_seek_ms: null,
});

beforeEach(() => vi.stubGlobal("PointerEvent", MouseEvent));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/**
 * R17 playfix:拖动中的本地值只属于当前这条素材。播放器一离开就绪态(换素材 / 重开)就把它放掉,
 * 否则拇指会停在 A 的 12.3 s 上,B 就绪后进度条还画着上一条停住的位置。
 */
describe("R17 playfix:seek bar 的拖动态不跨素材", () => {
  it("拖 A 到 12.3 s 没等松手就换了素材:B 就绪后进度条按 B 的位置画,不再停在 12.3", () => {
    const onSeek = vi.fn();
    const view = render(<MonitorSeekBar status={ready(9, 3, 60)} inPoint={null} outPoint={null} onSeek={onSeek} />);
    const slider = screen.getByRole("slider", { name: "播放位置" });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 600 } as DOMRect);
    fireEvent.pointerDown(slider, { clientX: 123 });
    expect(slider.getAttribute("aria-valuenow")).toBe("3");
    view.rerender(<MonitorSeekBar status={null} inPoint={null} outPoint={null} onSeek={onSeek} />);
    view.rerender(<MonitorSeekBar status={ready(10, 0, 30)} inPoint={null} outPoint={null} onSeek={onSeek} />);
    expect(screen.getByRole("slider", { name: "播放位置" }).getAttribute("aria-valuenow")).toBe("0");
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(12.3);
  });
});
