import { describe, expect, it } from "vitest";

import type { ClipListItem } from "../api";
import { takeDateLabel, visibleDefaultSections } from "./inspectorModel";

describe("visibleDefaultSections(R10 U-12:可编辑段常驻,只有 Take 段按内容显示)", () => {
  it("全有时五段顺序固定", () => {
    expect(visibleDefaultSections({ tagCount: 3, hasPlacement: true, canReassign: true, hasStack: true })).toEqual([
      "rating",
      "tags",
      "chapter",
      "segments",
      "takes",
    ]);
  });
  it("没标签、不在任何章、没有 Take 时:评级 / 标签 / 章节 / 精选段仍常驻(空态给入口),只少 Take 段", () => {
    expect(visibleDefaultSections({ tagCount: 0, hasPlacement: false, canReassign: false, hasStack: false })).toEqual([
      "rating",
      "tags",
      "chapter",
      "segments",
    ]);
  });
  it("可改章但尚未归章时章节段照样显示", () => {
    expect(visibleDefaultSections({ tagCount: 0, hasPlacement: false, canReassign: true, hasStack: false })).toContain("chapter");
  });
});

describe("takeDateLabel", () => {
  it("取 captured_at 的月-日;没有拍摄时间给 null", () => {
    expect(takeDateLabel({ captured_at: "2026-08-12T09:30:00Z" } as ClipListItem)).toBe("08-12");
    expect(takeDateLabel({ captured_at: null } as ClipListItem)).toBeNull();
  });
});
