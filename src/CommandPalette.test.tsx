// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  listClips: vi.fn().mockResolvedValue([]),
  searchEverything: vi.fn().mockResolvedValue([]),
}));
vi.mock("./api", () => apiMock);

import { CommandPalette } from "./CommandPalette";

describe("CommandPalette", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("opens from the visible header button event", async () => {
    await act(async () => {
      root.render(<CommandPalette onNavigate={() => undefined} onSelectClip={() => undefined} />);
    });
    expect(container.textContent).toBe("");

    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("01 · 导入素材");
    expect(container.querySelector("input")?.getAttribute("placeholder")).toContain("全量搜索");
  });
});
