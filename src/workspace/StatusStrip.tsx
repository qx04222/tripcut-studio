import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import {
  IMPORT_PROBE_DONE_EVENT,
  bridgeImportProbeEvents,
  getImportProgress,
  getMusicAnalysisProgress,
  onStartupBackfill,
  listGenerationRequests,
  listLibraries,
  listMissingClips,
  type ImportProgress,
} from "../api";
import { UpdateStatusChip } from "./update/UpdateStatusChip";
import { ModelStatusPhrase } from "./ModelStatusPhrase";
import { StatusPause } from "./StatusPause";
import { useComposingIndicator } from "./useRatingHotkeys";
import { useToolchainStatus } from "./ToolchainBanner";
import { useClipsFeed } from "./useClipsFeed";
import { clipDurationSeconds } from "./useBandTrim";
import { Button, Icon } from "./ui";
import { dispatchWorkspace } from "./WorkspaceStore";

export interface BackgroundSummary {
  analyzed: number;
  analyzeTotal: number;
  /** Z-04:无法分析(登记失败)的文件数;算作已处理,「分析完成 · 7 条,2 条无法分析」。可选:旧调用方不传。 */
  analyzeFailed?: number;
  transcribing: number;
  generating: number;
  missing: number;
  /** R10 U-19:当前集音乐轨已分析 / 总数 / 仍在排队或进行中的条数(可选:旧调用方不传)。 */
  musicDone?: number;
  musicTotal?: number;
  musicActive?: number;
  /** R15-perf:预览小文件是分析之后的后台活,单独报「正在生成预览小文件 n/m」,不挡「分析完成」。 */
  proxyDone?: number;
  proxyTotal?: number;
  proxyActive?: number;
  /** R15:还没做完的缓存文件清理任务数(删素材 / 删集 / 清缓存后台删目录);可选:旧调用方不传。 */
  cleanup?: number;
  /** R15:还没生成完的预览文件任务数;分析短语不在场时(清理缓存后重新生成)报出来。可选。 */
  regenerating?: number;
  /** R18 W-4:启动补扫(增量入队 + 启动快照)还在跑。可选:旧调用方不传。 */
  startupBackfill?: boolean;
  /** R16 §3⑤:后台不认领重活的原因;`user` 由 StatusPause 的「后台已暂停」负责,这里不再重复。可选。 */
  pausedReason?: ImportProgress["paused_reason"];
  /**
   * U-04/P-10「导入即有地图」:当前库已入库的素材数 / 总时长(毫秒)。两个都传时,
   * 分析短语换成「已导入 N 条 · 共 X 分钟 · 正在分析(约 T)」——比单说「正在分析 12/27」
   * 多告诉用户「这批素材有多少内容」。旧调用方不传时行为完全不变(走 analysisPhrase)。
   */
  importedCount?: number;
  importedDurationMs?: number;
}

const EMPTY_SUMMARY: BackgroundSummary = {
  analyzed: 0,
  analyzeTotal: 0,
  transcribing: 0,
  generating: 0,
  missing: 0,
  musicDone: 0,
  musicTotal: 0,
  musicActive: 0,
  proxyDone: 0,
  proxyTotal: 0,
  proxyActive: 0,
};

const POLL_INTERVAL_MS = 3_000;
/** X-04:单条完成事件密集到来时合并成一次刷新。 */
const PROBE_EVENT_COALESCE_MS = 100;

/** R12 §3:剩余时间按最近这一段窗口里的速率估。 */
export const ETA_WINDOW_MS = 10_000;
/** 窗口里至少要有这么长的跨度才敢估(两次轮询之间)。 */
const ETA_MIN_SPAN_MS = 2_000;
/** 「分析完成 · n 条」停留多久后收起。 */
export const ANALYSIS_DONE_LINGER_MS = 3_000;

export interface ProgressSample {
  at: number;
  done: number;
}

