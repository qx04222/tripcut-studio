// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { fitWell, intersectRects, rectToPlayerViewport, visibleSurfaceRect } from "./playerViewport";

describe("intersectRects", () => {
  it("相交取公共部分,不相交宽高为 0", () => {
    expect(intersectRects({ left: 0, top: 0, width: 100, height: 100 }, { left: 50, top: 60, width: 100, height: 100 }))
      .toEqual({ left: 50, top: 60, width: 50, height: 40 });
    expect(intersectRects({ left: 0, top: 0, width: 10, height: 10 }, { left: 20, top: 20, width: 10, height: 10 }).width).toBe(0);
  });
});

describe("visibleSurfaceRect", () => {
  function rect(el: Element, r: { left: number; top: number; width: number; height: number }): void {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => undefined,
    } as DOMRect);
  }

  it("画面越过 overflow:hidden 的舞台时,提交的是被裁后的矩形(R9 D5)", () => {
    document.body.innerHTML = `<div id="pane" style="overflow:auto"><div id="stage" style="overflow:hidden"><div id="well"><div id="surface"></div></div></div></div>`;
    rect(document.getElementById("pane")!, { left: 400, top: 100, width: 1100, height: 600 });
    rect(document.getElementById("stage")!, { left: 420, top: 132, width: 1060, height: 500 });
    rect(document.getElementById("well")!, { left: 440, top: 150, width: 1000, height: 562 });
    rect(document.getElementById("surface")!, { left: 440, top: 150, width: 1000, height: 562 });
    const visible = visibleSurfaceRect(document.getElementById("surface")!, {
      innerWidth: 1600, innerHeight: 1000, getComputedStyle: window.getComputedStyle.bind(window),
    } as unknown as Window);
    // 舞台底在 632,画面本来到 712 —— 只剩 482 高;左右不变。
    expect(visible).toEqual({ left: 440, top: 150, width: 1000, height: 482 });
    expect(rectToPlayerViewport(visible)).toEqual({ x: 440, y: 150, width: 1000, height: 482 });
  });

  it("不裁切的祖先(overflow:visible)不参与;窗口视口永远参与", () => {
    document.body.innerHTML = `<div id="wrap"><div id="surface"></div></div>`;
    rect(document.getElementById("wrap")!, { left: 0, top: 0, width: 10, height: 10 });
    rect(document.getElementById("surface")!, { left: 100, top: 100, width: 2000, height: 2000 });
    const visible = visibleSurfaceRect(document.getElementById("surface")!, {
      innerWidth: 1600, innerHeight: 1000, getComputedStyle: window.getComputedStyle.bind(window),
    } as unknown as Window);
    expect(visible).toEqual({ left: 100, top: 100, width: 1500, height: 900 });
  });

  it("完全被裁掉时矩形无效,不提交", () => {
    document.body.innerHTML = `<div id="stage" style="overflow:hidden"><div id="surface"></div></div>`;
    rect(document.getElementById("stage")!, { left: 0, top: 0, width: 100, height: 100 });
    rect(document.getElementById("surface")!, { left: 0, top: 200, width: 100, height: 100 });
    expect(rectToPlayerViewport(visibleSurfaceRect(document.getElementById("surface")!))).toBeNull();
  });
});

describe("fitWell", () => {
  it("舞台比 16:9 宽时按高定宽,比 16:9 高时按宽定高;从不超出舞台", () => {
    expect(fitWell(1000, 300)).toEqual({ width: 533, height: 300 });
    expect(fitWell(800, 900)).toEqual({ width: 800, height: 450 });
    expect(fitWell(0, 300)).toEqual({ width: 0, height: 0 });
  });
});
