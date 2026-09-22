// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSegmentDetails } from "./SegmentDetails";
import type { BandSegment } from "../shotBandModel";
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("shows original file and exact in/out only after 300ms, and cancels on leave", () => {
  vi.useFakeTimers();
  const segment = { kind: "clip", key: "segment:1", fileName: "camera-original.MP4", inTicks: 1250, outTicks: 4560, tbNum: 1, tbDen: 1000 } as BandSegment;
  function Probe() { const details = useSegmentDetails(segment); return <div data-testid="tile" {...details.handlers}>{details.tooltip}</div>; }
  render(<Probe />);
  fireEvent.mouseEnter(screen.getByTestId("tile"));
  act(() => vi.advanceTimersByTime(299)); expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => vi.advanceTimersByTime(1)); expect(screen.getByRole("tooltip").textContent).toContain("camera-original.MP4");
  expect(screen.getByRole("tooltip").textContent).toContain("00:00:01.250");
  expect(screen.getByRole("tooltip").textContent).toContain("00:00:04.560");
  fireEvent.mouseLeave(screen.getByTestId("tile")); expect(screen.queryByRole("tooltip")).toBeNull();
});
