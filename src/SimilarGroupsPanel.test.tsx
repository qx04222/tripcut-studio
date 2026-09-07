// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipListItem, SimilarGroup } from "./api";

const apiMock = vi.hoisted(() => ({
  listSimilarGroups: vi.fn(),
  setSimilarPrimary: vi.fn(),
}));
vi.mock("./api", () => apiMock);

import { SimilarGroupsPanel } from "./SimilarGroupsPanel";

function makeClip(id: number, fileName: string): ClipListItem {
  return {
    id,
    episode_id: 1,
    folder_label: null,
    cover_url: `cover://${id}`,
    path: `/clips/${fileName}`,
    file_name: fileName,
    byte_size: 1024,
    quick_hash: "hash",
    full_hash: null,
    tb_num: 1,
    tb_den: 1000,
    duration_ticks: 2000,
    fps_num: 25,
    fps_den: 1,
    is_vfr: false,
    codec: "h264",
    width: 1920,
    height: 1080,
    captured_at: null,
    status: "ready",
    error: null,
    analysis: null,
    analysis_status: null,
    analysis_error: null,
    motion: null,
    motion_status: null,
    motion_error: null,
    binary_rating: null,
    star_rating: null,
    select_count: 0,
  };
}

const clip40 = makeClip(40, "a.mov");
const clip41 = makeClip(41, "b.mov");
const clip42 = makeClip(42, "c.mov");
const clipsById = new Map<number, ClipListItem>([
  [40, clip40],
  [41, clip41],
  [42, clip42],
]);

const groupOne: SimilarGroup = {
  id: 1,
  min_similarity: 0.9,
  members: [
    { clip_id: 40, is_primary: true },
    { clip_id: 41, is_primary: false },
    { clip_id: 42, is_primary: false },
  ],
};
const groupTwo: SimilarGroup = {
  id: 2,
  min_similarity: 0.85,
  members: [
    { clip_id: 90, is_primary: true },
    { clip_id: 91, is_primary: false },
  ],
};

describe("SimilarGroupsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    apiMock.listSimilarGroups.mockResolvedValue([groupOne, groupTwo]);
    apiMock.setSimilarPrimary.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the group the clip belongs to with covers and the primary badge", async () => {
    await act(async () =>
      root.render(<SimilarGroupsPanel clipId={42} readOnly={false} clipsById={clipsById} />),
    );
    const images = container.querySelectorAll(".similar-group-member-image img");
    expect(images.length).toBe(3);
    expect(container.textContent).toContain("主镜头");
  });

  it("calls setSimilarPrimary with the group id and clip id when clicked", async () => {
    await act(async () =>
      root.render(<SimilarGroupsPanel clipId={42} readOnly={false} clipsById={clipsById} />),
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const clipCButton = buttons.find((button) => button.closest("li")?.textContent?.includes("c.mov"));
    await act(async () => clipCButton?.click());
    expect(apiMock.setSimilarPrimary).toHaveBeenCalledWith(1, 42);
  });

  it("disables the buttons and shows a read-only notice for archived episodes", async () => {
    await act(async () =>
      root.render(<SimilarGroupsPanel clipId={42} readOnly={true} clipsById={clipsById} />),
    );
    expect(container.textContent).toContain("历史集为只读档案");
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("refetches and reflects the new primary after setSimilarPrimary resolves", async () => {
    const groupOneAfter: SimilarGroup = {
      id: 1,
      min_similarity: 0.9,
      members: [
        { clip_id: 40, is_primary: false },
        { clip_id: 41, is_primary: false },
        { clip_id: 42, is_primary: true },
      ],
    };
    apiMock.listSimilarGroups
      .mockResolvedValueOnce([groupOne, groupTwo])
      .mockResolvedValueOnce([groupOneAfter, groupTwo]);

    await act(async () =>
      root.render(<SimilarGroupsPanel clipId={42} readOnly={false} clipsById={clipsById} />),
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const clipCButton = buttons.find((button) => button.closest("li")?.textContent?.includes("c.mov"));
    await act(async () => clipCButton?.click());

    expect(apiMock.listSimilarGroups).toHaveBeenCalledTimes(2);
    const clipCLi = Array.from(container.querySelectorAll("li")).find((li) => li.textContent?.includes("c.mov"));
    expect(clipCLi?.className).toContain("primary");
    expect(clipCLi?.querySelector(".primary-badge")).not.toBeNull();
    const clipALi = Array.from(container.querySelectorAll("li")).find((li) => li.textContent?.includes("a.mov"));
    expect(clipALi?.className).not.toContain("primary");
  });

  it("shows the empty-state message when the clip is in no group", async () => {
    await act(async () =>
      root.render(<SimilarGroupsPanel clipId={999} readOnly={false} clipsById={clipsById} />),
    );
    expect(container.textContent).toContain("无相似组");
  });
});
