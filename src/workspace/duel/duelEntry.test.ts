import { beforeEach, expect, it, vi } from "vitest";
import type { ClipListItem } from "../../api";
import { __resetWorkspaceForTests } from "../WorkspaceStore";

const mocks = vi.hoisted(() => ({
  listClips: vi.fn(),
  listSelectSegments: vi.fn(),
  listShotStacks: vi.fn(),
  listSimilarGroups: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../api", () => mocks);

import { resolveDuel } from "./duelEntry";

const clip = (id: number, kind: "video" | "photo", binaryRating: -1 | 0 | 1 | null = null) => ({
  id,
  kind,
  missing_since: null,
  binary_rating: binaryRating,
} as unknown as ClipListItem);

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  mocks.listClips.mockResolvedValue([
    clip(1, "video"),
    clip(2, "video"),
    clip(11, "photo"),
    clip(12, "photo"),
  ]);
  mocks.listSimilarGroups.mockResolvedValue([
    { id: 1, min_similarity: 0.9, members: [{ clip_id: 1 }, { clip_id: 2 }] },
    { id: 2, min_similarity: 0.9, members: [{ clip_id: 11 }, { clip_id: 12 }] },
  ]);
  mocks.listShotStacks.mockResolvedValue([]);
  mocks.listSelectSegments.mockImplementation(async (clipId: number) => [
    { id: clipId * 10, clip_id: clipId },
  ]);
});

it("uses the photo group when the command palette has no selection in photo workspace", async () => {
  __resetWorkspaceForTests({ workspaceMode: "photo", selection: null });

  await expect(resolveDuel({ workspaceMode: "photo" })).resolves.toEqual({
    source: "similar_group",
    members: [
      { clip_id: 11, segment_id: null },
      { clip_id: 12, segment_id: null },
    ],
  });
  expect(mocks.listSelectSegments).not.toHaveBeenCalled();
});

it("uses the video group when the command palette has no selection in video workspace", async () => {
  __resetWorkspaceForTests({ workspaceMode: "video", selection: null });

  await expect(resolveDuel({ workspaceMode: "video" })).resolves.toEqual({
    source: "similar_group",
    members: [
      { clip_id: 1, segment_id: 10 },
      { clip_id: 2, segment_id: 20 },
    ],
  });
});

it("keeps the exact auto-select result row on a photo results duel", async () => {
  __resetWorkspaceForTests({ workspaceMode: "photo", selection: { kind: "clip", clipId: 11 } });

  await expect(resolveDuel({ clipIds: [11, 12], segmentId: 901, source: "results" })).resolves.toEqual({
    source: "results",
    members: [
      { clip_id: 11, segment_id: null, result_segment_id: 901 },
      { clip_id: 12, segment_id: null },
    ],
  });
});

it("filters explicit X photos from selected and automatic-group entries", async () => {
  mocks.listClips.mockResolvedValue([
    clip(11, "photo"),
    clip(12, "photo", -1),
    clip(13, "photo"),
  ]);
  mocks.listSimilarGroups.mockResolvedValue([
    { id: 2, min_similarity: 0.9, members: [{ clip_id: 11 }, { clip_id: 12 }, { clip_id: 13 }] },
  ]);
  __resetWorkspaceForTests({ workspaceMode: "photo", selection: null });
  await expect(resolveDuel({ workspaceMode: "photo" })).resolves.toEqual({
    source: "similar_group",
    members: [
      { clip_id: 11, segment_id: null },
      { clip_id: 13, segment_id: null },
    ],
  });
  await expect(resolveDuel({ clipIds: [11, 12, 13], source: "manual" })).resolves.toEqual({
    source: "manual",
    members: [
      { clip_id: 11, segment_id: null },
      { clip_id: 13, segment_id: null },
    ],
  });
  await expect(resolveDuel({ clipIds: [11, 12, 13], segmentId: 901, source: "results" })).resolves.toEqual({
    source: "results",
    members: [
      { clip_id: 11, segment_id: null, result_segment_id: 901 },
      { clip_id: 13, segment_id: null },
    ],
  });
});

it("gives an actionable error when X leaves fewer than two photos, including a result anchor", async () => {
  __resetWorkspaceForTests({ workspaceMode: "photo" });
  mocks.listClips.mockResolvedValue([clip(11, "photo", -1), clip(12, "photo")]);
  await expect(resolveDuel({ clipIds: [11, 12], source: "manual" }))
    .rejects.toThrow("先按 F 保留、清除评级，或换一张");
  await expect(resolveDuel({ clipIds: [11, 12], segmentId: 901, source: "results" }))
    .rejects.toThrow("先按 F 保留、清除评级，或换一张");
});

it("rejects a stale command-palette duel after the workspace changes", async () => {
  __resetWorkspaceForTests({ workspaceMode: "video", selection: null });

  await expect(resolveDuel({ workspaceMode: "photo" })).rejects.toThrow("工作台已切换");
  expect(mocks.listClips).not.toHaveBeenCalled();
});
