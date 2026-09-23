// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PlayerStatus } from "../api";
const mocks = vi.hoisted(() => ({ playerSetPreviewQuality: vi.fn(async () => {}), setSetting: vi.fn(async () => {}) }));
vi.mock("../api", () => mocks);
import { PreviewSourceBadge } from "./PreviewSourceBadge";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function status(extra: Partial<PlayerStatus> = {}): PlayerStatus {
  return { phase: "ready", clip_id: 1, pos: 0, duration: 10, paused: false, frame: 0, error: null,
    seek_samples: 0, seek_p50_ms: null, seek_p95_ms: null, last_seek_ms: null,
    source_kind: "original", source_width: 3840, source_height: 2160, preview_quality: "auto", auto_policy: "original",
    dropped_frames: 0, ...extra };
}
const badge = () => screen.getByRole("status", { name: "预览来源" }).textContent;
it("R28 标准机自动档:播放、暂停都是「原片 2160p」,不再写「暂停看原片」", () => {
  const { rerender } = render(<PreviewSourceBadge status={status()} />);
  expect(badge()).toBe("原片 2160p");
  rerender(<PreviewSourceBadge status={status({ paused: true })} />);
  expect(badge()).toBe("原片 2160p");
});
it("R28 掉帧已退代理:角标如实写代理分辨率与原因;暂停回原片", () => {
  const { rerender } = render(<PreviewSourceBadge status={status({ auto_policy: "degraded", source_kind: "proxy_hq", source_width: 1920, source_height: 1080 })} />);
  expect(badge()).toBe("代理 1080p · 原片播放不动,暂用 1080p 预览"); // R29 迁移:文案改为业主看得懂的原因
  rerender(<PreviewSourceBadge status={status({ auto_policy: "degraded", paused: true })} />);
  expect(badge()).toBe("原片 2160p · 暂停看原片");
});
it("R28 自动档由播放器自己退代理,不再弹「原片播放掉帧 / 改用代理播放」", () => {
  const { rerender } = render(<PreviewSourceBadge status={status()} />);
  rerender(<PreviewSourceBadge status={status({ frame: 100, dropped_frames: 10 })} />);
  expect(screen.queryByText("原片播放掉帧")).toBeNull();
  expect(screen.queryByRole("button", { name: "改用代理播放" })).toBeNull();
});
