import type { ClipListItem, MissingClip } from "../../api";
import type { BadgeTone } from "../ui/Badge";

/** 与 `ImportPage.analysisProgress` 同一份算法(旧文件保留自己的导出给旧壳)。 */
export interface AnalysisProgress {
  done: number;
  running: number;
  failed: number;
  waiting: number;
}

export function analysisProgress(clips: readonly ClipListItem[], kind: "analysis" | "motion"): AnalysisProgress {
  let done = 0;
  let running = 0;
  let failed = 0;
  for (const clip of clips) {
    const status = kind === "analysis" ? clip.analysis_status : clip.motion_status;
    if (status === "failed" || status === "blocked") failed += 1;
    else if (status === "running") running += 1;
    else if (status === "pending") continue;
    else if (clip[kind]) done += 1;
  }
  return { done, running, failed, waiting: Math.max(0, clips.length - done - running - failed) };
}

/**
 * 批次状态文案逐字沿用 `ImportManagement`;tone 是新皮的角标色。
 * 真实取值来自 `src-tauri/src/core/import_control.rs::list_batches`:`scanning` / `queued`
 * (队列里没有 pending/running 作业时由 SQL 折成 `completed`)/ `cancelled` / `failed`;
 * `removed` 不会被列出。`done` / `running` 是旧 devMock fixture 用过的别名,一并兜住。
 */
export function batchStatusLabel(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case "cancelled":
      return { label: "已停止", tone: "neutral" };
    case "scanning":
    case "running":
      return { label: "正在扫描", tone: "accent" };
    case "failed":
      return { label: "扫描未完成，可重试", tone: "danger" };
    case "completed":
    case "done":
      return { label: "索引完成", tone: "neutral" };
    case "removed":
      return { label: "已移除", tone: "neutral" };
    default:
      return { label: "等待处理", tone: "neutral" };
  }
}

export interface VolumeGroup {
  volumeUuid: string;
  volumeLabel: string | null;
  clips: MissingClip[];
}

/** 与 `MissingMediaPanel.groupByVolume` 同一份:按首次出现的卷保序分组。 */
export function groupByVolume(clips: readonly MissingClip[]): VolumeGroup[] {
  const groups = new Map<string, VolumeGroup>();
  for (const clip of clips) {
    let group = groups.get(clip.volume_uuid);
    if (!group) {
      group = { volumeUuid: clip.volume_uuid, volumeLabel: clip.volume_label, clips: [] };
      groups.set(clip.volume_uuid, group);
    }
    group.clips.push(clip);
  }
  return [...groups.values()];
}

/** 批次来源只显示末段(`ImportManagement` 的 `split("/").filter(Boolean).at(-1)`)。 */
export function lastPathSegment(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

/** 关注文件夹「上次同步」文案逐字沿用 `ImportPage`。 */
export function formatSyncTime(lastScanAt: string | null): string {
  return lastScanAt ? `上次同步 ${lastScanAt.slice(0, 16).replace("T", " ")}` : "尚未自动同步";
}
