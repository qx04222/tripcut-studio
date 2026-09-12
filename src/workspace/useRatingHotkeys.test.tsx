// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

vi.mock("../api", () => ({
  getImportProgress: vi.fn(async () => ({
    total: 0, done: 0, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false,
  })),
  listMissingClips: vi.fn(async () => []),
  listGenerationRequests: vi.fn(async () => []),
  setSetting: vi.fn(async () => undefined),
}));

import { StatusStrip } from "./StatusStrip";
import {
  ratingHotkeyIntent,
  useRatingHotkeys,
  type RatingHotkeyHandlers,
} from "./useRatingHotkeys";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

const k = (over: Partial<KeyboardEvent>) => ({
  key: "",
  code: "",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...over,
});

beforeEach(() => __resetWorkspaceForTests());
afterEach(cleanup);

describe("ratingHotkeyIntent", () => {
  it("F/X/1–5/0 映射到评级", () => {
    expect(ratingHotkeyIntent(k({ key: "f", code: "KeyF" }), false))
      .toEqual({ kind: "rating", action: { kind: "binary", value: 1 } });
    expect(ratingHotkeyIntent(k({ key: "x", code: "KeyX" }), false))
      .toEqual({ kind: "rating", action: { kind: "binary", value: -1 } });
    expect(ratingHotkeyIntent(k({ key: "3", code: "Digit3" }), false))
      .toEqual({ kind: "rating", action: { kind: "star", value: 3 } });
    expect(ratingHotkeyIntent(k({ key: "0", code: "Digit0" }), false))
      .toEqual({ kind: "rating", action: { kind: "clear" } });
  });

  it("中文输入法把字母吃成 key=Process 时,靠 code 还原物理键", () => {
    expect(ratingHotkeyIntent(k({ key: "Process", code: "KeyF" }), false))
      .toEqual({ kind: "rating", action: { kind: "binary", value: 1 } });
    expect(ratingHotkeyIntent(k({ key: "Process", code: "Digit5" }), false))
      .toEqual({ kind: "rating", action: { kind: "star", value: 5 } });
  });

  it("组合期间单键一律不触发(IME 保护)", () => {
    for (const key of ["f", "x", "1", "0", "l", "r", "Enter", " ", "Tab", "ArrowUp"]) {
      expect(ratingHotkeyIntent(k({ key, code: `Key${key.toUpperCase()}` }), true)).toBeNull();
    }
  });

  it("带 ⌘/Ctrl 的组合键不落进评级(⌘1/⌘2 是折叠栏)", () => {
    expect(ratingHotkeyIntent(k({ key: "1", code: "Digit1", metaKey: true }), false)).toBeNull();
    expect(ratingHotkeyIntent(k({ key: "f", code: "KeyF", ctrlKey: true }), false)).toBeNull();
    // ⌘⏎ 是监视器的全屏沉浸,不能在这里被吃成「提为首选」。
    expect(ratingHotkeyIntent(k({ key: "Enter", code: "Enter", metaKey: true }), false)).toBeNull();
  });

  it("Enter 提为首选,L/R 切锁定与排除,Tab 展开 Take", () => {
    expect(ratingHotkeyIntent(k({ key: "Enter", code: "Enter" }), false))
      .toEqual({ kind: "promote-hero" });
    expect(ratingHotkeyIntent(k({ key: "l", code: "KeyL" }), false))
      .toEqual({ kind: "stack-state", state: "locked" });
    expect(ratingHotkeyIntent(k({ key: "r", code: "KeyR" }), false))
      .toEqual({ kind: "stack-state", state: "rejected" });
    expect(ratingHotkeyIntent(k({ key: "Tab", code: "Tab" }), false))
      .toEqual({ kind: "toggle-takes" });
  });

  it("↑↓ 切 Take,←→ 移选中(按栏),空格播放/暂停", () => {
    expect(ratingHotkeyIntent(k({ key: "ArrowUp", code: "ArrowUp" }), false))
      .toEqual({ kind: "move-take", direction: -1 });
    expect(ratingHotkeyIntent(k({ key: "ArrowDown", code: "ArrowDown" }), false))
      .toEqual({ kind: "move-take", direction: 1 });
    expect(ratingHotkeyIntent(k({ key: "ArrowLeft", code: "ArrowLeft" }), false))
      .toEqual({ kind: "move-selection", direction: -1 });
    expect(ratingHotkeyIntent(k({ key: "ArrowRight", code: "ArrowRight" }), false))
      .toEqual({ kind: "move-selection", direction: 1 });
    expect(ratingHotkeyIntent(k({ key: " ", code: "Space" }), false))
      .toEqual({ kind: "toggle-playback" });
  });

  it("没映射的键返回 null(不吃掉 ⌘F 之外的正常输入)", () => {
    expect(ratingHotkeyIntent(k({ key: "q", code: "KeyQ" }), false)).toBeNull();
    expect(ratingHotkeyIntent(k({ key: "9", code: "Digit9" }), false)).toBeNull();
  });
});

