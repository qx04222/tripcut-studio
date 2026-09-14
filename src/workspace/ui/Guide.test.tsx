// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetModalStackForTests, isPlayerOccluded } from "../modalStack";
import { Guide } from "./Guide";

afterEach(() => {
  cleanup();
  __resetModalStackForTests();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

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
    const { unmount } = render(<Guide anchor="nav.pipeline-rail" text="x" side="bottom" onDismiss={() => undefined} />);
    expect(isPlayerOccluded()).toBe(false);
    unmount();
    const target = document.createElement("nav");
    target.className = "pipeline-rail";
    document.body.append(target);
    const shown = render(<Guide anchor="nav.pipeline-rail" text="x" side="bottom" onDismiss={() => undefined} />);
    expect(isPlayerOccluded()).toBe(true);
    shown.unmount();
    expect(isPlayerOccluded()).toBe(false);
  });
});
