import { describe, expect, it } from "vitest";

import type { ClipListItem } from "../api";
import { takeDateLabel, visibleDefaultSections } from "./inspectorModel";

describe("visibleDefaultSections(规格 §3.8:空段不渲染)", () => {
  it("全有时四段顺序固定", () => {
    expect(visibleDefaultSections({ tagCount: 3, hasPlacement: true, canReassign: true, hasStack: true })).toEqual([
      "rating",
      "tags",
      "chapter",
      "takes",
    ]);
  });
  it("没标签、不在任何章、没有 Take 时只剩评级", () => {
    expect(visibleDefaultSections({ tagCount: 0, hasPlacement: false, canReassign: false, hasStack: false })).toEqual(["rating"]);
  });
  it("可改章但尚未归章时章节段仍显示(有事可做)", () => {
    expect(visibleDefaultSections({ tagCount: 0, hasPlacement: false, canReassign: true, hasStack: false })).toEqual([
      "rating",
      "chapter",
    ]);
  });
});

describe("takeDateLabel", () => {
  it("取 captured_at 的月-日;没有拍摄时间给 null", () => {
    expect(takeDateLabel({ captured_at: "2026-08-12T09:30:00Z" } as ClipListItem)).toBe("08-12");
    expect(takeDateLabel({ captured_at: null } as ClipListItem)).toBeNull();
  });
});
