// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetModalStackForTests, isPlayerOccluded } from "../modalStack";
import { Guide, placeBubble } from "./Guide";

afterEach(() => {
  cleanup();
  __resetModalStackForTests();
  vi.useRealTimers();
  document.body.innerHTML = "";
});


type Rect = { left: number; top: number; width: number; height: number };

/** jsdom 没有布局:把元素的矩形钉死,气泡几何才算得出来。 */
function stubRect(element: HTMLElement, rect: Rect): void {
  element.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => rect }) as DOMRect;
  Object.defineProperty(element, "offsetWidth", { value: rect.width, configurable: true });
  Object.defineProperty(element, "offsetHeight", { value: rect.height, configurable: true });
}

/** 监视器里 mpv 的画面节点(PlayerOverlay 的 .player-native-slot)。 */
function mountVideoSlot(rect: Rect): HTMLDivElement {
  const slot = document.createElement("div");
  slot.className = "player-native-slot";
  stubRect(slot, rect);
  document.body.append(slot);
  return slot;
}

/** R13 §3:功能气泡 —— role=dialog「新手引导」,一段话 + 「知道了」+ 可选「试试」,锚到目标元素。 */
describe("Guide 气泡", () => {
  it("锚点在:dialog「新手引导」、一段话、「知道了」调 onDismiss;没有 aria-modal(不抢焦点)", () => {
    const target = document.createElement("nav");
    target.className = "pipeline-rail";
    document.body.append(target);
    const onDismiss = vi.fn();
    render(<Guide anchor="nav.pipeline-rail" text="这一条就是流程。" side="bottom" onDismiss={onDismiss} />);
    const dialog = screen.getByRole("dialog", { name: "新手引导" });
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(dialog.textContent).toContain("这一条就是流程。");
    expect(dialog.dataset.side).toBe("bottom");
    expect(screen.queryByRole("button", { name: /试试/ })).toBeNull();
    screen.getByRole("button", { name: "知道了" }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("带「试试」:点它先 onTry 再 onDismiss(试过就算看过)", () => {
    const target = document.createElement("button");
    target.setAttribute("data-guide", "autoselect");
    document.body.append(target);
    const onDismiss = vi.fn();
    const onTry = vi.fn();
    render(<Guide anchor='[data-guide="autoselect"]' text="点「自动挑选」。" side="top" tryLabel="试试自动挑选" onTry={onTry} onDismiss={onDismiss} />);
    screen.getByRole("button", { name: "试试自动挑选" }).click();
    expect(onTry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("锚点可以是 ref", () => {
    const node = document.createElement("div");
    document.body.append(node);
    render(<Guide anchor={{ current: node }} text="锚到 ref。" side="top" onDismiss={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "新手引导" })).toBeTruthy();
  });

  it("锚点不在:什么都不画;超过等待时限调 onAnchorMissing(让位给下一个,不算看过)", () => {
    vi.useFakeTimers();
    const onAnchorMissing = vi.fn();
    render(<Guide anchor=".nowhere" text="找不到锚。" side="top" onDismiss={() => undefined} onAnchorMissing={onAnchorMissing} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(onAnchorMissing).toHaveBeenCalledTimes(1);
  });

  it("锚点晚一拍出现也能接上", () => {
    vi.useFakeTimers();
    render(<Guide anchor=".late" text="晚到的锚。" side="top" onDismiss={() => undefined} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    const node = document.createElement("div");
    node.className = "late";
    document.body.append(node);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole("dialog", { name: "新手引导" })).toBeTruthy();
  });

  it("Y-02:气泡画出来时向播放器登记遮挡(原生视频层不再盖住它);锚点不在或卸载后解除", () => {
    // 2026-09-19 frozen-video:遮挡只在气泡真的压到原生画面矩形时才登记(见下一组用例);
    // 这里给一个与画面重叠的锚点,保住原断言。
    const { unmount } = render(<Guide anchor="nav.pipeline-rail" text="x" side="bottom" onDismiss={() => undefined} />);
    expect(isPlayerOccluded()).toBe(false);
    unmount();
    mountVideoSlot({ left: 0, top: 0, width: 1000, height: 800 });
    const target = document.createElement("nav");
    target.className = "pipeline-rail";
    stubRect(target, { left: 400, top: 300, width: 200, height: 40 });
    document.body.append(target);
    const shown = render(<Guide anchor="nav.pipeline-rail" text="x" side="bottom" onDismiss={() => undefined} />);
    expect(isPlayerOccluded()).toBe(true);
    shown.unmount();
    expect(isPlayerOccluded()).toBe(false);
  });
});

/**
 * 2026-09-19 frozen-video(业主报「画面不动只有声音」):气泡一出现就把原生 mpv 视图整块藏起来,
 * 监视器只剩井底封面而 mpv 照常放音 —— 九条新手引导里多数锚在导航条 / 镜头带 / 状态条上,
 * 根本没压到画面。遮挡只在气泡矩形与画面矩形真的相交时登记;放得下就先躲到另一侧。
 */
describe("Guide 气泡与原生画面的遮挡(几何判定)", () => {
  it("气泡不压到画面矩形:不登记遮挡,画面继续动", () => {
    // 画面在中间;锚点在底部镜头带上,气泡贴在它上方,仍在画面下沿之下。
    mountVideoSlot({ left: 300, top: 100, width: 1000, height: 500 });
    const target = document.createElement("div");
    target.className = "band-segment";
    stubRect(target, { left: 400, top: 800, width: 160, height: 90 });
    document.body.append(target);
    render(<Guide anchor=".band-segment" text="片段已经排进镜头带。" side="top" onDismiss={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "新手引导" })).toBeTruthy();
    expect(isPlayerOccluded()).toBe(false);
  });

  it("气泡压到画面矩形、两侧都躲不开:仍登记遮挡(原生层不能盖住气泡)", () => {
    mountVideoSlot({ left: 0, top: 0, width: 1400, height: 900 });
    const target = document.createElement("div");
    target.className = "monitor-heat";
    stubRect(target, { left: 500, top: 450, width: 300, height: 12 });
    document.body.append(target);
    render(<Guide anchor=".monitor-heat" text="这条彩色条是「精彩程度」。" side="top" onDismiss={() => undefined} />);
    expect(isPlayerOccluded()).toBe(true);
  });

  it("没有画面节点(监视器没在放):不登记遮挡", () => {
    const target = document.createElement("div");
    target.className = "workspace-status";
    stubRect(target, { left: 0, top: 900, width: 400, height: 24 });
    document.body.append(target);
    render(<Guide anchor=".workspace-status" text="装模型。" side="top" onDismiss={() => undefined} />);
    expect(isPlayerOccluded()).toBe(false);
  });
});

describe("Guide 气泡压到画面且播放器在放:让位(隐藏、不遮挡),停下来再出", () => {
  it("yieldWhilePlaying 为真且压到画面:dialog 隐藏、不登记遮挡;变假后又出现并登记", () => {
    mountVideoSlot({ left: 0, top: 0, width: 1400, height: 900 });
    const target = document.createElement("nav");
    target.className = "pipeline-rail";
    stubRect(target, { left: 500, top: 40, width: 400, height: 30 });
    document.body.append(target);
    const view = render(<Guide anchor="nav.pipeline-rail" text="流程。" side="bottom" onDismiss={() => undefined} yieldWhilePlaying />);
    expect(screen.queryByRole("dialog", { name: "新手引导" })).toBeNull();
    expect(isPlayerOccluded()).toBe(false);
    view.rerender(<Guide anchor="nav.pipeline-rail" text="流程。" side="bottom" onDismiss={() => undefined} yieldWhilePlaying={false} />);
    expect(screen.getByRole("dialog", { name: "新手引导" })).toBeTruthy();
    expect(isPlayerOccluded()).toBe(true);
  });

  it("yieldWhilePlaying 为真但没压到画面:照常显示、不遮挡", () => {
    mountVideoSlot({ left: 300, top: 100, width: 1000, height: 500 });
    const target = document.createElement("div");
    target.className = "band-segment";
    stubRect(target, { left: 400, top: 800, width: 160, height: 90 });
    document.body.append(target);
    render(<Guide anchor=".band-segment" text="镜块。" side="top" onDismiss={() => undefined} yieldWhilePlaying />);
    expect(screen.getByRole("dialog", { name: "新手引导" })).toBeTruthy();
    expect(isPlayerOccluded()).toBe(false);
  });
});

describe("placeBubble 躲开画面矩形", () => {
  const viewport = { width: 1600, height: 1000 };
  const bubble = { width: 300, height: 100 };

  it("首选侧压到 avoid 而另一侧躲得开:换到另一侧", () => {
    // 锚点(精彩度条)在画面正下方:top 侧会压进画面,bottom 侧在画面之外。
    const anchor = { left: 600, top: 620, width: 300, height: 12 };
    const avoid = { left: 300, top: 100, width: 1000, height: 510 };
    const placed = placeBubble(anchor, "top", viewport, bubble, avoid);
    expect(placed.side).toBe("bottom");
    expect(placed.top).toBe(620 + 12 + 10);
  });

  it("两侧都压到 avoid:保持首选侧(由遮挡登记兜底)", () => {
    const anchor = { left: 600, top: 500, width: 300, height: 12 };
    const avoid = { left: 0, top: 0, width: 1600, height: 1000 };
    expect(placeBubble(anchor, "top", viewport, bubble, avoid).side).toBe("top");
  });

  it("不给 avoid:行为与以前完全一样", () => {
    const anchor = { left: 600, top: 620, width: 300, height: 12 };
    expect(placeBubble(anchor, "top", viewport, bubble)).toEqual(placeBubble(anchor, "top", viewport, bubble, undefined));
    expect(placeBubble(anchor, "top", viewport, bubble).side).toBe("top");
  });
});
