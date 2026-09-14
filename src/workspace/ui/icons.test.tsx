// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ICON_NAMES, Icon } from "./icons";

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
    // X-03 加 arrow-left / arrow-right(镜块「往前 / 往后」)= 38。
    expect(ICON_NAMES).toContain("arrow-left");
    expect(ICON_NAMES).toContain("arrow-right");
    expect(ICON_NAMES.length).toBe(38);
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
