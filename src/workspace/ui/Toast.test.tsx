// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastHost } from "./Toast";
import { TOAST_MAX_MS, TOAST_MIN_MS, __resetToastsForTests, dismissToast, getToastSnapshot, showToast } from "./toastStore";

/** R12 §3:全应用一条 toast、3–5 秒自动走、至多一个动作、`role=status`。 */
describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetToastsForTests();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("role=status 顶部居中;带一个动作;动作点完 toast 关掉", () => {
    const onClick = vi.fn();
    render(<ToastHost />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      showToast("已挑选 5 段 · 已排进镜头带", { action: { label: "撤销", onClick } });
    });
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("已挑选 5 段 · 已排进镜头带");
    expect(toast.closest(".ui-toast-host")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("最多一条:新来的顶掉旧的;停留时长夹在 3–5 秒;到点自己走", () => {
    render(<ToastHost />);
    act(() => {
      showToast("第一条");
      showToast("第二条", { durationMs: 60_000 });
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("第二条");
    expect(getToastSnapshot()?.durationMs).toBe(TOAST_MAX_MS);
    act(() => {
      showToast("第三条", { durationMs: 10 });
    });
    expect(getToastSnapshot()?.durationMs).toBe(TOAST_MIN_MS);
    act(() => {
      vi.advanceTimersByTime(TOAST_MIN_MS - 1);
    });
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("旧 toast 的计时器不会误关新 toast;关闭键与 Esc 都能关", () => {
    render(<ToastHost />);
    act(() => {
      showToast("旧的", { durationMs: 3_000 });
    });
    act(() => {
      vi.advanceTimersByTime(2_900);
      showToast("新的", { durationMs: 5_000 });
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("status").textContent).toContain("新的");
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      showToast("再来一条", { tone: "danger" });
    });
    expect(screen.getByRole("status").className).toContain("ui-toast--danger");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
    // 带 id 的 dismiss 只关它自己那条。
    act(() => {
      showToast("甲");
    });
    dismissToast(999);
    expect(getToastSnapshot()?.text).toBe("甲");
  });
});
