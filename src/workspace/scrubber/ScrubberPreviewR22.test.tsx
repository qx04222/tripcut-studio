// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlayerStatus } from "../../api";

vi.mock("../../api", () => ({
  frameAt: vi.fn(async () => "http://127.0.0.1:1421/cache/9/scrub-abcdef0123456789-10000.jpg?expires=1&signature=x"),
  getClipArtifacts: vi.fn(async () => null),
}));
import { Scrubber } from "./Scrubber";

const status = { phase: "ready", clip_id: 9, pos: 3, duration: 60, paused: true } as PlayerStatus;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("PointerEvent", MouseEvent); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * F-R22-02(真机):媒体服务器只给带 Origin 的请求发缓存文件(403 否则),而普通 <img src>
 * 不带 Origin —— 封面走 CoverImage 的 crossOrigin="anonymous" 才拿得到。悬停预览帧的 img
 * 漏了这一条,真机上是一枚碎图标。
 */
it("hover preview img requests the signed frame with crossOrigin=anonymous (media server needs Origin)", async () => {
  render(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={vi.fn()} />);
  const slider = screen.getByRole("slider", { name: "播放位置" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 600, top: 0, height: 56 } as DOMRect);
  fireEvent.pointerMove(slider, { clientX: 100 });
  await act(async () => vi.advanceTimersByTimeAsync(200));
  const img = screen.getByRole("img", { name: "悬停位置预览" }) as HTMLImageElement;
  expect(img.getAttribute("src")).toContain("/cache/9/scrub-");
  expect(img.getAttribute("crossorigin")).toBe("anonymous");
});

/**
 * 真机:安静素材(峰值 ±0.03)的波形按绝对幅度画只有 1px 高,轨道看着是空的。
 * 波形层是「哪里有声音」的示意,按素材自身最大峰值归一化到满高。
 */
it("waveform bars are normalised to the clip's own loudest peak (quiet clips still show a shape)", async () => {
  const api = await import("../../api");
  const quiet = { version: 1, bins: 4, peaks: [[-0.01, 0.01], [-0.03, 0.03], [-0.015, 0.015], [0, 0]] };
  vi.mocked(api.getClipArtifacts).mockResolvedValueOnce({ waveform: `data:application/json,${encodeURIComponent(JSON.stringify(quiet))}` } as never);
  vi.useRealTimers();
  render(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={vi.fn()} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  const rects = Array.from(document.querySelectorAll(".scrubber-r22-wave rect"));
  expect(rects.length).toBe(4);
  const heights = rects.map((r) => Number(r.getAttribute("height")));
  expect(Math.max(...heights)).toBeGreaterThanOrEqual(27);
  expect(heights[0]).toBeCloseTo(heights[1] / 3, 0);
});

/** 规格 §3:悬停 150 ms 后先出时码气泡,缩略帧取到再补上(真机 4K 抽帧 100–250 ms,不能让气泡等帧)。 */
it("tooltip shows the timecode at 150 ms while the frame is still loading, then the frame", async () => {
  const api = await import("../../api");
  let release: (url: string) => void = () => undefined;
  vi.mocked(api.frameAt).mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
  render(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={vi.fn()} />);
  const slider = screen.getByRole("slider", { name: "播放位置" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 600, top: 0, height: 56 } as DOMRect);
  fireEvent.pointerMove(slider, { clientX: 300 });
  await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(screen.getByRole("tooltip").textContent).toContain("00:00:30.00");
  expect(screen.getByRole("tooltip").textContent).toContain("正在取帧");
  await act(async () => { release("http://127.0.0.1:1421/cache/9/scrub-abcdef0123456789-30000.jpg?expires=1&signature=x"); });
  expect(screen.getByRole("img", { name: "悬停位置预览" })).toBeTruthy();
});
