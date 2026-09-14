// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Menu } from "./Menu";

const ITEMS = [
  { id: "a", label: "往前" },
  { id: "b", label: "往后" },
];

/**
 * A16-03(0.8.0 真机):镜块「···」/ 右键菜单落到窗口外(y=1625 > 窗口底 1032)。
 * 根因:`.ui-menu` 是 `position: fixed`,但它挂在 `.ui-card--interactive:hover { transform }`
 * 的镜块里 —— 带 transform 的祖先会成为 fixed 的包含块,视口坐标就被再加了一次卡片偏移。
 * 检测器:菜单必须挂在 body 上(portal),且底/右放不下时向上/向左翻,始终落在视口内。
 */
describe("Menu 几何(A16-03)", () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const size = this.classList.contains("ui-menu") ? { width: 200, height: 160 } : { width: 0, height: 0 };
      return { x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, ...size, toJSON: () => ({}) } as DOMRect;
    });
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true, writable: true });
  });
  afterEach(() => {
    cleanup();
    rectSpy.mockRestore();
  });

  it("挂在 body 上,不在带 transform 的祖先里", () => {
    render(
      <div className="ui-card--interactive" style={{ transform: "translateY(-1px)" }} data-testid="card">
        <Menu items={ITEMS} x={10} y={10} ariaLabel="镜块操作" onSelect={() => {}} onClose={() => {}} />
      </div>,
    );
    const menu = screen.getByRole("menu", { name: "镜块操作" });
    expect(screen.getByTestId("card").contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it("放得下就钉在锚点", () => {
    render(<Menu items={ITEMS} x={100} y={120} ariaLabel="镜块操作" onSelect={() => {}} onClose={() => {}} />);
    const menu = screen.getByRole("menu", { name: "镜块操作" });
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("120px");
  });

  it("底部放不下就向上开;右侧放不下就向左开;都在视口内", () => {
    render(<Menu items={ITEMS} x={750} y={560} ariaLabel="镜块操作" onSelect={() => {}} onClose={() => {}} />);
    const menu = screen.getByRole("menu", { name: "镜块操作" });
    const top = Number.parseFloat(menu.style.top);
    const left = Number.parseFloat(menu.style.left);
    expect(top).toBe(560 - 160);
    expect(left).toBe(750 - 200);
    expect(top + 160).toBeLessThanOrEqual(600);
    expect(left + 200).toBeLessThanOrEqual(800);
  });

  it("上下都放不下就夹到视口里(不为负、不出底)", () => {
    Object.defineProperty(window, "innerHeight", { value: 120, configurable: true, writable: true });
    render(<Menu items={ITEMS} x={0} y={100} ariaLabel="镜块操作" onSelect={() => {}} onClose={() => {}} />);
    const menu = screen.getByRole("menu", { name: "镜块操作" });
    expect(Number.parseFloat(menu.style.top)).toBe(0);
  });
});
