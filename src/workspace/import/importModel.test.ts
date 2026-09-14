import { describe, expect, it } from "vitest";
import type { ClipListItem, MissingClip } from "../../api";
import {
  analysisProgress,
  batchStatusLabel,
  decodeQueueHint,
  formatSyncTime,
  groupByVolume,
  lastPathSegment,
  pipelineHeadline,
  pipelineSegments,
  splitPathForEllipsis,
} from "./importModel";

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
    expect(batchStatusLabel("completed")).toEqual({ label: "登记完成", tone: "neutral" });
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

describe("R10 U-07:splitPathForEllipsis", () => {
  it("头 = 末段之前含斜杠的全部,尾 = 末段;尾部斜杠先剥掉", () => {
    expect(splitPathForEllipsis("/Users/xin/Movies/trip/walk-media")).toEqual({ head: "/Users/xin/Movies/trip/", tail: "walk-media" });
    expect(splitPathForEllipsis("/Volumes/CARD/")).toEqual({ head: "/Volumes/", tail: "CARD" });
  });
  it("单段或根路径整条当头,尾为空", () => {
    expect(splitPathForEllipsis("walk-media")).toEqual({ head: "walk-media", tail: "" });
    expect(splitPathForEllipsis("/CARD")).toEqual({ head: "/CARD", tail: "" });
  });
});

describe("R10 U-08:三段式流水线", () => {
  const progress = (patch: Partial<Parameters<typeof pipelineSegments>[0]>) => ({
    total: 21, done: 21, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false, ...patch,
  });
  const quality = { done: 10, running: 4, failed: 0, waiting: 7 };
  const motion = { done: 0, running: 0, failed: 0, waiting: 21 };

  it("登记按 ImportProgress、画质 / 运镜按可用素材数,各自百分比", () => {
    const segments = pipelineSegments(progress({}), 21, quality, motion);
    expect(segments.map((s) => [s.label, s.done, s.total, s.percent])).toEqual([
      ["登记", 21, 21, 100], ["画质分析", 10, 21, 48], ["运镜分析", 0, 21, 0],
    ]);
    expect(pipelineHeadline(segments)).toBe("登记完成，分析进行中");
  });
  it("标题四态:没有素材 / 正在登记 / 分析进行中 / 全部完成", () => {
    expect(pipelineHeadline(pipelineSegments(progress({ total: 0, done: 0 }), 0, motion, motion))).toBe("还没有素材");
    expect(pipelineHeadline(pipelineSegments(progress({ done: 10, running: 2 }), 10, quality, motion))).toBe("正在登记 48%");
    const all = { done: 21, running: 0, failed: 0, waiting: 0 };
    expect(pipelineHeadline(pipelineSegments(progress({}), 21, all, all))).toBe("登记与分析全部完成");
  });
  it("decodeQueueHint:内存暂停优先;许可排队只在还有任务在跑 / 在等时显示;不再输出「等待解码许可」", () => {
    const busy = pipelineSegments(progress({ waiting_for_permit: 38 }), 21, quality, motion);
    expect(decodeQueueHint(progress({ waiting_for_permit: 38 }), busy)).toBe("解码通道已占满，还有 38 个任务在排队，会依次处理。");
    expect(decodeQueueHint(progress({ waiting_for_permit: 38, paused_for_memory: true }), busy)).toContain("内存不足");
    const idle = { done: 21, running: 0, failed: 0, waiting: 0 };
    expect(decodeQueueHint(progress({ waiting_for_permit: 5 }), pipelineSegments(progress({}), 21, idle, idle))).toBeNull();
    expect(decodeQueueHint(progress({}), busy)).toBeNull();
    expect(decodeQueueHint(progress({ waiting_for_permit: 38 }), busy)).not.toContain("等待解码许可");
  });
  it("decodeQueueHint:R16 §3⑤ 热 / 空闲各一句人话;user 交给状态条不重复", () => {
    const busy = pipelineSegments(progress({}), 21, quality, motion);
    expect(decodeQueueHint(progress({ paused_reason: "thermal" }), busy)).toContain("电脑有点热");
    expect(decodeQueueHint(progress({ waiting_for_permit: 3, paused_reason: "idle_wait" }), busy)).toContain("不用电脑时");
    expect(decodeQueueHint(progress({ paused_reason: "user" }), busy)).toBeNull();
  });
});
