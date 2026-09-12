import { describe, expect, it } from "vitest";
import type { ClipListItem, MissingClip } from "../../api";
import { analysisProgress, batchStatusLabel, formatSyncTime, groupByVolume, lastPathSegment } from "./importModel";

describe("importModel", () => {
  it("analysisProgress:排队 / 失败 / 阻塞的旧结果不算完成(迁自 ImportPageRuntime.test)", () => {
    const clips = [
      { analysis: {}, analysis_status: "pending", motion: {}, motion_status: "running" },
      { analysis: {}, analysis_status: "blocked", motion: null, motion_status: null },
      { analysis: {}, analysis_status: "done", motion: {}, motion_status: "done" },
    ] as ClipListItem[];
    expect(analysisProgress(clips, "analysis")).toEqual({ done: 1, running: 0, failed: 1, waiting: 1 });
    expect(analysisProgress(clips, "motion")).toEqual({ done: 1, running: 1, failed: 0, waiting: 1 });
  });

  it("batchStatusLabel:五种状态文案逐字沿用 ImportManagement", () => {
    expect(batchStatusLabel("cancelled")).toEqual({ label: "已停止", tone: "neutral" });
    expect(batchStatusLabel("scanning")).toEqual({ label: "正在扫描", tone: "accent" });
    expect(batchStatusLabel("failed")).toEqual({ label: "扫描未完成，可重试", tone: "danger" });
    expect(batchStatusLabel("completed")).toEqual({ label: "索引完成", tone: "neutral" });
    expect(batchStatusLabel("queued")).toEqual({ label: "等待处理", tone: "neutral" });
    // 真实状态集见 import_control.rs::list_batches;旧 fixture 的 done / running 别名也要落到同一文案。
    expect(batchStatusLabel("done")).toEqual(batchStatusLabel("completed"));
    expect(batchStatusLabel("running")).toEqual(batchStatusLabel("scanning"));
    expect(batchStatusLabel("removed").label).toBe("已移除");
  });

  it("groupByVolume 保序分组", () => {
    const clips = [
      { clip_id: 1, volume_uuid: "b", volume_label: "B" }, { clip_id: 2, volume_uuid: "a", volume_label: null }, { clip_id: 3, volume_uuid: "b", volume_label: "B" },
    ] as MissingClip[];
    expect(groupByVolume(clips).map((g) => [g.volumeUuid, g.clips.map((c) => c.clip_id)])).toEqual([["b", [1, 3]], ["a", [2]]]);
  });

  it("lastPathSegment / formatSyncTime", () => {
    expect(lastPathSegment("/Volumes/CARD/2026-08-12/")).toBe("2026-08-12");
    expect(lastPathSegment("")).toBe("");
    expect(formatSyncTime("2026-09-11T08:00:00Z")).toBe("上次同步 2026-09-11 08:00");
    expect(formatSyncTime(null)).toBe("尚未自动同步");
  });
});
