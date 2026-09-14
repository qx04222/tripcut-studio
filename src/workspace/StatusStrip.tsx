import { useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import {
  IMPORT_PROBE_DONE_EVENT,
  bridgeImportProbeEvents,
  getImportProgress,
  getMusicAnalysisProgress,
  listGenerationRequests,
  listLibraries,
  listMissingClips,
  type ImportProgress,
} from "../api";
import { useComposingIndicator } from "./useRatingHotkeys";
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

const isAnalysisPhrase = (phrase: string): boolean => phrase.startsWith("正在分析 ") || phrase.startsWith("分析完成 ");

/** 纯函数:按存在性依次生成中文短语,全 0 时返回 ["后台空闲"]。`eta` 是估好的剩余时间文案(估不出传 null)。 */
export function summaryPhrases(summary: BackgroundSummary, eta: string | null = null): string[] {
  const phrases: string[] = [];
  if (summary.analyzeTotal > 0) phrases.push(analysisPhrase(summary.analyzed, summary.analyzeTotal, eta, summary.analyzeFailed ?? 0));
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
  return phrases.length > 0 ? phrases : ["后台空闲"];
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
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      if (coalesce !== undefined) clearTimeout(coalesce);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(IMPORT_PROBE_DONE_EVENT, onProbeDone);
      unbridge?.();
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
  const visible = summaryPhrases(summary, eta).filter((phrase) => showAnalysis || !isAnalysisPhrase(phrase));
  // 「分析完成」收起后别留一条空的状态条。
  const phrases = visible.length > 0 ? visible : ["后台空闲"];
  // 默认读 useRatingHotkeys 的全局真值;显式传 prop 时以 prop 为准(便于单测与复用)。
  const indicator = useComposingIndicator();
  const imeComposing = composing ?? indicator;

  const analysing = summary.analyzeTotal > 0;
  const analysisDone = analysing && summary.analyzed >= summary.analyzeTotal;
  const progress = analysing ? Math.round((summary.analyzed / summary.analyzeTotal) * 100) : 0;

  return (
    <div role="status" aria-label="后台状态" className="workspace-status">
      <Button
        variant="ghost"
        size="sm"
        icon="info"
        className="workspace-status-main"
        onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "jobs" })}
      >
        查看后台任务详情
      </Button>
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
    </div>
  );
}
