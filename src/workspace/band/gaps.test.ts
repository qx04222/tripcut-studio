import { expect, it } from "vitest";
import type { BandChapter, BandSegment } from "../shotBandModel";
import type { StoryGap } from "../../api";
import { groupAdjacentGaps } from "./gaps";
import { gapMenuItems } from "../BandSegment";
it("offers a real pool filter action, while keeping the frozen ignore AX name", () => {
  expect(gapMenuItems(null, false)).toContainEqual({ id: "pool", label: "从池里填" });
  expect(gapMenuItems(null, false).find(item => item.id === "dismiss")?.ariaLabel).toBe("忽略");
});
it("groups adjacent narrative gaps without inventing a duration or losing their identities", () => {
  const gap = (id: number) => ({ key: `slot:${id}`, kind: "slot", gap: { id, slot_label_zh: `类型${id}` } as StoryGap, durationTicks: 0 }) as BandSegment;
  const result = groupAdjacentGaps([{ segments: [gap(1), gap(2)], gapCount: 2, durationMs: 0 } as BandChapter]);
  expect(result[0]!.segments).toHaveLength(1);
  expect(result[0]!.segments[0]!.groupedGaps?.map(gap => gap.id)).toEqual([1, 2]);
  expect(result[0]!.durationMs).toBe(0);
  expect(result[0]!.gapCount).toBe(2);
});
