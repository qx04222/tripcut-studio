import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import {
  getCurrentEpisode,
  getMusicAnalysis,
  listMusicTracks,
  type MusicAnalysis,
} from "../api";
import { BAND_SEGMENT_PITCH } from "./shotBandModel";

/**
 * 音乐模式的 36px 刻度轨(规格 §3.4)。刻度与镜头带共用**同一条序号轴**:
 * 每个分段固定一个节距(BAND_SEGMENT_PITCH),整首曲子按比例铺满整条镜头序列,刻度轨再跟着镜头带的
 * `scrollLeft` 平移。百分比是错的 —— 刻度轨和镜头带宽度不同,同一个百分比落在
 * 两条不同的像素轴上,看起来对齐其实差着半屏(R8 复审 M4)。
 *
 * 这条轨是**只读建议**:点刻度只做定位(派一个 seek 事件),不写任何数据 ——
 * 音乐切点是给人看的参考,不是自动剪辑的指令。
 */

export const MUSIC_RULER_HEIGHT = 36;

/** 一个分段在序号轴上占的像素宽 —— 就是镜头带瓦片的节距(160 瓦片 + 8 间距)。 */
export const RULER_SEGMENT_WIDTH = BAND_SEGMENT_PITCH;

function axisPx(tick: number, totalTicks: number, segmentCount: number): number {
  if (totalTicks <= 0) return 0;
  return (tick / totalTicks) * segmentCount * RULER_SEGMENT_WIDTH;
}

/**
 * 节拍点与段落分界落在**序号轴**上的哪个像素。
 * `suggestedTicks` 省略时退回段落分界 —— 段落切换本就是最保守的建议切点。
 */
export function rulerMarks(
  beatsTicks: readonly number[],
  sectionsTicks: readonly number[],
  totalTicks: number,
  segmentCount: number,
  suggestedTicks?: readonly number[],
): { beats: number[]; sections: number[]; suggestions: number[] } {
  const within = (tick: number) => tick >= 0 && (totalTicks <= 0 || tick <= totalTicks);
  const at = (tick: number) => axisPx(tick, totalTicks, Math.max(0, segmentCount));
  return {
    beats: beatsTicks.filter(within).map(at),
    sections: sectionsTicks.filter(within).map(at),
    suggestions: (suggestedTicks ?? sectionsTicks).filter(within).map(at),
  };
}

export function MusicRuler({
  segmentCount,
  scrollLeft,
}: {
  /** 镜头带上的分段总数 —— 序号轴的长度就是它 × 120px。 */
  segmentCount: number;
  /** 镜头带视口的横向滚动位置;刻度轨用同一个值做 translate。 */
  scrollLeft: number;
}): JSX.Element {
  const [analysis, setAnalysis] = useState<MusicAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const episode = await getCurrentEpisode();
        if (!episode) return;
        const tracks = await listMusicTracks(episode.id);
        const ready = tracks.find((track) => track.analysis_status === "done") ?? tracks[0];
        if (!ready) return;
        const next = await getMusicAnalysis(ready.id);
        if (mounted.current) setAnalysis(next);
      } catch (cause) {
        if (mounted.current) setError(String(cause));
      }
    })();
  }, []);

  const marks = useMemo(() => {
    if (!analysis) return { beats: [], sections: [], suggestions: [] };
    const total = analysis.track.duration_ticks ?? 0;
    return rulerMarks(
      analysis.beats.map((beat) => beat.tick),
      analysis.sections.map((section) => section.start_tick),
      total,
      segmentCount,
      analysis.suggested_cut_ticks,
    );
  }, [analysis, segmentCount]);

  if (error) {
    return (
      <div className="band-ruler" style={{ height: MUSIC_RULER_HEIGHT }}>
        <p className="band-ruler-empty">音乐分析未载入：{error}</p>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="band-ruler" style={{ height: MUSIC_RULER_HEIGHT }}>
        <p className="band-ruler-empty">本集还没有已分析的音乐</p>
      </div>
    );
  }

  return (
    <div
      className="band-ruler"
      role="img"
      aria-label={`音乐刻度轨 · ${analysis.track.file_name}`}
      style={{ height: MUSIC_RULER_HEIGHT }}
    >
      <div
        className="band-ruler-track"
        data-testid="ruler-track"
        style={{
          width: segmentCount * RULER_SEGMENT_WIDTH,
          transform: `translateX(${-scrollLeft}px)`,
        }}
      >
        {marks.beats.map((left, index) => (
          <span className="band-ruler-beat" key={`beat-${index}`} style={{ left: `${left}px` }} />
        ))}
        {marks.sections.map((left, index) => (
          <span className="band-ruler-section" key={`section-${index}`} style={{ left: `${left}px` }} />
        ))}
        {marks.suggestions.map((left, index) => (
          <button
            type="button"
            className={`band-ruler-suggestion${cursor === left ? " active" : ""}`}
            data-testid="ruler-suggestion"
            key={`suggestion-${index}`}
            style={{ left: `${left}px` }}
            aria-label={`建议切点 第 ${(left / RULER_SEGMENT_WIDTH + 1).toFixed(1)} 个分段处`}
            onClick={() => {
              // 只定位:标一下光标,再把位置广播给监视器。一行数据都不写。
              setCursor(left);
              const span = Math.max(1, segmentCount * RULER_SEGMENT_WIDTH);
              window.dispatchEvent(
                new CustomEvent("tripcut:seek-ratio", { detail: { ratio: left / span } }),
              );
            }}
          >
            △
          </button>
        ))}
      </div>
      <span className="band-ruler-legend">建议</span>
    </div>
  );
}
