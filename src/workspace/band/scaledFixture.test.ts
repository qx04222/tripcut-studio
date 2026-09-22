import { afterEach, expect, it, vi } from "vitest";
import type { ClipListItem, Storyboard } from "../../api";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("materializes 300 distinct, bounded video blocks, including after mock reset", async () => {
  vi.stubEnv("VITE_MOCK_BAND_SEGMENTS", "300");
  vi.resetModules();
  const fixture = await import("../../devMock/fixture");
  for (let pass = 0; pass < 2; pass += 1) {
    if (pass) fixture.__resetMockForTests();
    fixture.scaleMockBand(300);
    const board = fixture.handleMockCommand("get_storyboard", {}) as Storyboard;
    const clips = fixture.handleMockCommand("list_clips", {}) as ClipListItem[];
    expect(board.items).toHaveLength(300);
    expect(new Set(board.items.map(item => item.key)).size).toBe(300);
    for (const item of board.items) {
      const clip = clips.find(clip => clip.id === item.clip_id)!;
      expect(clip.kind).toBe("video");
      expect(item.in_ticks).toBeGreaterThanOrEqual(0);
      expect(item.out_ticks).toBeGreaterThan(item.in_ticks);
      expect(item.out_ticks * item.tb_num / item.tb_den).toBeLessThanOrEqual(clip.duration_ticks! * clip.tb_num! / clip.tb_den!);
    }
  }
});
