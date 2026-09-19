import { describe, expect, it } from "vitest";

import { groupClipsByDateAndPeriod, timePeriodOf } from "./poolGrouping";
import type { ClipListItem } from "../api";

function clip(overrides: Partial<ClipListItem> & { id: number }): ClipListItem {
  return {
    episode_id: 1,
    folder_label: null,
    cover_url: null,
    path: `/x/${overrides.id}.mp4`,
    file_name: `${overrides.id}.mp4`,
    byte_size: null,
    quick_hash: null,
    full_hash: null,
    tb_num: 1,
    tb_den: 1000,
    duration_ticks: 6000,
    fps_num: null,
    fps_den: null,
    is_vfr: false,
    codec: null,
    width: null,
    height: null,
    captured_at: null,
    binary_rating: null,
    star_rating: null,
    analysis_status: "done",
    ...overrides,
  } as ClipListItem;
}

describe("timePeriodOf", () => {
  it("按小时切成五段", () => {
    expect(timePeriodOf(3)).toBe("凌晨");
    expect(timePeriodOf(8)).toBe("上午");
    expect(timePeriodOf(14)).toBe("下午");
    expect(timePeriodOf(18)).toBe("傍晚");
    expect(timePeriodOf(22)).toBe("夜间");
  });
});

describe("groupClipsByDateAndPeriod", () => {
  it("同一天同一时段的素材合并成一组,按计数累加", () => {
    const clips = [
      clip({ id: 1, captured_at: "2026-08-12T08:10:00+08:00" }),
      clip({ id: 2, captured_at: "2026-08-12T08:40:00+08:00" }),
      clip({ id: 3, captured_at: "2026-08-12T19:00:00+08:00" }),
    ];
    const groups = groupClipsByDateAndPeriod(clips);
    expect(groups).toEqual([
      { key: "2026-08-12 上午", date: "2026-08-12", period: "上午", count: 2 },
      { key: "2026-08-12 傍晚", date: "2026-08-12", period: "傍晚", count: 1 },
    ]);
  });

  it("没有拍摄时间的素材归进末尾的「时间未知」组,不管它在列表里第一次出现在哪", () => {
    const clips = [
      clip({ id: 1, captured_at: null }),
      clip({ id: 2, captured_at: "2026-08-13T09:00:00+08:00" }),
      clip({ id: 3, captured_at: null }),
    ];
    const groups = groupClipsByDateAndPeriod(clips);
    expect(groups).toEqual([
      { key: "2026-08-13 上午", date: "2026-08-13", period: "上午", count: 1 },
      { key: "时间未知", date: null, period: null, count: 2 },
    ]);
  });

  it("空列表返回空数组", () => {
    expect(groupClipsByDateAndPeriod([])).toEqual([]);
  });
});
