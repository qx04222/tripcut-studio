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

import { bandTileNameLabel, bandTileTooltip, SegmentCard } from "./BandSegment";
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

/* ---------- R19 V-06:镜块三元素 —— 常显只留封面 + 时长 + 一行名 ---------- */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("V-06 镜块常显名 / tooltip", () => {
  it("bandTileNameLabel 去掉拍摄日期前缀,原名仍在 title 里", () => {
    expect(bandTileNameLabel("20260812_昆明长水机场_到达.MP4")).toBe("昆明长水机场_到达.MP4");
    expect(bandTileNameLabel("2026-08-12_昆明长水机场.MP4")).toBe("昆明长水机场.MP4");
    // 没有日期前缀就原样走 fileNameLines 的断点逻辑,不瞎切。
    expect(bandTileNameLabel("A.MP4")).toBe("A.MP4");
    expect(bandTileNameLabel(null)).toBe("");
  });

  it("bandTileTooltip 把第 n/m 条、AI 生成、槽位、角色拼成一句", () => {
    expect(bandTileTooltip({ ...segment, takeCount: 2, takeIndex: 1, isGenerated: true, roleLabel: "叙事" })).toBe(
      "第 1/2 条 · AI 生成 · 槽位 01 · 叙事",
    );
    expect(bandTileTooltip(segment)).toBe("槽位 01");
  });

  it("常显镜块上,取景 badge / 槽位角色 meta 挪进 title——渲染出的可见文字只剩缩略图、时长与一行名", () => {
    render(
      <SegmentCard
        segment={{ ...segment, takeCount: 2, takeIndex: 1, roleLabel: "叙事" }}
        selected={false}
        dragging={false}
        overSide={null}
        dragDisabled={false}
        onSelect={() => undefined}
        onStep={() => undefined}
      />,
    );
    const tile = screen.getByRole("gridcell", { name: /镜头 1/ });
    const thumb = tile.querySelector(".band-tile-thumb")!;
    // 第 n/m 条 / 角色不再是各自可见的 badge 文案,而是缩略图 title 里的一句话。
    expect(thumb.getAttribute("title")).toBe("第 1/2 条 · 槽位 01 · 叙事");
    expect(tile.querySelector(".band-tile-name")?.textContent).toBe("A.MP4");
  });

  it("band-r19.css 把 band-tile-badges / band-tile-meta 隐藏,且由 workspace.css 头部 @import(尾部会被丢掉)", () => {
    const workspaceCss = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");
    const importLine = workspaceCss.indexOf('@import "./workspace/band-r19.css";');
    const firstRule = workspaceCss.search(/^[.@a-z][^\n]*\{/m);
    expect(importLine).toBeGreaterThan(-1);
    expect(importLine).toBeLessThan(firstRule);
    const bandR19 = readFileSync(resolve(process.cwd(), "src/styles/workspace/band-r19.css"), "utf8");
    expect(bandR19).toMatch(/\.band-tile-badges,\s*\n\.workspace-shell \.shot-band \.band-tile-meta \{\s*\n\s*display: none;/);
  });
});
