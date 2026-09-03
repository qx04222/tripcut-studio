import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell, documentTitleForRoute } from "./App";
import tauriConfig from "../src-tauri/tauri.conf.json";

describe("TripCut application shell", () => {
  it("lets the packaged window reach the narrow responsive layout", () => {
    expect(tauriConfig.app.windows[0].minWidth).toBeLessThanOrEqual(940);
  });

  it("renders the four workflow routes and active review view", () => {
    const markup = renderToStaticMarkup(<AppShell route="/review" />);

    expect(markup).toContain("导入");
    expect(markup).toContain("筛片");
    expect(markup).toContain("交付");
    expect(markup).toContain("设置");
    expect(markup).toContain("正在整理你的胶片墙");
    expect(markup).toContain('aria-current="page"');
  });

  it("provides a distinct window title for every view", () => {
    expect([
      documentTitleForRoute("/import"),
      documentTitleForRoute("/review"),
      documentTitleForRoute("/deliver"),
      documentTitleForRoute("/settings"),
    ]).toEqual([
      "导入素材 · 旅剪",
      "筛片工作台 · 旅剪",
      "交付 · 旅剪",
      "设置与帮助 · 旅剪",
    ]);
  });

  it("does not expose an actionable delivery shortcut before delivery items load", () => {
    const markup = renderToStaticMarkup(<AppShell route="/deliver" />);
    expect(markup).toContain("请先收藏整条素材或保存精选片段");
    expect(markup).toContain("disabled=\"\"");
  });
});
