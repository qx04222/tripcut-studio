// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PlayerStatus } from "../api";
const mocks = vi.hoisted(() => ({ playerSetPreviewQuality: vi.fn(async () => {}), setSetting: vi.fn(async () => {}) }));
vi.mock("../api", () => mocks);
import { PreviewSourceBadge } from "./PreviewSourceBadge";
import { __resetModalStackForTests, popOccluder, pushOccluder } from "./modalStack";
afterEach(() => { cleanup(); vi.clearAllMocks(); __resetModalStackForTests(); });
function status(extra: Partial<PlayerStatus> = {}): PlayerStatus {
  return { phase: "ready", clip_id: 1, pos: 0, duration: 10, paused: false, frame: 0, error: null,
    seek_samples: 0, seek_p50_ms: null, seek_p95_ms: null, last_seek_ms: null,
    source_kind: "original", source_width: 3840, source_height: 2160, preview_quality: "auto", auto_policy: "original",
    dropped_frames: 0, ...extra };
}
const badge = () => screen.getByRole("status", { name: "预览来源" }).textContent;
it("R29 自动档退代理:说「原片播放不动」而不是「掉帧」;有 1080p 用 1080p,没有时说明 1080p 正在生成", () => {
  const { rerender } = render(<PreviewSourceBadge status={status({ auto_policy: "degraded", source_kind: "proxy_hq", source_width: 1920, source_height: 1080 })} />);
  expect(badge()).toBe("代理 1080p · 原片播放不动,暂用 1080p 预览");
  rerender(<PreviewSourceBadge status={status({ auto_policy: "degraded", source_kind: "proxy", source_width: 960, source_height: 540 })} />);
  expect(badge()).toBe("代理 540p · 原片播放不动,1080p 预览生成中");
  expect(badge()).not.toContain("掉帧");
});
it("R29 原片档:监视器被覆盖层盖住期间 mpv 记的「掉帧」不算,解除遮挡后不弹「原片播放掉帧」", () => {
  const token = {};
  const { rerender } = render(<PreviewSourceBadge status={status({ preview_quality: "original" })} />);
  pushOccluder(token);
  // 遮挡 4 秒:原生视图不画,mpv 每帧都记掉帧(真机 50p 每秒 50–60 帧)。
  rerender(<PreviewSourceBadge status={status({ preview_quality: "original", frame: 100, dropped_frames: 100 })} />);
  rerender(<PreviewSourceBadge status={status({ preview_quality: "original", frame: 200, dropped_frames: 200 })} />);
  popOccluder(token);
  // 解除遮挡后正常呈现,计数不再涨。
  rerender(<PreviewSourceBadge status={status({ preview_quality: "original", frame: 250, dropped_frames: 200 })} />);
  rerender(<PreviewSourceBadge status={status({ preview_quality: "original", frame: 300, dropped_frames: 200 })} />);
  expect(screen.queryByText("原片播放掉帧")).toBeNull();
});
