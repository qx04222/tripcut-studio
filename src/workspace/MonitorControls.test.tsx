// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClipListItem, PlayerStatus } from "../api";
import { MonitorControls, formatShortTimecode } from "./MonitorControls";
import { SEEK_THROTTLE_MS, isAtEnd } from "./MonitorSeekBar";

const clip = {
  id: 9,
  file_name: "clip-9.mov",
  fps_num: 30,
  fps_den: 1,
} as unknown as ClipListItem;

const ready: PlayerStatus = {
  phase: "ready",
  clip_id: 9,
  pos: 35.9,
  duration: 36,
  paused: true,
  frame: null,
  error: null,
  seek_samples: 0,
  seek_p50_ms: null,
  seek_p95_ms: null,
  last_seek_ms: null,
};

const R10_CSS = readFileSync(resolve(process.cwd(), "src/styles/workspace/monitor-r10.css"), "utf8");
const WORKSPACE_CSS = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");

function renderControls(overrides: Partial<Parameters<typeof MonitorControls>[0]> = {}) {
  const handlers = {
    onPlayPause: vi.fn(),
    onNudge: vi.fn(),
    onToggleMute: vi.fn(),
    onMarkIn: vi.fn(),
    onMarkOut: vi.fn(),
    onSaveSegment: vi.fn(),
    onRequestImmersive: vi.fn(),
    onSeek: vi.fn(),
  };
  render(
    <MonitorControls
      clip={clip}
      status={ready}
      inPoint={null}
      outPoint={null}
      notice={null}
      saving={false}
      muted={false}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatShortTimecode(U-10)", () => {
  it("分:秒.十分之一秒,分钟两位;满一小时才带小时", () => {
    expect(formatShortTimecode(35.94)).toBe("00:35.9");
    expect(formatShortTimecode(0)).toBe("00:00.0");
    expect(formatShortTimecode(61.05)).toBe("01:01.0");
    expect(formatShortTimecode(3_600 + 65.25)).toBe("1:01:05.2");
    expect(formatShortTimecode(Number.NaN)).toBe("00:00.0");
  });
});

describe("MonitorControls · seek bar(U-09)", () => {
  it("有一根 range 滑杆,AX 名「播放位置」,范围 0..总时长,值跟随状态", () => {
    renderControls();
    const slider = screen.getByRole("slider", { name: "播放位置" }) as HTMLInputElement;
    expect(slider.tagName).toBe("INPUT");
    expect(slider.type).toBe("range");
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("36");
    expect(Number(slider.value)).toBeCloseTo(35.9, 3);
    expect(slider.disabled).toBe(false);
  });

  it("未 ready 时滑杆禁用,不发 seek", () => {
    const handlers = renderControls({ status: null });
    const slider = screen.getByRole("slider", { name: "播放位置" }) as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    fireEvent.change(slider, { target: { value: "3" } });
    expect(handlers.onSeek).not.toHaveBeenCalled();
  });

  it("拖动中 seek 按 120ms 节流,松手立刻定位到最终值;拖动中显示本地值不被状态拉回", () => {
    vi.useFakeTimers();
    const handlers = renderControls();
    const slider = screen.getByRole("slider", { name: "播放位置" }) as HTMLInputElement;
    fireEvent.pointerDown(slider);
    fireEvent.input(slider, { target: { value: "5" } });
    // 首次立刻发一次(拖起来就有反馈),之后 120ms 内的都合并成最后一次。
    expect(handlers.onSeek).toHaveBeenCalledTimes(1);
    expect(handlers.onSeek).toHaveBeenLastCalledWith(5);
    fireEvent.input(slider, { target: { value: "6" } });
    fireEvent.input(slider, { target: { value: "7" } });
    expect(handlers.onSeek).toHaveBeenCalledTimes(1);
    expect(slider.value).toBe("7");
    act(() => {
      vi.advanceTimersByTime(SEEK_THROTTLE_MS);
    });
    expect(handlers.onSeek).toHaveBeenCalledTimes(2);
    expect(handlers.onSeek).toHaveBeenLastCalledWith(7);
    fireEvent.input(slider, { target: { value: "9" } });
    fireEvent.pointerUp(slider);
    expect(handlers.onSeek).toHaveBeenLastCalledWith(9);
    expect(handlers.onSeek).toHaveBeenCalledTimes(3);
  });

  it("键盘左右(change 事件)直接定位一次", () => {
    const handlers = renderControls();
    const slider = screen.getByRole("slider", { name: "播放位置" });
    fireEvent.change(slider, { target: { value: "10" } });
    expect(handlers.onSeek).toHaveBeenCalledWith(10);
  });

  it("isAtEnd:距尾 ≤ 0.2 秒算播完;未 ready 或零时长不算", () => {
    expect(isAtEnd(ready)).toBe(true);
    expect(isAtEnd({ ...ready, pos: 30 })).toBe(false);
    expect(isAtEnd({ ...ready, pos: 36 })).toBe(true);
    expect(isAtEnd({ ...ready, duration: 0, pos: 0 })).toBe(false);
    expect(isAtEnd({ ...ready, phase: "loading" })).toBe(false);
    expect(isAtEnd(null)).toBe(false);
  });
});

