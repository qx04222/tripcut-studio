// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLAYER_VIEWPORT_REFRESH_EVENT } from "./usePlayerOcclusion";
import { useStageFit } from "./useStageFit";

/**
 * R22 F-R22-03:传输条长高后井的高度被栏高钉死,检查器滑出 / 收起时井**只平移不变大**。
 * 旧实现只在井的尺寸变了才广播区域矩形重提交,原生 GL 视图就停在旧位置(真机:
 * 收起检查器后画面留在左边、右边露出井的封面底图)。井的位置变了也必须广播。
 */
let observers: Array<{ targets: Element[]; callback: ResizeObserverCallback }> = [];
class FakeResizeObserver {
  targets: Element[] = [];
  constructor(private callback: ResizeObserverCallback) { observers.push({ targets: this.targets, callback }); }
  observe(target: Element) { this.targets.push(target); }
  disconnect() {}
  unobserve() {}
}

function Host() {
  const ref = useStageFit(true);
  return (
    <div className="monitor" style={{ height: 600 }}>
      <div className="ui-section-header" />
      <div className="monitor-stage" ref={ref}>
        <div className="monitor-well" />
      </div>
      <div className="monitor-controls" />
    </div>
  );
}

beforeEach(() => { observers = []; vi.stubGlobal("ResizeObserver", FakeResizeObserver); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("useStageFit · 井只平移也要重提交区域矩形(F-R22-03)", () => {
  it("舞台被观察;井的 left 变了、尺寸没变 → 仍广播 PLAYER_VIEWPORT_REFRESH_EVENT", () => {
    const events = vi.fn();
    window.addEventListener(PLAYER_VIEWPORT_REFRESH_EVENT, events);
    const view = render(<Host />);
    const pane = view.container.querySelector(".monitor") as HTMLElement;
    const stage = view.container.querySelector(".monitor-stage") as HTMLElement;
    const well = view.container.querySelector(".monitor-well") as HTMLElement;
    Object.defineProperty(pane, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(stage, "clientWidth", { value: 800, configurable: true });
    let left = 100;
    well.getBoundingClientRect = () => ({ left, top: 50, width: 800, height: 450, right: left + 800, bottom: 500, x: left, y: 50, toJSON() { return {}; } } as DOMRect);
    const stageObserver = observers.find((o) => o.targets.includes(stage));
    expect(stageObserver, "舞台本身要被 ResizeObserver 观察(检查器滑出只改舞台宽,不改栏根)").toBeTruthy();
    act(() => { stageObserver!.callback([], stageObserver as unknown as ResizeObserver); });
    const before = events.mock.calls.length;
    left = 270;
    act(() => { stageObserver!.callback([], stageObserver as unknown as ResizeObserver); });
    expect(events.mock.calls.length, "井平移后必须再广播一次").toBe(before + 1);
    act(() => { stageObserver!.callback([], stageObserver as unknown as ResizeObserver); });
    expect(events.mock.calls.length, "什么都没变就不广播(不能把防抖饿死)").toBe(before + 1);
    window.removeEventListener(PLAYER_VIEWPORT_REFRESH_EVENT, events);
  });
});