/**
 * 按最近 `ETA_WINDOW_MS` 内的速率估还要多少毫秒:取窗口内最早与最新两个样本,
 * 没进展 / 跨度不足 / 样本不够 → null(短语就只说进度,不瞎猜)。
 */
export function estimateRemaining(samples: readonly ProgressSample[], total: number, now: number): number | null {
  const window = samples.filter((sample) => sample.at >= now - ETA_WINDOW_MS);
  if (window.length < 2) return null;
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const span = last.at - first.at;
  const progressed = last.done - first.done;
  if (span < ETA_MIN_SPAN_MS || progressed <= 0) return null;
  const remaining = Math.max(0, total - last.done);
  return Math.round((remaining / progressed) * span);
}

/** 「30 秒」(5 秒向上取整)/「2 分钟」(向上取整)。 */
export function formatRemaining(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1_000));
  if (seconds < 60) return `${Math.max(5, Math.ceil(seconds / 5) * 5)} 秒`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}

/**
 * 「正在分析 12/21,大约还要 30 秒」/「正在分析 12/21」/「分析完成 · 21 条」;
 * Z-04:有无法分析的文件时「分析完成 · 7 条,2 条无法分析」(失败算已处理,不再永远 7/9)。
 */
export function analysisPhrase(analyzed: number, total: number, eta: string | null, failed = 0): string {
  if (analyzed >= total) {
    return failed > 0 ? `分析完成 · ${Math.max(0, total - failed)} 条,${failed} 条无法分析` : `分析完成 · ${total} 条`;
  }
  return eta ? `正在分析 ${analyzed}/${total},大约还要 ${eta}` : `正在分析 ${analyzed}/${total}`;
}

