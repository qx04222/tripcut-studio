import { describe, expect, it } from "vitest";
import type { ClipAnalysis, SimilarGroup } from "../api";
import { photoFixture } from "./photoTestFixtures";
import { sortPoolClips } from "./poolOrder";
import { buildPhotoSections, featuredPhotos, moveVisiblePhoto } from "./photoWorkspaceModel";
const primary = { ...photoFixture, id: 10, file_name: "primary.jpg", captured_at: "2026-09-19T13:00:00Z" };
const similar = { ...photoFixture, id: 11, file_name: "similar.jpg", captured_at: "2026-09-19T13:01:00Z" };
const junkAnalysis: ClipAnalysis = { clip_id: 12, exposure_yavg: 10, overexposed_ratio: 0, audio_peak_db: null, audio_clipped: false, has_audio: false, focus_scores: [], scene_count: 0, analyzed_at: "now", tool_versions: {}, underexposed_ratio: 0.8, dynamic_range: 0, blur_mean: 0, entropy_mean: 0, motion_mean: 0, out_of_focus_ratio: 0 };
const junk = { ...photoFixture, id: 12, file_name: "junk.jpg", captured_at: "2026-09-19T09:00:00Z", analysis: junkAnalysis };
const groups: SimilarGroup[] = [{ id: 2, min_similarity: 0.93, members: [{ clip_id: 11, is_primary: false }, { clip_id: 10, is_primary: true }] }];
describe("照片工作台分组", () => {
  it("按日期/时段分组，相似组 primary 在前并折成 ×N，疑似废片排到最后", () => {
    const items = buildPhotoSections([junk, similar, primary], groups).flatMap((section) => section.items);
    expect(items.map((item) => item.clip.id)).toEqual([10, 12]);
    expect(items[0]).toMatchObject({ similarCount: 2, similarClipIds: [10, 11] });
    expect(items.at(-1)?.suspectedJunk).toBe(true);
  });
  it("展开相似组后六张全显，primary 第一且疑似废片在组末", () => {
    const members = [primary, similar, { ...primary, id: 13 }, { ...primary, id: 14 }, { ...primary, id: 15 }, junk];
    const expandedGroup: SimilarGroup = { id: 9, min_similarity: 0.96, members: members.map((clip) => ({ clip_id: clip.id!, is_primary: clip.id === primary.id })) };
    const items = buildPhotoSections(members, [expandedGroup], new Set([9])).flatMap((section) => section.items);
    expect(items.map((item) => item.clip.id)).toEqual([10, 11, 13, 14, 15, 12]);
    expect(items[0]).toMatchObject({ similarPrimary: true, similarGroupExpanded: true, similarCount: 6 });
    expect(items.at(-1)).toMatchObject({ clip: { id: 12 }, suspectedJunk: true });
  });
  it("精选只收收藏/三星以上/已选照片，并按集内顺序设置排列", () => {
    const selected = { ...primary, binary_rating: 1 as const };
    const starred = { ...similar, star_rating: 4 as const };
    const selectedThenRejected = { ...junk, id: 13, select_count: 1, binary_rating: -1 as const };
    const selectedThenRestored = { ...junk, id: 14, select_count: 1, binary_rating: 1 as const };
    const selectedThenCleared = { ...junk, id: 15, select_count: 1, binary_rating: 0 as const };
    expect(featuredPhotos([selected, junk, starred, selectedThenRejected, selectedThenRestored, selectedThenCleared], [11, 13, 14, 15, 10]).map((clip) => clip.id)).toEqual([11, 14, 15, 10]);
  });
  it("可见项跨过多个隐藏项交换时保持隐藏项相对次序", () => {
    expect(moveVisiblePhoto([1, 2, 4, 3], 3, -1, [1, 3])).toEqual([3, 2, 4, 1]);
  });
  it("跨时区照片按拍摄地日期/时分排序和分组,不跟审片 Mac 时区漂移", () => {
    const januarySecond = { ...photoFixture, id: 21, photo: { ...photoFixture.photo!,
      taken_at: "2026-01-01T10:30:00Z", taken_at_local: "2026-01-02T00:30:00+14:00", tz_guess: "UTC+14:00" } };
    const januaryFirst = { ...photoFixture, id: 22, photo: { ...photoFixture.photo!,
      taken_at: "2026-01-02T11:30:00Z", taken_at_local: "2026-01-01T23:30:00-12:00", tz_guess: "UTC-12:00" } };

    expect(sortPoolClips([januarySecond, januaryFirst]).map((clip) => clip.id)).toEqual([22, 21]);
    const sections = buildPhotoSections([januarySecond, januaryFirst], []);
    expect(sections.map((section) => section.label)).toEqual([
      "2026-01-01 · 夜间",
      "2026-01-02 · 凌晨",
    ]);
    expect(sections.flatMap((section) => section.items.map((item) => item.clip.id))).toEqual([22, 21]);
  });
});