describe("MonitorControls · 最小宽度(U-10)", () => {
  it("时间码用短格式,精确值留在 title;AX 名不变", () => {
    renderControls();
    const current = screen.getByLabelText("当前时间码");
    expect(current.textContent).toBe("00:35.9");
    expect(current.getAttribute("title")).toBe("00:00:35.900");
    const total = screen.getByLabelText("素材总时长");
    expect(total.textContent?.trim()).toBe("/ 00:36.0");
  });

  it("入出点值用短格式,按钮 title 保留精确时码", () => {
    renderControls({ inPoint: 5.066, outPoint: 6.066 });
    const inButton = screen.getByRole("button", { name: "入点" });
    expect(inButton.querySelector(".monitor-mark-value")!.textContent).toBe("00:05.0");
    expect(inButton.getAttribute("title")).toBe("入点 00:00:05.066");
    expect(screen.getByRole("button", { name: "出点" }).querySelector(".monitor-mark-value")!.textContent).toBe("00:06.0");
  });

  it("结构:时间码与滑杆在自己的一行(monitor-seek),工具条最后一项永远是「全屏 ⌘⏎」", () => {
    renderControls({ inPoint: 5, outPoint: 6, notice: "已设置出点" });
    const seekRow = document.querySelector(".monitor-controls > .monitor-seek")!;
    expect(seekRow).not.toBeNull();
    expect(seekRow.querySelector(".monitor-timecode")).not.toBeNull();
    expect(seekRow.querySelector("input[type=range]")).not.toBeNull();
    const toolbar = screen.getByRole("toolbar", { name: "走带与打点" });
    expect(toolbar.querySelector(".monitor-timecode")).toBeNull();
    const last = toolbar.lastElementChild as HTMLElement;
    expect(last.getAttribute("aria-label")).toBe("全屏沉浸");
    expect(last.textContent).toContain("全屏");
    expect(last.textContent).toContain("⌘⏎");
  });

  it("CSS:520px 容器下藏起变速占位与入出点数值,状态字省略号,全屏按钮不收缩;@import 在 workspace.css 头部", () => {
    expect(WORKSPACE_CSS).toMatch(/^@import "\.\/workspace\/monitor-r10\.css";$/m);
    const firstRule = WORKSPACE_CSS.search(/^[^@/\s][^{]*\{/m);
    expect(WORKSPACE_CSS.indexOf('@import "./workspace/monitor-r10.css"')).toBeLessThan(firstRule);
    expect(R10_CSS).toMatch(/\.monitor-controls\s*\{[^}]*container-type:\s*inline-size/);
    const narrow = R10_CSS.match(/@container[^{]*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/);
    expect(narrow).not.toBeNull();
    expect(Number(narrow![1])).toBeGreaterThanOrEqual(520);
    expect(narrow![2]).toMatch(/\.monitor-speed[^{]*\{[^}]*display:\s*none/);
    expect(narrow![2]).toMatch(/\.monitor-mark-value[^{]*\{[^}]*display:\s*none/);
    expect(R10_CSS).toMatch(/\.monitor-marked\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(R10_CSS).toMatch(/\.monitor-fullscreen\s*\{[^}]*flex:\s*0 0 auto/);
    expect(R10_CSS).toMatch(/\.monitor-timecode\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });
});

describe("四栏焦点环(U-37)", () => {
  it("[data-pane]:focus-visible 画在栏内(负 outline-offset),用强调色,盖过 styles.css 的 !important 偏移", () => {
    const rule = R10_CSS.match(/\.workspace-shell \[data-pane\]:focus-visible\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/outline:\s*[^;]*var\(--accent\)[^;]*!important/);
    expect(rule![1]).toMatch(/outline-offset:\s*calc\(-1 \* var\(--focus-ring-width\)\)\s*!important/);
  });
});
