// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useFocusTrap } from "./useFocusTrap";

function TrapHarness({ active }: { active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, active);
  return (
    <div>
      <button type="button" data-testid="outside">outside</button>
      <div ref={containerRef} tabIndex={-1} data-testid="trap">
        <button type="button" data-testid="first">first</button>
        <button type="button" data-testid="second">second</button>
        <button type="button" data-testid="last">last</button>
      </div>
    </div>
  );
}

describe("useFocusTrap", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("focuses the first focusable descendant on activate", async () => {
    await act(async () => {
      root.render(<TrapHarness active={true} />);
    });
    expect(document.activeElement).toBe(container.querySelector('[data-testid="first"]'));
  });

  it("cycles forward with Tab from the last element back to the first", async () => {
    await act(async () => {
      root.render(<TrapHarness active={true} />);
    });
    const trap = container.querySelector('[data-testid="trap"]') as HTMLElement;
    const last = container.querySelector('[data-testid="last"]') as HTMLElement;
    const first = container.querySelector('[data-testid="first"]') as HTMLElement;
    act(() => last.focus());

    act(() => {
      trap.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });

    expect(document.activeElement).toBe(first);
  });

  it("cycles backward with Shift+Tab from the first element to the last", async () => {
    await act(async () => {
      root.render(<TrapHarness active={true} />);
    });
    const trap = container.querySelector('[data-testid="trap"]') as HTMLElement;
    const last = container.querySelector('[data-testid="last"]') as HTMLElement;
    const first = container.querySelector('[data-testid="first"]') as HTMLElement;
    act(() => first.focus());

    act(() => {
      trap.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the previously focused element on deactivate", async () => {
    const outsideButton = document.createElement("button");
    document.body.append(outsideButton);
    outsideButton.focus();

    await act(async () => {
      root.render(<TrapHarness active={true} />);
    });
    expect(document.activeElement).not.toBe(outsideButton);

    await act(async () => {
      root.render(<TrapHarness active={false} />);
    });

    expect(document.activeElement).toBe(outsideButton);
    outsideButton.remove();
  });

  it("does nothing when inactive", async () => {
    await act(async () => {
      root.render(<TrapHarness active={false} />);
    });
    expect(document.activeElement).not.toBe(container.querySelector('[data-testid="first"]'));
  });
});
