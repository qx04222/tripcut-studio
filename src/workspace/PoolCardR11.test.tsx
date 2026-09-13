// @vitest-environment jsdom
// R11 §1.2 / §3(车道 C):媒体池卡片的悬停刮擦与「有建议段」闪电角标。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getClipArtifacts: vi.fn(),
}));
vi.mock("../api", () => apiMocks);

import type { ClipListItem } from "../api";
import { PoolCard } from "./PoolCard";
import { __resetPoolScrubCacheForTests, scrubFrameIndex, stripFrameCount, stripFrameStyle } from "./poolScrub";

const clip: ClipListItem = {
  id: 7,
  episode_id: 1,
  folder_label: null,
  cover_url: "/covers/7.jpg",
  path: "/Volumes/CARD/clip-7.mov",
  file_name: "clip-7.mov",
  byte_size: 1,
  quick_hash: null,
  full_hash: null,
  tb_num: 1,
  tb_den: 1_000,
  duration_ticks: 30_000,
  fps_num: 30,
  fps_den: 1,
  is_vfr: false,
  codec: "h264",
  width: 1920,
  height: 1080,
  captured_at: null,
  status: "ready",
  error: null,
  analysis: null,
  analysis_status: null,
  analysis_error: null,
  motion: null,
  motion_status: null,
  motion_error: null,
  binary_rating: null,
  star_rating: null,
  select_count: 0,
};

const artifacts = (strip: string | null) => ({
  cover: "/covers/7.jpg",
  strip,
  proxy: null,
  waveform: null,
  statuses: { cover: "ready", strip: strip ? "ready" : "pending", proxy: "pending", waveform: "missing" },
});

function renderCard(item: ClipListItem): HTMLElement {
  render(
    <div role="grid">
      <div role="row">
        <PoolCard clip={item} columnIndex={1} selected={false} isAnchor onSelect={() => undefined} inMultiSelection={false} />
      </div>
    </div>,
  );
  return screen.getByRole("gridcell");
}

function setMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }),
  });
}

beforeEach(() => {
  __resetPoolScrubCacheForTests();
  setMatchMedia(false);
  apiMocks.getClipArtifacts.mockResolvedValue(artifacts("/cache/7/strip.jpg"));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function moveTo(card: HTMLElement, ratio: number): void {
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ left: 100, width: 200, top: 0, height: 100, right: 300, bottom: 100, x: 100, y: 0, toJSON: () => ({}) });
  fireEvent.mouseMove(card, { clientX: 100 + ratio * 200 });
}

describe("poolScrub 纯函数", () => {
  it("帧数与 Rust strip_frame_count 同一条规则;比例 → 帧;帧 → background-position", () => {
    expect(stripFrameCount(clip)).toBe(6);
    expect(stripFrameCount({ ...clip, duration_ticks: 600_000 })).toBe(12);
    expect(stripFrameCount({ ...clip, duration_ticks: null })).toBe(1);
    expect(scrubFrameIndex(0, 6)).toBe(0);
    expect(scrubFrameIndex(0.5, 6)).toBe(3);
    expect(scrubFrameIndex(1, 6)).toBe(5);
    expect(scrubFrameIndex(0.9, 1)).toBe(0);
    expect(stripFrameStyle("/s.jpg", 3, 6)).toEqual({ backgroundImage: "url(/s.jpg)", backgroundPosition: "60% center", backgroundSize: "600% 100%" });
  });
});

describe("R11 §3:悬停刮擦", () => {
  it("进卡片才拿帧条;横向滑过按比例切帧;移开恢复封面;帧条只问一次", async () => {
    const card = renderCard(clip);
    expect(apiMocks.getClipArtifacts).not.toHaveBeenCalled();
    fireEvent.mouseEnter(card);
    await flush();
    expect(apiMocks.getClipArtifacts).toHaveBeenCalledWith(7);
    moveTo(card, 0.5);
    const scrub = await screen.findByTestId("pool-card-scrub");
    expect(scrub.style.backgroundPosition).toBe("60% center");
    moveTo(card, 0.99);
    expect(screen.getByTestId("pool-card-scrub").style.backgroundPosition).toBe("100% center");
    fireEvent.mouseLeave(card);
    expect(screen.queryByTestId("pool-card-scrub")).toBeNull();
    fireEvent.mouseEnter(card);
    await flush();
    expect(apiMocks.getClipArtifacts).toHaveBeenCalledTimes(1);
  });

  it("没有帧条缓存 → 静态封面(不画刮擦层);下次悬停再问一次", async () => {
    apiMocks.getClipArtifacts.mockResolvedValue(artifacts(null));
    const card = renderCard(clip);
    fireEvent.mouseEnter(card);
    await flush();
    moveTo(card, 0.5);
    expect(screen.queryByTestId("pool-card-scrub")).toBeNull();
    fireEvent.mouseLeave(card);
    fireEvent.mouseEnter(card);
    await flush();
    expect(apiMocks.getClipArtifacts).toHaveBeenCalledTimes(2);
  });

  it("prefers-reduced-motion 时整个关掉:不拿帧条、不切帧", async () => {
    setMatchMedia(true);
    const card = renderCard(clip);
    fireEvent.mouseEnter(card);
    await flush();
    moveTo(card, 0.5);
    expect(apiMocks.getClipArtifacts).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pool-card-scrub")).toBeNull();
  });
});

describe("R11 §1.2:「有建议段」角标", () => {
  it("has_suggestions=true 才画右下角闪电;缺省(车道 B 未提供)不画;AX 名不变", () => {
    const withBolt = renderCard({ ...clip, has_suggestions: true });
    expect(withBolt.querySelector(".pool-card-bolt")).not.toBeNull();
    expect(withBolt.getAttribute("aria-label")).toBe("clip-7.mov · 00:30 · 未评");
    cleanup();
    const without = renderCard(clip);
    expect(without.querySelector(".pool-card-bolt")).toBeNull();
  });
});
