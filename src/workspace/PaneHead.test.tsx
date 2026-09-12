// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PaneHead } from "./PaneHead";

const CHROME_CSS = readFileSync(resolve(process.cwd(), "src/styles/workspace/chrome.css"), "utf8");
const LONG_NAME = "dubai_walk_clip__h264_8bit_native_60fps_cfr_032_take_two.mp4"; // 60 字符

afterEach(cleanup);

describe("PaneHead", () => {
  it("长文件名 meta 不把「检查器」标题挤出去:标题与 meta 都在,meta 的 title= 是全名(R9 D3)", () => {
    expect(LONG_NAME).toHaveLength(60);
    render(<PaneHead title="检查器" meta={LONG_NAME} monoMeta />);
    expect(screen.getByText("检查器")).toBeTruthy();
    const meta = screen.getByText(LONG_NAME);
    expect(meta.closest(".ui-section-header-meta")).not.toBeNull();
    expect(meta.closest("[title]")?.getAttribute("title")).toBe(LONG_NAME);
  });

  it("chrome.css 定义了 --workspace-pane-chrome-height(只引用不定义会让条退成 auto 高)", () => {
    expect(CHROME_CSS).toMatch(/--workspace-pane-chrome-height:\s*32px/);
    expect(CHROME_CSS).toMatch(/height:\s*var\(--workspace-pane-chrome-height\)/);
  });

  it("chrome.css:标题 flex:none 不可压缩,meta 可压缩并省略号截断", () => {
    const title = /\.workspace-pane-chrome \.ui-section-header-title\s*\{[^}]*\}/.exec(CHROME_CSS)?.[0] ?? "";
    expect(title).toMatch(/flex:\s*none/);
    const meta = /\.workspace-pane-chrome \.ui-section-header-meta\s*\{[^}]*\}/.exec(CHROME_CSS)?.[0] ?? "";
    expect(meta).toMatch(/flex:\s*0 1 auto/);
    expect(meta).toMatch(/min-width:\s*0/);
    expect(meta).toMatch(/overflow:\s*hidden/);
    expect(meta).toMatch(/text-overflow:\s*ellipsis/);
    expect(meta).toMatch(/white-space:\s*nowrap/);
  });
});
