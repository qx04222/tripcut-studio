// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlayerStatus } from "../api";
import { PLAYER_STATUS_REFRESH_EVENT } from "../PlayerOverlay";
import { PAUSED_REFRESH_DELAYS_MS, STATUS_REFRESH_EVENT, usePausedSourceRefresh } from "./previewSourceRefresh";

function Probe({ status }: { status: PlayerStatus | null }) { usePausedSourceRefresh(status); return null; }
function status(extra: Partial<PlayerStatus>): PlayerStatus {
  return { phase: "ready", clip_id: 1, pos: 3, duration: 10, paused: true, frame: 0, error: null, seek_samples: 0,
    seek_p50_ms: null, seek_p95_ms: null, last_seek_ms: null, source_kind: "proxy", preview_quality: "auto", ...extra };
}
let events = 0;
const count = () => { events += 1; };
beforeEach(() => { vi.useFakeTimers(); events = 0; window.addEventListener(STATUS_REFRESH_EVENT, count); });
afterEach(() => { cleanup(); vi.useRealTimers(); window.removeEventListener(STATUS_REFRESH_EVENT, count); });

it("与 PlayerOverlay 的刷新事件同名", () => { expect(STATUS_REFRESH_EVENT).toBe(PLAYER_STATUS_REFRESH_EVENT); });
it("自动档暂停在代理上:分三次补读状态(监视器暂停时不轮询)", () => {
  render(<Probe status={status({})} />);
  vi.advanceTimersByTime(PAUSED_REFRESH_DELAYS_MS.at(-1)! + 1);
  expect(events).toBe(PAUSED_REFRESH_DELAYS_MS.length);
});
it("切到原片即停;播放中、其它档位、没有来源信息都不补读", () => {
  const { rerender } = render(<Probe status={status({})} />);
  vi.advanceTimersByTime(PAUSED_REFRESH_DELAYS_MS[0] + 1);
  rerender(<Probe status={status({ source_kind: "original" })} />);
  vi.advanceTimersByTime(5000);
  expect(events).toBe(1);
  for (const extra of [{ paused: false }, { preview_quality: "performance" as const }, { source_kind: null }]) {
    events = 0;
    rerender(<Probe status={status(extra)} />);
    vi.advanceTimersByTime(5000);
    expect(events).toBe(0);
  }
});
