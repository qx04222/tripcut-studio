// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipListItem, PlayerStatus } from "../api";
import { MonitorControls, formatShortTimecode } from "./MonitorControls";
import { isAtEnd } from "./MonitorSeekBar";

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

beforeEach(() => { vi.stubGlobal("PointerEvent", MouseEvent); localStorage.clear(); });

afterEach(() => {
  vi.unstubAllGlobals();
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
  it("有一根自绘滑杆,AX 名「播放位置」,范围 0..总时长,值跟随状态", () => {
    renderControls();
    const slider = screen.getByRole("slider", { name: "播放位置" }) as HTMLElement;
    expect(slider.tagName).toBe("DIV");
    expect(slider.getAttribute("role")).toBe("slider");
    expect(slider.getAttribute("aria-valuemin")).toBe("0");
    expect(slider.getAttribute("aria-valuemax")).toBe("36");
    expect(Number(slider.getAttribute("aria-valuenow"))).toBeCloseTo(35.9, 3);
    expect(slider.getAttribute("aria-disabled")).toBe("false");
  });

  it("未 ready 时滑杆禁用,不发 seek", () => {
    const handlers = renderControls({ status: null });
    const slider = screen.getByRole("slider", { name: "播放位置" }) as HTMLElement;
    expect(slider.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(handlers.onSeek).not.toHaveBeenCalled();
  });

  it("拖动中 seek 按 rAF 合并,松手立刻定位到最终值;拖动中显示本地值不被状态拉回", () => {
    vi.useFakeTimers();
    const handlers = renderControls();
    const slider = screen.getByRole("slider", { name: "播放位置" }) as HTMLElement;
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 360 } as DOMRect);
    fireEvent.pointerDown(slider, { clientX: 50 });
    // 首次立刻发一次,之后一帧内的移动合并为最新位置。
    expect(handlers.onSeek).toHaveBeenCalledTimes(1);
    expect(handlers.onSeek).toHaveBeenLastCalledWith(5);
    fireEvent.pointerMove(slider, { clientX: 60 });
    fireEvent.pointerMove(slider, { clientX: 70 });
    expect(handlers.onSeek).toHaveBeenCalledTimes(1);
    // rAF 同时刷新本地播放头与 seek,旧状态不会拉回它。
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(handlers.onSeek).toHaveBeenCalledTimes(2);
    expect(slider.getAttribute("aria-valuenow")).toBe("7");
    expect(handlers.onSeek).toHaveBeenLastCalledWith(7);
    fireEvent.pointerMove(slider, { clientX: 90 });
    fireEvent.pointerUp(slider, { clientX: 90 });
    expect(handlers.onSeek).toHaveBeenLastCalledWith(9);
    expect(handlers.onSeek).toHaveBeenCalledTimes(3);
  });

  it("键盘左右直接逐帧定位一次", () => {
    const handlers = renderControls();
    const slider = screen.getByRole("slider", { name: "播放位置" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(handlers.onSeek).toHaveBeenCalledWith(35.9 - 1 / 30);
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
    expect(current.textContent).toBe("00:35.27");
    expect(current.getAttribute("title")).toBe("00:00:35.900");
    const total = screen.getByLabelText("素材总时长");
    // R19 V-05:总时长站在 seek 右端,不再带「/」前缀。
    expect(total.textContent?.trim()).toBe("00:36.0");
  });

  it("入出点值用短格式,按钮 title 保留精确时码", () => {
    renderControls({ inPoint: 5.066, outPoint: 6.066 });
    const inButton = screen.getByRole("button", { name: "入点" });
    expect(inButton.querySelector(".monitor-mark-value")!.textContent).toBe("00:05.0");
    expect(inButton.getAttribute("title")).toBe("入点 00:00:05.066");
    expect(screen.getByRole("button", { name: "出点" }).querySelector(".monitor-mark-value")!.textContent).toBe("00:06.0");
  });

  it("结构:时间码与滑杆成组(monitor-seek,R19 起并进工具条中段),工具条最后一项永远是「全屏 ⌘⏎」", () => {
    renderControls({ inPoint: 5, outPoint: 6, notice: "已设置出点" });
    const toolbar = screen.getByRole("toolbar", { name: "走带与打点" });
    const seekRow = toolbar.querySelector(".monitor-seek")!;
    expect(seekRow).not.toBeNull();
    expect(seekRow.querySelector(".monitor-timecode")).not.toBeNull();
    expect(seekRow.querySelector('[role="slider"]')).not.toBeNull();
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
  it("[data-pane]:focus-visible 画在栏内(负 outline-offset),用强调色——R19 起不再靠 !important 硬压,而是改 styles.css 通用环读的两个变量", () => {
    const rule = R10_CSS.match(/\.workspace-shell \[data-pane\]:focus-visible\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/--focus-ring:\s*var\(--accent\)/);
    expect(rule![1]).toMatch(/--focus-ring-offset:\s*calc\(-1 \* var\(--focus-ring-width\)\)/);
    expect(rule![1]).not.toContain("!important");
    // 通用环必须仍然读这两个变量,否则上面的覆盖是空话。
    const GLOBAL = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const g = GLOBAL.match(/:where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible\s*\{([^}]*)\}/);
    expect(g).not.toBeNull();
    expect(g![1]).toMatch(/outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring\)/);
    expect(g![1]).toMatch(/outline-offset:\s*var\(--focus-ring-offset\)/);
  });
});

describe("R19 shell · V-05 单检视器:传输条并成一行,热力画进 seek 轨", () => {
  const suggestions = {
    points: [{ at: 0, width: 0.5, score: 0.4 }, { at: 0.5, width: 0.5, score: 0.9 }],
    ranges: [{ inSeconds: 1, outSeconds: 4 }, { inSeconds: 6, outSeconds: 9 }],
    index: 0,
    current: { inSeconds: 1, outSeconds: 4 },
    bestStart: 6,
    momentsLoaded: true,
    statusLine: "建议 1/2 · 3.0 s · 清晰·运动适中",
    step: () => null,
  } as unknown as NonNullable<Parameters<typeof MonitorControls>[0]["suggestions"]>;

  it("根节点下直接子元素 ≤ 2:走带 / 时码 + seek / 打点 / 保存 / 建议 / 全屏都在同一条 toolbar 里,最后一项仍是「全屏沉浸」", () => {
    renderControls({ suggestions, inPoint: 1, outPoint: 4, onStepSuggestion: () => undefined });
    const root = document.querySelector(".monitor-controls")!;
    expect(root.children.length).toBeLessThanOrEqual(2);
    const toolbar = screen.getByRole("toolbar", { name: "走带与打点" });
    expect(toolbar.querySelector('.monitor-seek [role="slider"]')).not.toBeNull();
    expect(toolbar.querySelector(".monitor-timecode")).not.toBeNull();
    for (const name of ["播放位置", "入点", "出点", "保存片段", "全屏沉浸"]) {
      expect(toolbar.querySelector(`[aria-label="${name}"]`), name).not.toBeNull();
    }
    expect((toolbar.lastElementChild as HTMLElement).getAttribute("aria-label")).toBe("全屏沉浸");
  });
  it("热力条画在 seek 轨道里(.monitor-seek-track 之内),没有假时码占位行;「按 Enter 采用这段」进 tooltip 不占版面", () => {
    renderControls({ suggestions, inPoint: 1, outPoint: 4, onStepSuggestion: () => undefined });
    expect(document.querySelector(".monitor-heat-row")).toBeNull();
    expect(document.querySelector(".monitor-heat-spacer")).toBeNull();
    const heat = screen.getByRole("img", { name: "时刻热力" });
    expect(heat.closest(".scrubber-r22-track")).not.toBeNull();
    expect(screen.queryByText("按 Enter 采用这段")).toBeNull();
    const suggestion = screen.getByTestId("monitor-suggestion");
    expect(suggestion.textContent).toContain("建议 1/2");
    expect(suggestion.getAttribute("title")).toContain("按 Enter 采用这段");
    expect(suggestion.getAttribute("title")).toContain("清晰·运动适中");
  });
});
