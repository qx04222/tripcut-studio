import type { ClipListItem, ImportProgress, MissingClip } from "../../api";
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
      return { label: "登记完成", tone: "neutral" };
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

/**
 * 长路径「中间省略」的两半(R10 U-07):头 = 末段之前的全部(交给 CSS 尾部省略),
 * 尾 = 末段(永远整段可见)。CSS 的 text-overflow 只会省略尾巴,把末段拆成单独一段
 * 不收缩,视觉上就是「/Users/xin/Movies/…/walk-media」。单段路径尾为空,整条当头。
 */
export function splitPathForEllipsis(path: string): { head: string; tail: string } {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0) return { head: trimmed, tail: "" };
  return { head: trimmed.slice(0, cut + 1), tail: trimmed.slice(cut + 1) };
}

/** 任务分页顶部三段式的一段(R10 U-08):索引 / 画质 / 运镜各自的计数与百分比。 */
export interface PipelineSegment {
  id: "index" | "quality" | "motion";
  label: string;
  done: number;
  total: number;
  percent: number;
  running: number;
  waiting: number;
  failed: number;
}

function percentOf(done: number, total: number): number {
  return total <= 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
}

/**
 * 三段式:索引按 ImportProgress(失败也算处理过),画质 / 运镜按可用素材数。
 * 此前顶部只有一个「索引进度 100%」,下面却写着画质 10/21、运镜 0/21——用户以为全完了。
 */
export function pipelineSegments(
  progress: ImportProgress,
  readyCount: number,
  quality: AnalysisProgress,
  motion: AnalysisProgress,
): PipelineSegment[] {
  const indexed = progress.done + progress.failed;
  const pending = Math.max(0, progress.total - indexed - progress.running);
  return [
    { id: "index", label: "登记", done: indexed, total: progress.total, percent: percentOf(indexed, progress.total), running: progress.running, waiting: pending, failed: progress.failed },
    { id: "quality", label: "画质分析", done: quality.done, total: readyCount, percent: percentOf(quality.done, readyCount), running: quality.running, waiting: quality.waiting, failed: quality.failed },
    { id: "motion", label: "运镜分析", done: motion.done, total: readyCount, percent: percentOf(motion.done, readyCount), running: motion.running, waiting: motion.waiting, failed: motion.failed },
  ];
}

/** 三段合起来一句话:整条流水线到哪了(节标题右侧的 meta)。 */
export function pipelineHeadline(segments: readonly PipelineSegment[]): string {
  const [index, ...analysis] = segments;
  if (!index || index.total === 0) return "还没有素材";
  const indexDone = index.done >= index.total && index.running === 0;
  const analysisDone = analysis.every((segment) => segment.done + segment.failed >= segment.total);
  if (!indexDone) return `正在登记 ${index.percent}%`;
  if (analysisDone) return "登记与分析全部完成";
  return "登记完成，分析进行中";
}

/**
 * 解码许可 / 内存暂停的人话(R10 U-08)。此前直出「「38 等待解码许可」」这种内部计数。
 * 内存暂停优先;许可排队只在还有任务真的在跑 / 在等时才显示——索引和分析都收尾了
 * 还留着一个陈旧计数只会让人以为卡住了。
 */
export function decodeQueueHint(progress: ImportProgress, segments: readonly PipelineSegment[]): string | null {
  if (progress.paused_for_memory) return "内存不足，已暂停解码与模型任务；释放内存后会自动继续。";
  // R16 §3⑤:热 / 空闲只是慢,不是停;用户「全部暂停」由状态条的「后台已暂停」说,这里不重复。
  if (progress.paused_reason === "thermal") return "电脑有点热，后台先慢下来；凉下来会自动恢复。";
  if (progress.paused_reason === "idle_wait") return "等你不用电脑时再继续分析；正在跑的会跑完。";
  const waiting = progress.waiting_for_permit;
  if (!waiting || waiting <= 0) return null;
  const busy = segments.some((segment) => segment.running > 0 || segment.waiting > 0);
  if (!busy) return null;
  return `解码通道已占满，还有 ${waiting} 个任务在排队，会依次处理。`;
}

/**
 * Z-13:登记判定「已属于另一集」的文件,按集名归堆成一句「这 n 个文件已在「EP01」里,可在那一集里找到」。
 * 数据来自 listClips 的占位项(id 为空、status duplicate),后端把那一句放在 error 里;
 * 普通重复(同一集里已有)不在这里说。
 */
export function ownedElsewhereLines(clips: readonly ClipListItem[]): string[] {
  const counts = new Map<string, number>();
  for (const clip of clips) {
    if (clip.id !== null || clip.status !== "duplicate" || !clip.error) continue;
    const title = /已在「(.+?)」里/.exec(clip.error)?.[1];
    if (!title) continue;
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts.entries()].map(([title, count]) => `这 ${count} 个文件已在「${title}」里,可在那一集里找到`);
}

/**
 * R16 P1-6:后台任务行的中文名(不出现内部术语)。没见过的 kind 统称「后台处理」。
 */
const RUNNING_JOB_LABELS: Record<string, string> = {
  import_probe: "登记素材",
  metadata_backfill: "补齐拍摄信息",
  full_hash: "核对文件",
  thumbnail: "生成封面",
  strip: "生成画面条",
  waveform: "生成声音波形",
  proxy: "生成预览小文件",
  analyze_l1: "画质分析",
  analyze_motion: "运镜分析",
  moments: "时刻打分",
  clip_embed: "画面识别",
  classify_dims: "画面评分",
  transcribe: "语音转写",
  ocr_scan: "识别画面文字",
  similar_cluster: "找相似镜头",
  chapterize: "自动分章",
  align_clocks: "对齐相机时钟",
  narrate_episode: "生成叙事",
  music_analyze: "音乐分析",
  generation_poll: "云端补镜",
  export_package: "导出",
  cache_gc: "清理缓存文件",
};

export function runningJobLabel(kind: string): string {
  return RUNNING_JOB_LABELS[kind] ?? "后台处理";
}
