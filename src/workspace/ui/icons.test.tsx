// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ICON_NAMES, Icon, STROKE_BY_SIZE, type IconSize } from "./icons";

afterEach(cleanup);

const REQUIRED = ["import","deliver","settings","search","play","pause","prev","next","volume","volume-off","fullscreen","mark-in","mark-out","save","star","heart","x","check","chevron-down","chevron-right","grip","plus","close","info","warning"] as const;

describe("icons", () => {
  it("任务书的 24 个图标名都在(volume-off 是 volume 的配对态,算一对)", () => {
    for (const name of REQUIRED) expect(ICON_NAMES).toContain(name);
  });
  it("设置九分区 + R13「快捷键」各有一个图标", () => {
    for (const s of ["appearance", "performance", "timeline", "tools", "analysis", "generation", "privacy", "about", "cache", "keymap"]) {
      expect(ICON_NAMES).toContain(`settings-${s}`);
    }
    // 任务书数 33 = 24(volume/volume-off 算一对)+ 9;按名字数是 25 + 9 = 34,R9 加 film = 35,R13 加 settings-keymap = 36,
    // X-03 加 arrow-left / arrow-right(镜块「往前 / 往后」)= 38;R15 加 more(「···」集操作菜单)= 39。
    expect(ICON_NAMES).toContain("arrow-left");
    expect(ICON_NAMES).toContain("arrow-right");
    expect(ICON_NAMES).toContain("more");
    // R18 加 tag / similar / takes / slot(消灭检查器里四处「借用」)= 43。
    for (const n of ["tag", "similar", "takes", "slot"]) expect(ICON_NAMES).toContain(n);
    expect(ICON_NAMES.length).toBe(43);
  });
  it("每个图标 16px 视窗、1.5 描边、currentColor、aria-hidden", () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("viewBox"), name).toBe("0 0 16 16");
      expect(svg.getAttribute("width")).toBe("16");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("stroke-width")).toBe("1.5");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("focusable")).toBe("false");
      expect(svg.children.length, `${name} 没有路径`).toBeGreaterThan(0);
      unmount();
    }
  });
  // V-10:描边按尺寸补偿(12 发虚 / 32 发胖)。四档各断言一次。
  it("四档尺寸各自的描边宽度来自 STROKE_BY_SIZE", () => {
    expect(STROKE_BY_SIZE).toEqual({ 12: 1.75, 16: 1.5, 20: 1.4, 32: 0.95 });
    for (const size of [12, 16, 20, 32] as IconSize[]) {
      const { container, unmount } = render(<Icon name="import" size={size} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("stroke-width"), `size=${size}`).toBe(String(STROKE_BY_SIZE[size]));
      // 渲染后的实际描边宽度 = 描边 × size / 16,四档应落在 1.3–1.9 px 之间
      const rendered = (STROKE_BY_SIZE[size] * size) / 16;
      expect(rendered).toBeGreaterThanOrEqual(1.3);
      expect(rendered).toBeLessThanOrEqual(1.9);
      unmount();
    }
  });

  it("size 落到 width/height,className 透传", () => {
    const { container } = render(<Icon name="import" size={32} className="x" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
    expect(svg.classList.contains("x")).toBe(true);
  });
  it("filled 的星 / 心用 fill=currentColor", () => {
    const { container } = render(<Icon name="star" filled />);
    expect(container.querySelector("svg")!.getAttribute("fill")).toBe("currentColor");
    const { container: plain } = render(<Icon name="star" />);
    expect(plain.querySelector("svg")!.getAttribute("fill")).toBe("none");
  });
});
