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

describe("visibleSurfaceRect · 沉浸态(Z-17)", () => {
  function rect(el: Element, r: { left: number; top: number; width: number; height: number }): void {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => undefined,
    } as DOMRect);
  }
  const win = () => ({
    innerWidth: 1512, innerHeight: 945, getComputedStyle: window.getComputedStyle.bind(window),
  } as unknown as Window);

  it("position:fixed 的沉浸层不被监视器栏的 overflow 裁切:画面是整个窗口减控件条", () => {
    document.body.innerHTML = `<div id="pane" style="overflow:hidden"><div id="stage" style="overflow:hidden"><div id="overlay" style="position:fixed"><div id="surface"></div></div></div></div>`;
    rect(document.getElementById("pane")!, { left: 430, top: 200, width: 650, height: 520 });
    rect(document.getElementById("stage")!, { left: 430, top: 200, width: 650, height: 520 });
    rect(document.getElementById("overlay")!, { left: 0, top: 0, width: 1512, height: 945 });
    rect(document.getElementById("surface")!, { left: 0, top: 0, width: 1512, height: 869 });
    expect(visibleSurfaceRect(document.getElementById("surface")!, win()))
      .toEqual({ left: 0, top: 0, width: 1512, height: 869 });
  });

  it("fixed 层自己的 overflow:hidden 仍然裁切画面", () => {
    document.body.innerHTML = `<div id="pane" style="overflow:hidden"><div id="overlay" style="position:fixed;overflow:hidden"><div id="surface"></div></div></div>`;
    rect(document.getElementById("pane")!, { left: 430, top: 200, width: 650, height: 520 });
    rect(document.getElementById("overlay")!, { left: 0, top: 0, width: 1512, height: 900 });
    rect(document.getElementById("surface")!, { left: 0, top: 0, width: 1512, height: 945 });
    expect(visibleSurfaceRect(document.getElementById("surface")!, win()))
      .toEqual({ left: 0, top: 0, width: 1512, height: 900 });
  });

  it("带 transform 的祖先是 fixed 的包含块,它和它之上的裁切又算数", () => {
    document.body.innerHTML = `<div id="outer" style="overflow:hidden"><div id="tf" style="transform:translateX(0px);overflow:hidden"><div id="overlay" style="position:fixed"><div id="surface"></div></div></div></div>`;
    rect(document.getElementById("outer")!, { left: 0, top: 0, width: 800, height: 945 });
    rect(document.getElementById("tf")!, { left: 0, top: 0, width: 1000, height: 945 });
    rect(document.getElementById("overlay")!, { left: 0, top: 0, width: 1512, height: 945 });
    rect(document.getElementById("surface")!, { left: 0, top: 0, width: 1512, height: 945 });
    expect(visibleSurfaceRect(document.getElementById("surface")!, win()))
      .toEqual({ left: 0, top: 0, width: 800, height: 945 });
  });
});
