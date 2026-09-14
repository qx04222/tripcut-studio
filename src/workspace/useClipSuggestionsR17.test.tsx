import { createTestApiMock } from "./testApiMock";
// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";

import { describe, expect, it, vi } from "vitest";

import type { ClipListItem, ClipMoment } from "../api";

const apiMocks = vi.hoisted(() => ({
  getClipMoments: vi.fn(),
  suggestSegments: vi.fn(async () => []),
}));
vi.mock("../api", async () => ({ ...(await createTestApiMock()), ...apiMocks }));

import { useClipSuggestions } from "./useClipSuggestions";

const clipA = { id: 9, tb_num: 1, tb_den: 1_000 } as ClipListItem;
const clipB = { id: 10, tb_num: 1, tb_den: 1_000 } as ClipListItem;

function moment(clipId: number, index: number, score: number): ClipMoment {
  return {
    clip_id: clipId,
    win_index: index,
    t_start_ticks: index * 500,
    t_end_ticks: (index + 1) * 500,
    sharp: score,
    motion: 0.3,
    exposure_ok: true,
    loud: false,
    speech: false,
    scene_cut: false,
    score,
    reasons: [],
  };
}

/**
 * R17 playfix:`bestStart` / `momentsLoaded` 必须按 clipId 归属。换素材的第一拍(state 还没被
 * effect 清掉)不能把 A 的最高分时刻和「已到齐」报给 B —— 监视器那一拍若恰好认为 B 就绪,
 * 就会把 B seek 到 A 的最高分处。
 */
describe("R17 playfix:时刻分按 clipId 归属", () => {
  it("A 的时刻分到齐后换成 B:同一拍 momentsLoaded=false、bestStart=null;B 自己的到齐后才是 B 的", async () => {
    apiMocks.getClipMoments.mockImplementation(async (clipId: number) => {
      const best = clipId === 9 ? 40 : 10;
      return Array.from({ length: 60 }, (_, index) => moment(clipId, index, index === best ? 0.95 : 0.2));
    });
    const hook = renderHook((clip: ClipListItem) => useClipSuggestions(clip, 60), { initialProps: clipA });
    await waitFor(() => expect(hook.result.current.momentsLoaded).toBe(true));
    expect(hook.result.current.bestStart).toBe(20);

    let sawStale = false;
    // 换素材那一拍(effect 还没跑)的返回值:hook 的 render 阶段。
    const probe = renderHook(
      (clip: ClipListItem) => {
        const state = useClipSuggestions(clip, 60);
        if (clip.id === 10 && (state.momentsLoaded || state.bestStart !== null) && state.moments.some((item) => item.clip_id === 9)) sawStale = true;
        return state;
      },
      { initialProps: clipA },
    );
    await waitFor(() => expect(probe.result.current.momentsLoaded).toBe(true));
    probe.rerender(clipB);
    expect(sawStale).toBe(false);
    await waitFor(() => expect(probe.result.current.momentsLoaded).toBe(true));
    expect(probe.result.current.bestStart).toBe(5);
    expect(probe.result.current.moments.every((item) => item.clip_id === 10)).toBe(true);
  });
});
