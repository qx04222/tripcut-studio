import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import {
  deleteMusicTrack,
  getCurrentEpisode,
  getMusicAnalysis,
  importMusicTrack,
  listMusicTracks,
  pickMusicFile,
  type MusicAnalysis,
  type MusicSection,
  type MusicTrackSummary,
} from "./api";
import { Button, EmptyState, SectionHeader } from "./workspace/ui";

const SECTION_LABELS: Record<MusicSection["label"], string> = {
  intro: "前奏",
  verse: "主歌",
  build: "推进",
  climax: "高潮",
  outro: "尾声",
  other: "其他",
};

const STATUS_LABELS: Record<MusicTrackSummary["analysis_status"], string> = {
  pending: "分析排队中…",
  running: "分析中…",
  done: "已分析",
  failed: "分析失败",
};

export function sectionLabel(label: MusicSection["label"]): string {
  return SECTION_LABELS[label];
}

/** 把 tick（按曲目自身 timebase）格式化成 mm:ss.mmm，供「已复制切点」提示使用。 */
export function formatCutTime(tick: number, tbNum: number, tbDen: number): string {
  if (tbNum <= 0 || tbDen <= 0) return "0:00.000";
  const totalSeconds = (tick * tbNum) / tbDen;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

const POLL_INTERVAL_MS = 3_000;

/**
 * `variant="band"` 是 R9 新壳镜头带附属区里的皮:栏标题条 / 按钮 / 空状态走套件,
 * 没有英文 kicker。数据流、api 调用顺序、AX 名(`音乐与节奏`、`导入音乐`、
 * `.music-track-select` 等 class 锚点)两种皮完全一样;`page` 是旧故事板页的原样。
 */
export function MusicPanel({ readOnly, variant = "page" }: { readOnly: boolean; variant?: "page" | "band" }) {
  const [episodeId, setEpisodeId] = useState<number | null>(null);
  const [tracks, setTracks] = useState<MusicTrackSummary[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<MusicAnalysis | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshTracks = useCallback(async (targetEpisodeId: number) => {
    try {
      const next = await listMusicTracks(targetEpisodeId);
      if (!mounted.current) return;
      setTracks(next);
    } catch (error) {
      if (!mounted.current) return;
      setNotice(`音乐列表未载入：${String(error)}`);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void getCurrentEpisode()
      .then(async (episode) => {
        if (!active) return;
        setEpisodeId(episode.id);
        await refreshTracks(episode.id);
      })
      .catch((error) => {
        if (active) setNotice(`当前集未载入：${String(error)}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshTracks]);

  const loadAnalysis = useCallback((trackId: number) => {
    getMusicAnalysis(trackId)
      .then((next) => {
        if (!mounted.current) return;
        setAnalysis(next);
      })
      .catch((error) => {
        if (!mounted.current) return;
        setNotice(`节拍分析未载入：${String(error)}`);
      });
  }, []);

  const selectTrack = (trackId: number) => {
    setSelectedTrackId(trackId);
    setAnalysis(null);
    setCopiedNotice(null);
    loadAnalysis(trackId);
  };

  // 轮询：仅在选中曲目分析仍在 pending/running 时每 3 秒重取一次，卸载或切换选中即清理。
  useEffect(() => {
    if (!selectedTrackId) return;
    if (!analysis || !["pending", "running"].includes(analysis.track.analysis_status)) return;
    const timer = window.setInterval(() => loadAnalysis(selectedTrackId), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [analysis, loadAnalysis, selectedTrackId]);

  const onImport = async () => {
    if (readOnly || importing || episodeId === null) return;
    setImporting(true);
    try {
      const path = await pickMusicFile();
      if (!path) return;
      const track = await importMusicTrack(path);
      await refreshTracks(episodeId);
      setNotice(`已导入「${track.file_name}」`);
    } catch (error) {
      setNotice(`导入失败：${String(error)}`);
    } finally {
      if (mounted.current) setImporting(false);
    }
  };

  const confirmDelete = async (trackId: number) => {
    if (readOnly || episodeId === null) return;
    try {
      await deleteMusicTrack(trackId);
      setPendingDeleteId(null);
      if (selectedTrackId === trackId) {
        setSelectedTrackId(null);
        setAnalysis(null);
      }
      await refreshTracks(episodeId);
      setNotice("已删除该音乐");
    } catch (error) {
      setNotice(`删除失败：${String(error)}`);
    }
  };

  const copyCut = (tick: number) => {
    if (!analysis) return;
    const label = formatCutTime(tick, analysis.track.tb_num, analysis.track.tb_den);
    setCopiedNotice(`已复制切点 ${label}`);
  };

  const kit = variant === "band";
  const action = (label: ReactNode, onClick: () => void, extra: { disabled?: boolean; className?: string; tone?: "neutral" | "danger" } = {}): JSX.Element =>
    kit ? (
      <Button variant="ghost" size="sm" tone={extra.tone} className={extra.className} disabled={extra.disabled} onClick={onClick}>
        {label}
      </Button>
    ) : (
      <button type="button" className={extra.className} disabled={extra.disabled} onClick={onClick}>
        {label}
      </button>
    );

  if (loading) {
    return <div className="music-panel-empty">正在装载音乐列表…</div>;
  }

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? null;
  const duration = analysis?.track.duration_ticks ?? 0;
  const importDisabled = readOnly || importing || episodeId === null;
  const importLabel = importing ? "导入中…" : "导入音乐";
  // 套件皮:有曲目时「导入音乐」在栏标题条右侧;没有曲目时它是空状态的唯一动作 ——
  // 同一屏永远只有一颗同名按钮。
  const importButton = kit ? (
    <Button variant="secondary" size="sm" icon="import" busy={importing} disabled={importDisabled} onClick={() => void onImport()}>
      {importLabel}
    </Button>
  ) : null;

  return (
    <div className={kit ? "music-panel music-panel--band" : "music-panel"} aria-label="音乐与节奏">
      {kit ? (
        <SectionHeader
          size="pane"
          title="音乐与节奏"
          meta={tracks.length > 0 ? `${tracks.length} 首` : undefined}
          actions={tracks.length > 0 ? importButton : undefined}
        />
      ) : (
        <header className="music-panel-header">
          <span>MUSIC / 音乐与节奏</span>
          <button type="button" disabled={importDisabled} onClick={() => void onImport()}>
            {importLabel}
          </button>
        </header>
      )}
      {readOnly ? <p className="read-only-notice">历史集为只读档案</p> : null}
      {notice ? <p className="music-panel-notice" aria-live="polite">{notice}</p> : null}
      <ul className="music-track-list">
        {tracks.map((track) => (
          <li
            key={track.id}
            className={`music-track${track.id === selectedTrackId ? " selected" : ""}`}
          >
            <button type="button" className="music-track-select" onClick={() => selectTrack(track.id)}>
              <strong>{track.file_name}</strong>
              <small>{track.bpm !== null ? `${Math.round(track.bpm)} BPM` : STATUS_LABELS[track.analysis_status]}</small>
            </button>
            {!readOnly && pendingDeleteId === track.id ? (
              <span className="music-track-delete-confirm">
                <span>确认删除「{track.file_name}」？</span>
                {action("确认删除", () => void confirmDelete(track.id), { tone: "danger" })}
                {action("取消", () => setPendingDeleteId(null))}
              </span>
            ) : !readOnly ? (
              action("删除", () => setPendingDeleteId(track.id), { className: "music-track-delete" })
            ) : null}
          </li>
        ))}
        {tracks.length === 0 && !kit ? <li className="music-track-empty">还没有导入音乐</li> : null}
      </ul>
      {tracks.length === 0 && kit ? (
        <EmptyState
          icon="volume"
          size="inline"
          className="music-tracks-empty"
          title="还没有导入音乐"
          body="导入一首配乐后,节拍、段落与切点建议会标在镜头带上方的刻度轨上。"
          action={importButton}
        />
      ) : null}
      {selectedTrack && analysis ? (
        <div className="music-analysis">
          <div className="music-analysis-summary">
            <strong>{analysis.track.bpm !== null ? `${Math.round(analysis.track.bpm)} BPM` : STATUS_LABELS[analysis.track.analysis_status]}</strong>
            {analysis.track.blocked_summary ? <small>{analysis.track.blocked_summary}</small> : null}
          </div>
          <svg
            className="music-strip"
            role="img"
            aria-label="节拍与段落"
            viewBox={`0 0 ${Math.max(duration, 1)} 100`}
            preserveAspectRatio="none"
          >
            {analysis.sections.map((section) => (
              <rect
                key={`${section.start_tick}-${section.end_tick}`}
                className={`music-section-band music-section-${section.label}`}
                x={section.start_tick}
                width={Math.max(section.end_tick - section.start_tick, 1)}
                y={0}
                height={100}
              >
                <title>{sectionLabel(section.label)}</title>
              </rect>
            ))}
            {analysis.beats.map((beat) => (
              <line
                key={beat.tick}
                className={`music-beat${beat.is_downbeat ? " downbeat" : ""}`}
                x1={beat.tick}
                x2={beat.tick}
                y1={beat.is_downbeat ? 0 : 45}
                y2={100}
              />
            ))}
            {analysis.suggested_cut_ticks.map((tick) => (
              <line
                key={`cut-${tick}`}
                className="music-cut-marker"
                data-tick={tick}
                role="button"
                aria-label={`切点建议 ${formatCutTime(tick, analysis.track.tb_num, analysis.track.tb_den)}`}
                x1={tick}
                x2={tick}
                y1={0}
                y2={100}
                onClick={() => copyCut(tick)}
              />
            ))}
          </svg>
          <p className="music-section-legend">
            {analysis.sections.map((section, index) => (
              <span key={index} className={`music-section-${section.label}`}>{sectionLabel(section.label)}</span>
            ))}
          </p>
          {copiedNotice ? <p className="music-copied-notice" aria-live="polite">{copiedNotice}</p> : null}
          <p className="music-panel-note">节拍、段落与切点仅作建议，点击切点只复制时间，不改写任何已存在片段。</p>
        </div>
      ) : kit && tracks.length > 0 ? (
        <EmptyState
          icon="play"
          size="inline"
          className="music-analysis-hint"
          title={selectedTrack ? "正在读取节拍分析…" : "选一首曲目"}
          body="节拍、段落与切点建议会显示在这里,并标到镜头带上方的刻度轨。"
        />
      ) : null}
    </div>
  );
}
