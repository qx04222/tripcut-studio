// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const sortable = vi.hoisted(() => ({
  onPointerDown: vi.fn(),
  setActivatorNodeRef: vi.fn(),
}));
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { "aria-roledescription": "sortable" },
    listeners: { onPointerDown: sortable.onPointerDown },
    setNodeRef: () => undefined,
    setActivatorNodeRef: sortable.setActivatorNodeRef,
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

import { SegmentCard } from "./BandSegment";
import type { BandSegment } from "./shotBandModel";

const segment: BandSegment = {
  key: "whole:1",
  kind: "clip",
  index: 1,
  clipId: 1,
  segmentId: null,
  chapterId: 1,
  slot: null,
  fileName: "A.MP4",
  inTicks: 0,
  outTicks: 4_000,
  durationTicks: 4_000,
  tbNum: 1,
  tbDen: 1_000,
  takeCount: 1,
  takeIndex: 1,
  isGenerated: false,
  coverUrl: null,
  gap: null,
  slotIndex: 1,
  roleLabel: null,
  rangeLabel: null,
};

afterEach(() => {
  cleanup();
  sortable.onPointerDown.mockClear();
});

/** Y-07(0.7.0 真机):按住镜块本体拖 = 页面选字,只有 ⠿ 把手能拖;引导和手册都说「拖动镜块」。 */
describe("SegmentCard 拖动手柄", () => {
  it("dnd 的指针监听挂在镜块根上:按在缩略图 / 文件名上也能起拖;⠿ 仍是可见把手且同样能拖", () => {
    render(<SegmentCard segment={segment} selected={false} dragging={false} overSide={null} dragDisabled={false} onSelect={() => undefined} onStep={() => undefined} />);
    const tile = screen.getByRole("gridcell", { name: "镜头 1：A.MP4" });
    fireEvent.pointerDown(tile.querySelector(".band-tile-name")!);
    expect(sortable.onPointerDown).toHaveBeenCalledTimes(1);
    const grip = screen.getByRole("button", { name: "拖动 镜头 1：A.MP4" });
    fireEvent.pointerDown(grip);
    expect(sortable.onPointerDown).toHaveBeenCalledTimes(2);
    // dnd 的 aria 属性(role=button 等)不能落到 gridcell 根上,只给把手。
    expect(tile.getAttribute("aria-roledescription")).toBeNull();
    expect(grip.getAttribute("aria-roledescription")).toBe("sortable");
    // 整块作为手柄后,拖动时不能变成选字:根上声明 user-select none 的钩子 class。
    expect(tile.className).toContain("band-segment--draggable");
  });

  it("拖动禁用(只读 / 忙)时根上不挂指针监听,把手禁用", () => {
    render(<SegmentCard segment={segment} selected={false} dragging={false} overSide={null} dragDisabled onSelect={() => undefined} onStep={() => undefined} />);
    const tile = screen.getByRole("gridcell", { name: "镜头 1：A.MP4" });
    fireEvent.pointerDown(tile.querySelector(".band-tile-name")!);
    expect(sortable.onPointerDown).not.toHaveBeenCalled();
    expect(tile.className).not.toContain("band-segment--draggable");
    expect((screen.getByRole("button", { name: "拖动 镜头 1：A.MP4" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
