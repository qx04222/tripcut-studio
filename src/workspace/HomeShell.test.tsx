// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { __resetClipsFeedForTests } from "./useClipsFeed";
import { __resetHomeForTests } from "./homeStore";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

const CLIP = {
  id: 1,
  path: "/v/a.mp4",
  file_name: "a.mp4",
  status: "ready",
  analysis_status: "done",
  select_count: 0,
  rating: 0,
  favorite: false,
  cover_url: null,
};

beforeEach(() => {
  __resetWorkspaceForTests();
  __resetHomeForTests();
  __resetClipsFeedForTests();
  vi.clearAllMocks();
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

/** R13 §3:壳里的首页 —— 空库自动盖在三栏上(三栏 inert),有素材时只从 logo 进。 */
describe("首页在壳里", () => {
  it("库空:首页出现,三栏与状态条 inert;顶栏 logo「首页」按下态", async () => {
    render(<WorkspaceShell />);
    const home = await screen.findByRole("region", { name: "首页" });
    expect(home).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始一个新旅程" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".workspace-columns")?.hasAttribute("inert")).toBe(true));
    expect(screen.getByRole("button", { name: "首页" }).getAttribute("aria-pressed")).toBe("true");
    // 首页顶部是四步条;旧的监视器四步卡不再是入口(在 inert 的三栏里)。
    expect(home.querySelector("[aria-label='四步上手']")).not.toBeNull();
    // 第 ① 步的导航条提示在首页上不出(首页自己就是引导)。
    expect(screen.queryByRole("status", { name: "第 1 步提示" })).toBeNull();
  });

  it("有素材:首页不自动出现;点 logo 进首页,再点回工作区", async () => {
    apiMocks.listClips.mockResolvedValue([CLIP] as never);
    render(<WorkspaceShell />);
    await screen.findByRole("gridcell");
    expect(screen.queryByRole("region", { name: "首页" })).toBeNull();
    const logo = screen.getByRole("button", { name: "首页" });
    expect(logo.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      logo.click();
    });
    expect(await screen.findByRole("region", { name: "首页" })).toBeTruthy();
    expect(document.querySelector(".workspace-columns")?.hasAttribute("inert")).toBe(true);
    await act(async () => {
      screen.getByRole("button", { name: "首页" }).click();
    });
    expect(screen.queryByRole("region", { name: "首页" })).toBeNull();
    expect(document.querySelector(".workspace-columns")?.hasAttribute("inert")).toBe(false);
  });

  it("有素材时从首页点「开始一个新旅程」:首页让位、导入抽屉打开", async () => {
    apiMocks.listClips.mockResolvedValue([CLIP] as never);
    render(<WorkspaceShell />);
    await screen.findByRole("gridcell");
    await act(async () => {
      screen.getByRole("button", { name: "首页" }).click();
    });
    await act(async () => {
      (await screen.findByRole("button", { name: "开始一个新旅程" })).click();
    });
    expect(screen.queryByRole("region", { name: "首页" })).toBeNull();
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
