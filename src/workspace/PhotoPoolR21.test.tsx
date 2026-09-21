// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PoolCard } from "./PoolCard";
import { poolDurationLabel, isPortraitClip, poolDateLabel } from "./poolModel";
import { groupClipsByDateAndPeriod } from "./poolGrouping";
import { photoFixture, videoFixture } from "./photoTestFixtures";
import * as order from "./poolOrder";

afterEach(cleanup);
it("PH-03 pool: photo badge, oriented dimensions, RAW expansion and no video scrub", () => {
  const select = vi.fn();
  render(<PoolCard clip={photoFixture} columnIndex={1} selected={false} isAnchor inMultiSelection={false} onSelect={select} />);
  expect(screen.getByRole("img", { name: "照片" })).toBeTruthy();
  expect(poolDurationLabel(photoFixture)).toBe("3024×4032");
  expect(screen.getByText("3024×4032")).toBeTruthy();
  expect(isPortraitClip(photoFixture)).toBe(true);
  fireEvent.click(screen.getByText("RAW"));
  const list = screen.getByRole("list", { name: "伴随文件" });
  expect(list.textContent).toContain("portrait.ARW");
  expect(list.textContent).toContain("RAW");
  expect(select).not.toHaveBeenCalled();
  // 列表展开后行里也有「RAW」角色字,再点的是角标本身。
  fireEvent.click(screen.getByText("RAW", { selector: ".photo-r21-raw" }));
  expect(screen.queryByRole("list", { name: "伴随文件" })).toBeNull();
});
it("PH-03 pool: taken_at mixes photos and video and powers the import date map", () => {
  expect(order.sortPoolClips([videoFixture, photoFixture]).map(c => c.id)).toEqual([2, 1]);
  expect(poolDateLabel(photoFixture)).toBe("08-12");
  // 视频保持本机 UTC 钟面;照片回到 taken_at_local 的拍摄地 16:00。
  const tz = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    expect(groupClipsByDateAndPeriod([videoFixture, photoFixture])).toEqual([
      { key: "2026-08-12 上午", date: "2026-08-12", period: "上午", count: 1 },
      { key: "2026-08-12 下午", date: "2026-08-12", period: "下午", count: 1 },
    ]);
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
  expect(poolDurationLabel(videoFixture)).toBe("00:12");
});
