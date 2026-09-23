// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PlayerStatus } from "../api";
const mocks = vi.hoisted(() => ({ playerSetPreviewQuality: vi.fn(async () => {}), setSetting: vi.fn(async () => {}) }));
vi.mock("../api", () => mocks);
import { PreviewSourceBadge } from "./PreviewSourceBadge";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function status(extra: Partial<PlayerStatus> = {}): PlayerStatus {
  return { phase: "ready", clip_id: 1, pos: 0, duration: 10, paused: false, frame: 0, error: null,
    seek_samples: 0, seek_p50_ms: null, seek_p95_ms: null, last_seek_ms: null,
    source_kind: "original", source_width: 3840, source_height: 2160, preview_quality: "auto", dropped_frames: 0, ...extra };
}
it("四种来源文案与自动暂停说明，缺来源不渲染", () => {
  const { rerender } = render(<PreviewSourceBadge status={null} />);
  expect(screen.queryByRole("status", { name: "预览来源" })).toBeNull();
  for (const [extra, label] of [
    [{ source_kind: "proxy", source_width: 960, source_height: 540 }, "代理 540p"],
    [{ source_kind: "proxy_hq", source_width: 1080, source_height: 1920 }, "代理 1080p"],
    [{}, "原片 2160p"], [{ source_width: null, source_height: null }, "原片"],
  ] as [Partial<PlayerStatus>, string][]) {
    rerender(<PreviewSourceBadge status={status(extra)} />);
    expect(screen.getByRole("status", { name: "预览来源" }).textContent).toBe(label);
  }
  // R28:「暂停看原片」只在播放用代理的自动档策略下出现。
  rerender(<PreviewSourceBadge status={status({ paused: true, auto_policy: "proxy" })} />);
  expect(screen.getByText("原片 2160p · 暂停看原片")).toBeTruthy();
  expect(screen.getByRole("status", { name: "预览来源" }).title).toBe("预览画质：自动");
});
it("掉帧警告与改用代理按钮保存并切换，换素材清空", async () => {
  const { rerender } = render(<PreviewSourceBadge status={status({ preview_quality: "original" })} />);
  rerender(<PreviewSourceBadge status={status({ preview_quality: "original", frame: 100, dropped_frames: 10 })} />);
  expect(screen.getByText("原片播放掉帧")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "改用代理播放" }));
  await waitFor(() => expect(mocks.playerSetPreviewQuality).toHaveBeenCalledWith("auto"));
  expect(mocks.setSetting).toHaveBeenCalledWith("performance.preview_quality", "auto");
  rerender(<PreviewSourceBadge status={status({ preview_quality: "original", clip_id: 2, frame: 101, dropped_frames: 11 })} />);
  expect(screen.queryByText("原片播放掉帧")).toBeNull();
});
it("保存失败警告但仍尝试切换", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.setSetting.mockRejectedValueOnce(new Error("无法保存"));
  const { rerender } = render(<PreviewSourceBadge status={status({ preview_quality: "original" })} />);
  rerender(<PreviewSourceBadge status={status({ preview_quality: "original", frame: 100, dropped_frames: 10 })} />);
  fireEvent.click(screen.getByRole("button", { name: "改用代理播放" }));
  await waitFor(() => expect(mocks.playerSetPreviewQuality).toHaveBeenCalledWith("auto"));
  expect(warn).toHaveBeenCalled(); warn.mockRestore();
});