/** 620_000 ms → 「10 分钟」(向下取整到分钟,不到 1 分钟按 1 分钟报,不然新导入的一小批显示「共 0 分钟」很怪)。 */
function formatImportedMinutes(ms: number): string {
  return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`;
}

/**
 * U-04/P-10「导入即有地图」:「已导入 27 条 · 共 10 分钟」/ 分析还没跑完时多接一句
 * 「· 正在分析(约 3 分钟)」。`analysing` 传 null 表示分析已经完成或本来就没有分析总量。
 */
export function importMapPhrase(count: number, durationMs: number, analysing: string | null): string {
  const base = `已导入 ${count} 条 · 共 ${formatImportedMinutes(durationMs)}`;
  return analysing ? `${base} · 正在分析(约 ${analysing})` : base;
}

/**
 * Z-01 / Z-04:把后端的登记进度与素材分析进度合成状态条用的 (analyzed, total, failed)。
 * - 分母 = 登记到的文件数(与素材数 + 失败 + 重复取大,生成物等没走登记的素材也算进来);
 * - 分子 = 画质 / 运镜分析都落了终态的素材 + 登记失败的文件 + 判定重复的文件;
 * - 旧后端没有 analysis_* 字段时退回「登记完成 + 失败」。
 */
export function analysisProgressFrom(progress: ImportProgress): { analyzed: number; total: number; failed: number } {
  const failed = progress.failed ?? 0;
  const duplicate = progress.duplicate ?? 0;
  if (typeof progress.analysis_total !== "number" || typeof progress.analysis_done !== "number") {
    return { analyzed: Math.min(progress.total, progress.done + failed), total: progress.total, failed };
  }
  const total = Math.max(progress.total, progress.analysis_total + failed + duplicate);
  const analyzed = Math.min(total, progress.analysis_done + failed + duplicate);
  return { analyzed, total, failed };
}

const isAnalysisPhrase = (phrase: string): boolean =>
  phrase.startsWith("正在分析 ") || phrase.startsWith("分析完成 ") || phrase.startsWith("已导入 ");

/** 纯函数:按存在性依次生成中文短语,全 0 时返回 ["后台空闲"]。`eta` 是估好的剩余时间文案(估不出传 null)。 */
export function summaryPhrases(summary: BackgroundSummary, eta: string | null = null): string[] {
  const phrases: string[] = [];
  // R18 W-4:启动补扫挪到开窗之后,这段时间要说人话——不说「补扫」这种内部词。
  if (summary.startupBackfill) phrases.push("正在整理素材库");
  if (typeof summary.importedCount === "number" && typeof summary.importedDurationMs === "number") {
    // U-04/P-10:有导入批次信息时,「已导入 N 条 · 共 X 分钟」取代单说「正在分析 n/m」——
    // 分析还没跑完才带「· 正在分析(约 T)」半句,跑完了就只剩导入摘要本身。
    const analysing = summary.analyzeTotal > 0 && summary.analyzed < summary.analyzeTotal ? eta : null;
    if (summary.analyzeTotal > 0 || summary.importedCount > 0) {
      const unknownEta = eta === null && summary.analyzed < summary.analyzeTotal;
      const progress = unknownEta ? ` · 正在分析 ${summary.analyzed}/${summary.analyzeTotal}` : "";
      phrases.push(importMapPhrase(summary.importedCount, summary.importedDurationMs, analysing) + progress);
    }
  } else if (summary.analyzeTotal > 0) {
    phrases.push(analysisPhrase(summary.analyzed, summary.analyzeTotal, eta, summary.analyzeFailed ?? 0));
  }
  // 音乐分析只在还有轨排队 / 进行中时报数;全部落终态就不占位(失败的在音乐面板里看)。
  if ((summary.musicActive ?? 0) > 0) phrases.push(`音乐分析 ${summary.musicDone ?? 0}/${summary.musicTotal ?? 0}`);
  // R15-perf:预览小文件排在分析之后单独报数;全部生成完就不占位。
  if ((summary.proxyActive ?? 0) > 0) phrases.push(`正在生成预览小文件 ${summary.proxyDone ?? 0}/${summary.proxyTotal ?? 0}`);
  if (summary.transcribing > 0) phrases.push(`转写 ${summary.transcribing}`);
  if (summary.generating > 0) phrases.push(`云端生成 ${summary.generating} 排队`);
  if (summary.missing > 0) phrases.push(`缺失素材 ${summary.missing}`);
  // 清理缓存之后:分析早就完成、状态条本来会说「后台空闲」,预览文件却在重新生成 —— 这时报进度。
  const analysing = summary.analyzeTotal > 0 && summary.analyzed < summary.analyzeTotal;
  if (!analysing && (summary.regenerating ?? 0) > 0) phrases.push(`正在重新生成预览 · 还剩 ${summary.regenerating} 个`);
  if ((summary.cleanup ?? 0) > 0) phrases.push("正在清理缓存文件");
  // R16 §3⑤:还有活在排时说明为什么慢 / 停;后台本来就空闲时不说(没有东西被挡)。
  if (phrases.length > 0) {
    const reason = pauseReasonPhrase(summary.pausedReason);
    if (reason) phrases.push(reason);
  }
  return phrases.length > 0 ? phrases : ["后台空闲"];
}

/** R16 §3⑤:`paused_reason` 的人话;`user` 由 StatusPause 显示「后台已暂停」,这里返回 null。 */
export function pauseReasonPhrase(reason: ImportProgress["paused_reason"] | undefined): string | null {
  switch (reason) {
    case "memory":
      return "内存不足,后台先停一停";
    case "thermal":
      return "电脑有点热,后台先慢下来";
    case "idle_wait":
      return "等你不用电脑时继续";
    // R18 W-6:低电量模式只是慢下来,不是停;文案别说「已暂停」。
    case "low_power":
      return "电池在省电模式,后台先慢下来";
    default:
      return null;
  }
}

function useBackgroundSummary(): { summary: BackgroundSummary; eta: string | null; showAnalysis: boolean } {
  const [summary, setSummary] = useState<BackgroundSummary>(EMPTY_SUMMARY);
  // R12 §3:最近 10 秒的进度样本(估剩余时间用),与「分析完成」出现的时刻(3 秒后收起)。
  const samples = useRef<ProgressSample[]>([]);
  const lastProgress = useRef<{ done: number; total: number } | null>(null);
  const [eta, setEta] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);
  const [lingerOver, setLingerOver] = useState(false);

  useEffect(() => {
    if (doneAt === null) return;
    setLingerOver(false);
    const timer = setTimeout(() => setLingerOver(true), ANALYSIS_DONE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [doneAt]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const [progress, missing, generation, music] = await Promise.allSettled([
        getImportProgress(),
        listMissingClips(),
        listGenerationRequests(),
        getMusicAnalysisProgress(),
      ]);
      if (!active) return;
      const merged = progress.status === "fulfilled" ? analysisProgressFrom(progress.value) : null;
      if (merged) {
        const now = Date.now();
        const { analyzed: done, total } = merged;
        const analysing = total > 0 && done < total;
        if (analysing) {
          samples.current = [...samples.current.filter((sample) => sample.at >= now - ETA_WINDOW_MS), { at: now, done }];
          const remaining = estimateRemaining(samples.current, total, now);
          setEta(remaining === null ? null : formatRemaining(remaining));
        } else {
          samples.current = [];
          setEta(null);
        }
        // 从「分析中 / 还没读到」落到「全部完成」的那一刻起计 3 秒,之后短语收起。
        const previous = lastProgress.current;
        const wasAnalysing = previous === null || previous.done < previous.total;
        if (total > 0 && done >= total && wasAnalysing) setDoneAt(now);
        lastProgress.current = { done, total };
      }
      setSummary((previous) => ({
        // 某一条读失败时保留上一次的值 —— 状态条闪回 0 会被当成「后台空了」。
        analyzed: merged ? merged.analyzed : previous.analyzed,
        analyzeTotal: merged ? merged.total : previous.analyzeTotal,
        analyzeFailed: merged ? merged.failed : previous.analyzeFailed,
        // 没有独立的转写进度命令;把导入队列的 running 说成「转写」是假话,
        // 所以这里先留 0,等后端有分阶段进度再接。
        transcribing: 0,
        generating:
          generation.status === "fulfilled"
            ? generation.value.filter((item) => item.status === "queued" || item.status === "submitted")
                .length
            : previous.generating,
        missing: missing.status === "fulfilled" ? missing.value.length : previous.missing,
        // 旧桩 / 旧后端可能 resolve 成 undefined:当作没读到,保留上一次。
        musicDone: music.status === "fulfilled" && music.value ? music.value.done : previous.musicDone,
        musicTotal: music.status === "fulfilled" && music.value ? music.value.total : previous.musicTotal,
        musicActive:
          music.status === "fulfilled" && music.value ? music.value.running + music.value.pending : previous.musicActive,
        proxyDone:
          progress.status === "fulfilled" && typeof progress.value.proxy_total === "number"
            ? progress.value.proxy_total - (progress.value.proxy_pending ?? 0)
            : previous.proxyDone,
        proxyTotal: progress.status === "fulfilled" && typeof progress.value.proxy_total === "number" ? progress.value.proxy_total : previous.proxyTotal,
        proxyActive:
          progress.status === "fulfilled" && typeof progress.value.proxy_pending === "number" ? progress.value.proxy_pending : previous.proxyActive,
        cleanup: progress.status === "fulfilled" ? (progress.value.cleanup_pending ?? 0) : previous.cleanup,
        regenerating: progress.status === "fulfilled" ? (progress.value.derived_pending ?? 0) : previous.regenerating,
        pausedReason: progress.status === "fulfilled" ? (progress.value.paused_reason ?? null) : previous.pausedReason,
      }));
    };

    const schedule = () => {
      timer = setTimeout(run, POLL_INTERVAL_MS);
    };
    const run = () => {
      // 窗口不可见就停表,别让后台标签页每 3 秒敲一次后端。
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      void poll().finally(() => {
        if (active) schedule();
      });
    };

    run();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // X-04:每条素材分析完就刷新一次计数(不等 3 秒轮询),估算器才拿得到连续样本;
    // 100 ms 内的多条完成合并成一次。桥在这里挂:状态条是唯一的听众。
    let coalesce: ReturnType<typeof setTimeout> | undefined;
    const onProbeDone = () => {
      if (coalesce !== undefined) return;
      coalesce = setTimeout(() => {
        coalesce = undefined;
        if (active) void poll();
      }, PROBE_EVENT_COALESCE_MS);
    };
    window.addEventListener(IMPORT_PROBE_DONE_EVENT, onProbeDone);
    let unbridge: (() => void) | null = null;
    void bridgeImportProbeEvents().then((stop) => {
      if (active) unbridge = stop;
      else stop();
    });
    // R18 W-4:启动补扫现在跑在开窗之后,后端在开始 / 结束各发一次事件。
    // 结束时顺手再 poll 一次:补扫入队的活这时才出现在队列里。
    // 测试桩 / 旧后端可能根本没有这个出口,也可能 resolve 出非函数——两种都当没订阅。
    let unlistenBackfill: (() => void) | null = null;
    void Promise.resolve(
      onStartupBackfill?.((running) => {
        if (!active) return;
        setSummary((previous) => ({ ...previous, startupBackfill: running }));
        if (!running) void poll();
      }),
    )
      .then((stop) => {
        if (typeof stop !== "function") return;
        if (active) unlistenBackfill = stop;
        else stop();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      if (coalesce !== undefined) clearTimeout(coalesce);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(IMPORT_PROBE_DONE_EVENT, onProbeDone);
      unbridge?.();
      unlistenBackfill?.();
    };
  }, []);

  const analysisDone = summary.analyzeTotal > 0 && summary.analyzed >= summary.analyzeTotal;
  return { summary, eta, showAnalysis: !analysisDone || (doneAt !== null && !lingerOver) };
}

/** 右端的素材库状态点:当前库名 + 一颗绿点(规格 §3.6)。读不到就退回「本地项目」。 */
function useLibraryName(): string {
  const [name, setName] = useState("本地项目");
  useEffect(() => {
    let active = true;
    // 经 Promise 包一层:测试桩没有 list_libraries 时同步抛的 TypeError 也落进 catch。
    Promise.resolve()
      .then(() => listLibraries())
      .then((registry) => {
        const current = registry.libraries.find((library) => library.id === registry.active);
        if (active && current?.name) setName(current.name);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return name;
}

export function StatusStrip({ composing }: { composing?: boolean } = {}): JSX.Element {
  const { summary, eta, showAnalysis } = useBackgroundSummary();
  const libraryName = useLibraryName();
  // R19 接线:红点的数据源是壳里 ToolchainStatusProbe 发布的那一份(useToolchainStatus),
  // 状态条不再自己轮询 getSettingsStatus;红点只在这里渲染一处。
  const toolchainMissing = useToolchainStatus().missing;
  // U-04/P-10:导入即有地图——「已导入 N 条 · 共 X 分钟」用的是 useClipsFeed 这份
  // 全应用唯一的素材订阅(媒体池/镜头带已经在用,这里不多一次网络拉取)。
  const feed = useClipsFeed();
  const importedDurationMs = useMemo(
    () => feed.clips.reduce((total, clip) => total + (clipDurationSeconds(clip) ?? 0) * 1_000, 0),
    [feed.clips],
  );
  const summaryWithImportMap: BackgroundSummary =
    feed.clips.length > 0 ? { ...summary, importedCount: feed.clips.length, importedDurationMs } : summary;
  const visible = summaryPhrases(summaryWithImportMap, eta).filter((phrase) => showAnalysis || !isAnalysisPhrase(phrase));
  // 「分析完成」收起后别留一条空的状态条。
  const phrases = visible.length > 0 ? visible : ["后台空闲"];
  // V-08:真空闲(只剩兜底句「后台空闲」、没有缺失素材)时,「查看详情/全部暂停」都不占位。
  const idle = phrases.every((phrase) => phrase === "后台空闲") && summary.missing === 0;
  // 默认读 useRatingHotkeys 的全局真值;显式传 prop 时以 prop 为准(便于单测与复用)。
  const indicator = useComposingIndicator();
  const imeComposing = composing ?? indicator;

  const analysing = summary.analyzeTotal > 0;
  const analysisDone = analysing && summary.analyzed >= summary.analyzeTotal;
  const progress = analysing ? Math.round((summary.analyzed / summary.analyzeTotal) * 100) : 0;

  return (
    <div role="status" aria-label="后台状态" className="workspace-status">
      {/* R18 V-27:五组信息此前平铺无节奏(警告色与强调色同排)。分三组:
          左 = 后台任务、中 = 更新、右 = 素材库,组间 --space-4。分组容器都是
          `display: contents` 之外的普通 span —— role=status 的可读文本顺序不变。 */}
      <span className="workspace-status-group workspace-status-group--tasks">
      {toolchainMissing ? (
        <Button
          variant="ghost"
          size="sm"
          className="workspace-status-toolchain"
          aria-label="视频处理组件缺失"
          title="导入和导出都要靠它;去设置里安装"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "settings", section: "tools" })}
        >
          <span className="workspace-status-dot" aria-hidden="true" />
          视频处理组件缺失
        </Button>
      ) : null}
      {!idle ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            icon="info"
            className="workspace-status-main"
            onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "jobs" })}
          >
            查看后台任务详情
          </Button>
          {/* R16 P1-6:主按钮旁「全部暂停 / 继续」。 */}
          <StatusPause />
        </>
      ) : null}
      <span className="workspace-status-phrases">
        {phrases
          .filter((phrase) => !phrase.startsWith("缺失素材"))
          .map((phrase) => {
            const isAnalysis = isAnalysisPhrase(phrase);
            return (
              <span
                key={phrase}
                className={isAnalysis && analysisDone ? "workspace-status-phrase done" : "workspace-status-phrase"}
              >
                <Icon name={isAnalysis ? (analysisDone ? "check" : "play") : phrase.startsWith("云端生成") ? "deliver" : "info"} size={12} />
                {isAnalysis ? (
                  <span
                    className="workspace-status-progress"
                    aria-hidden="true"
                    style={{ "--progress": `${progress}%` } as CSSProperties}
                  />
                ) : null}
                {phrase}
              </span>
            );
          })}
      </span>
      {summary.missing > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          icon="warning"
          className="workspace-status-phrase link"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "missing" })}
        >
          {`缺失素材 ${summary.missing}`}
        </Button>
      ) : null}
      </span>
      <span className="workspace-status-group workspace-status-group--update">
        {/* R17 车道 B:「正在下载更新 42%」/「更新已下载 · 重启完成更新」。 */}
        <UpdateStatusChip />
        {/* R19 P-06(models 车道):「正在下载画面理解模型 42%」;只在下载中出现,也是模型 store 的宿主。 */}
        <ModelStatusPhrase />
      </span>
      <span className="workspace-status-group workspace-status-group--library">
        {/* 规格 §3.2 的「中文输入法组合中」提示条槽位;真值由 useRatingHotkeys 灌入。 */}
        <span className="workspace-status-ime" data-slot="ime-composing" aria-live="polite">
          {imeComposing ? "中文输入法组合中" : null}
        </span>
        <span className="workspace-status-library" title="当前素材库">
          <span className="workspace-status-check" aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
          {libraryName}
        </span>
      </span>
    </div>
  );
}