function makeHandlers(): RatingHotkeyHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onRating: (action) => void calls.push(`rating:${JSON.stringify(action)}`),
    onStackState: (state) => void calls.push(`stack:${state}`),
    onPromoteHero: () => void calls.push("hero"),
    onToggleTakes: () => void calls.push("takes"),
    onMoveTake: (direction) => void calls.push(`take:${direction}`),
    onMoveSelection: (direction) => void calls.push(`move:${direction}`),
    onTogglePlayback: () => void calls.push("playback"),
  };
}

function PoolWithHotkeys({ handlers }: { handlers: RatingHotkeyHandlers }): JSX.Element {
  const hotkeys = useRatingHotkeys("pool", handlers);
  return (
    <div>
      {/* 照抄 SelectPage 胶片墙的容器语义(div + role=grid + tabIndex),
          否则 jsx-a11y 会拦下「非交互元素挂键盘监听」。 */}
      <div
        aria-label="媒体池"
        role="grid"
        data-testid="pool"
        tabIndex={0}
        onKeyDown={hotkeys.onKeyDown}
        onCompositionStart={hotkeys.onCompositionStart}
        onCompositionEnd={hotkeys.onCompositionEnd}
      >
        <input type="search" aria-label="搜索素材" />
      </div>
      <StatusStrip />
    </div>
  );
}

describe("useRatingHotkeys", () => {
  it("容器本身拿到键时触发,评级与 Stack 键各走各的回调", () => {
    const handlers = makeHandlers();
    render(<PoolWithHotkeys handlers={handlers} />);
    const pool = screen.getByTestId("pool");
    fireEvent.keyDown(pool, { key: "f", code: "KeyF" });
    fireEvent.keyDown(pool, { key: "l", code: "KeyL" });
    fireEvent.keyDown(pool, { key: " ", code: "Space" });
    expect(handlers.calls).toEqual([
      'rating:{"kind":"binary","value":1}',
      "stack:locked",
      "playback",
    ]);
  });

  it("事件目标是输入框时 hook 不接管(目标判定沿用 isFilmGridShortcutTarget 语义)", () => {
    const handlers = makeHandlers();
    render(<PoolWithHotkeys handlers={handlers} />);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "f", code: "KeyF" });
    expect(handlers.calls).toEqual([]);
  });

  it("焦点不在本栏时不接管(镜头带的键不该被媒体池吃掉)", () => {
    __resetWorkspaceForTests({ focusedPane: "band" });
    const handlers = makeHandlers();
    render(<PoolWithHotkeys handlers={handlers} />);
    fireEvent.keyDown(screen.getByTestId("pool"), { key: "f", code: "KeyF" });
    expect(handlers.calls).toEqual([]);
  });

  it("聚焦本栏时把 focusedPane 记进 store", () => {
    __resetWorkspaceForTests({ focusedPane: "inspector" });
    const handlers = makeHandlers();
    function Focusable(): JSX.Element {
      const hotkeys = useRatingHotkeys("pool", handlers);
      return <div data-testid="pool2" role="grid" tabIndex={0} onFocus={hotkeys.onFocus} />;
    }
    render(<Focusable />);
    fireEvent.focus(screen.getByTestId("pool2"));
    expect(getWorkspaceSnapshot().focusedPane).toBe("pool");
  });

  it("组合中时状态条显示「中文输入法组合中」,组合结束即消失", () => {
    const handlers = makeHandlers();
    render(<PoolWithHotkeys handlers={handlers} />);
    const pool = screen.getByTestId("pool");
    expect(screen.queryByText("中文输入法组合中")).toBeNull();

    fireEvent.compositionStart(pool);
    expect(screen.getByText("中文输入法组合中")).toBeTruthy();
    // 组合期间单键一律不触发。
    fireEvent.keyDown(pool, { key: "Process", code: "KeyF" });
    expect(handlers.calls).toEqual([]);

    fireEvent.compositionEnd(pool);
    expect(screen.queryByText("中文输入法组合中")).toBeNull();
    fireEvent.keyDown(pool, { key: "f", code: "KeyF" });
    expect(handlers.calls).toEqual(['rating:{"kind":"binary","value":1}']);
  });

  it("接管时调 preventDefault,不接管时不碰事件(Tab 仍能正常移焦点)", () => {
    const handlers = makeHandlers();
    render(<PoolWithHotkeys handlers={handlers} />);
    const pool = screen.getByTestId("pool");
    expect(fireEvent.keyDown(pool, { key: "Tab", code: "Tab" })).toBe(false);
    expect(fireEvent.keyDown(pool, { key: "q", code: "KeyQ" })).toBe(true);
  });
});
