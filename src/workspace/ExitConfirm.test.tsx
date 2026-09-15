// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  confirmExit: vi.fn(async () => undefined),
  bridgeCloseRequestedEvents: vi.fn(async () => () => undefined),
}));

vi.mock("../api", () => ({ CLOSE_REQUESTED_EVENT: "tripcut:close-requested", ...apiMocks }));

import { CLOSE_REQUESTED_EVENT } from "../api";
import { ExitConfirm } from "./ExitConfirm";

function requestClose(running: number): void {
  window.dispatchEvent(new CustomEvent(CLOSE_REQUESTED_EVENT, { detail: { running } }));
}

describe("ExitConfirm", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("没有关闭请求时什么都不渲染", () => {
    render(<ExitConfirm />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("后台还有任务时说清有几个、退出会发生什么", async () => {
    render(<ExitConfirm />);
    requestClose(3);
    const dialog = await screen.findByRole("alertdialog", { name: "后台任务还没做完" });
    expect(dialog.textContent).toContain("还有 3 个后台任务没做完");
    expect(dialog.textContent).toContain("接着做");
  });

  it("「仍要退出」才调 confirm_exit", async () => {
    render(<ExitConfirm />);
    requestClose(1);
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "仍要退出" }));
    expect(apiMocks.confirmExit).toHaveBeenCalledTimes(1);
  });

  it("「继续等」收掉这张卡,一次都不调 confirm_exit", async () => {
    render(<ExitConfirm />);
    requestClose(2);
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "继续等" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(apiMocks.confirmExit).not.toHaveBeenCalled();
  });

  it("confirm_exit 失败也不把窗口锁死在一张卡后面", async () => {
    apiMocks.confirmExit.mockRejectedValueOnce(new Error("退不掉"));
    render(<ExitConfirm />);
    requestClose(1);
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "仍要退出" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
