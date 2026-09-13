// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CoverImage } from "./CoverImage";

const COVER_CSS = readFileSync(resolve(process.cwd(), "src/styles/workspace/cover.css"), "utf8");

afterEach(cleanup);

describe("CoverImage", () => {
  it("有封面时是 <img alt=''>,不可拖", () => {
    const { container } = render(<CoverImage src="/covers/1.jpg" />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/covers/1.jpg");
    expect(img?.getAttribute("alt")).toBe("");
    expect(container.querySelector(".ui-cover-missing")).toBeNull();
  });

  it("cover_url 为 null / 空串时渲染中性占位(胶片图标),没有 <img>(R9 D4)", () => {
    for (const src of [null, undefined, ""]) {
      const { container, unmount } = render(<CoverImage src={src} />);
      expect(container.querySelector("img")).toBeNull();
      const missing = container.querySelector(".ui-cover-missing");
      expect(missing).not.toBeNull();
      expect(missing!.querySelector("svg")).not.toBeNull();
      unmount();
    }
  });

  it("封面加载失败(分析失败的素材)时换成占位,不留坏图;换一条 URL 后再试", () => {
    const { container, rerender } = render(<CoverImage src="/covers/broken.jpg" />);
    act(() => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".ui-cover-missing")).not.toBeNull();
    rerender(<CoverImage src="/covers/ok.jpg" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/covers/ok.jpg");
  });

  it("自定义 fallback 原样渲染", () => {
    const { getByText } = render(<CoverImage src={null} fallback={<span>等待封面</span>} />);
    expect(getByText("等待封面")).toBeTruthy();
  });

  it("占位铺满容器、居中、深井底(--well-bg)", () => {
    const rule = /\.ui-cover-missing\s*\{[^}]*\}/.exec(COVER_CSS)?.[0] ?? "";
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/height:\s*100%/);
    expect(rule).toMatch(/background:\s*var\(--well-bg\)/);
    expect(rule).toMatch(/justify-content:\s*center/);
  });

  it("R-04:默认带 crossorigin=anonymous —— 媒体服务器没有 Origin 头就回 403,裸 <img> 永远只能拿到占位", () => {
    const { container } = render(<CoverImage src="http://127.0.0.1:9/cache/1/cover.jpg?expires=1&signature=x" />);
    expect(container.querySelector("img")?.getAttribute("crossorigin")).toBe("anonymous");
  });
});
