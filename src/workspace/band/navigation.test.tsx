// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { useBandNavigation } from "./useBandNavigation";
import { magneticBand } from "./dragGeometry";
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("ordinary wheel scrolls horizontally; option-wheel anchors the source position and commits once", () => {
  vi.useFakeTimers(); const commit = vi.fn();
  function Probe() {
    const viewport = useRef<HTMLDivElement>(null), [zoom, setZoom] = useState(1);
    const nav = useBandNavigation({ viewport, zoom, setZoom, previewZoom: setZoom, commitZoom: commit,
      spans: [{ key: "a", left: 0, width: 140 * zoom, startMs: 0, durationMs: 10000, inMs: 0, clipId: 1, segmentId: 1 }] });
    return <div role="grid" tabIndex={0} data-testid="band" ref={viewport} data-zoom={zoom} onKeyDown={nav.keyDown} onKeyUp={nav.onKeyUp} />;
  }
  render(<Probe />); const node = screen.getByTestId("band");
  fireEvent.wheel(node, { deltaY: 10 }); expect(node.scrollLeft).toBe(10);
  fireEvent.wheel(node, { deltaY: -20, altKey: true, clientX: 72 });
  expect(node.dataset.zoom).toBe("1.5"); expect(node.scrollLeft).toBeCloseTo(45);
  fireEvent.wheel(node, { deltaY: -20, altKey: true, clientX: 72 });
  expect(node.dataset.zoom).toBe("2"); expect(node.scrollLeft).toBeCloseTo(80);
  act(() => vi.advanceTimersByTime(250)); expect(commit).toHaveBeenCalledTimes(1);
  const toggle = vi.fn(); window.addEventListener("tripcut:toggle-playback", toggle);
  fireEvent.keyDown(node, { key: " ", code: "Space" }); fireEvent.keyUp(node, { key: " ", code: "Space" });
  expect(toggle).toHaveBeenCalledTimes(1); window.removeEventListener("tripcut:toggle-playback", toggle);
});
it("snaps to the adjacent edge within twelve pixels; option disables magnetism", () => {
  const transform = { x: 145, y: 0, scaleX: 1, scaleY: 1 };
  const input = { transform, draggingNodeRect: { left: 0, right: 140 }, over: { rect: { left: 148, right: 288 } } } as Parameters<ReturnType<typeof magneticBand>>[0];
  expect(magneticBand(() => false)(input).x).toBe(148);
  expect(magneticBand(() => true)(input)).toBe(transform);
});
