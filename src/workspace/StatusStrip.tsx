import { useEffect, useState, type CSSProperties, type JSX } from "react";
import { getImportProgress, listGenerationRequests, listLibraries, listMissingClips } from "../api";
import { useComposingIndicator } from "./useRatingHotkeys";
import { Button, Icon } from "./ui";
import { dispatchWorkspace } from "./WorkspaceStore";

export interface BackgroundSummary {
  analyzed: number;
  analyzeTotal: number;
  transcribing: number;
  generating: number;
  missing: number;
}

const EMPTY_SUMMARY: BackgroundSummary = {
  analyzed: 0,
  analyzeTotal: 0,
  transcribing: 0,
  generating: 0,
  missing: 0,
};

const POLL_INTERVAL_MS = 3_000;

/** 纯函数:按存在性依次生成中文短语,全 0 时返回 ["后台空闲"]。 */
export function summaryPhrases(summary: BackgroundSummary): string[] {
  const phrases: string[] = [];
  if (summary.analyzeTotal > 0) phrases.push(`分析 ${summary.analyzed}/${summary.analyzeTotal}`);
  if (summary.transcribing > 0) phrases.push(`转写 ${summary.transcribing}`);
  if (summary.generating > 0) phrases.push(`云端生成 ${summary.generating} 排队`);
  if (summary.missing > 0) phrases.push(`缺失素材 ${summary.missing}`);
  return phrases.length > 0 ? phrases : ["后台空闲"];
}

function useBackgroundSummary(): BackgroundSummary {
  const [summary, setSummary] = useState<BackgroundSummary>(EMPTY_SUMMARY);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const [progress, missing, generation] = await Promise.allSettled([
        getImportProgress(),
        listMissingClips(),
        listGenerationRequests(),
      ]);
      if (!active) return;
      setSummary((previous) => ({
        // 某一条读失败时保留上一次的值 —— 状态条闪回 0 会被当成「后台空了」。
        analyzed: progress.status === "fulfilled" ? progress.value.done : previous.analyzed,
        analyzeTotal: progress.status === "fulfilled" ? progress.value.total : previous.analyzeTotal,
        // 没有独立的转写进度命令;把导入队列的 running 说成「转写」是假话,
        // 所以这里先留 0,等后端有分阶段进度再接。
        transcribing: 0,
        generating:
          generation.status === "fulfilled"
            ? generation.value.filter((item) => item.status === "queued" || item.status === "submitted")
                .length
            : previous.generating,
        missing: missing.status === "fulfilled" ? missing.value.length : previous.missing,
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
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return summary;
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
  const summary = useBackgroundSummary();
  const libraryName = useLibraryName();
  const phrases = summaryPhrases(summary);
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
            const isAnalysis = phrase.startsWith("分析 ");
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
