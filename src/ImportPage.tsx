import { ImportManagement } from "./ImportManagement";
import { AnalysisBadges, AnalysisPanel } from "./AnalysisPanel";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from "react";

import {
  getClipArtifacts,
  getImportProgress,
  listClips,
  pickImportFolder,
  startImport,
  type ArtifactStatus,
  type ClipArtifacts,
  type ClipListItem,
  type ImportProgress,
  type WaveformData,
  getSettingsStatus,
  getCurrentEpisode,
  listWatchedFolders,
  setWatchedFolderSync,
  removeWatchedFolder,
  rescanWatchedFolders,
  type WatchedFolder,
} from "./api";

const ROW_HEIGHT = 66;
const DETAIL_HEIGHT = 198;
const OVERSCAN_ROWS = 5;
const EMPTY_PROGRESS: ImportProgress = { total: 0, done: 0, failed: 0, running: 0 };

export function formatDuration(clip: ClipListItem): string {
  if (
    clip.duration_ticks === null ||
    clip.tb_num === null ||
    clip.tb_den === null ||
    clip.tb_den === 0
  ) {
    return "—";
  }
  const seconds = Math.round(Math.max(0, (clip.duration_ticks * clip.tb_num) / clip.tb_den));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function formatFps(clip: ClipListItem): string {
  if (clip.fps_num === null || clip.fps_den === null || clip.fps_den === 0) {
    return "—";
  }
  const fps = clip.fps_num / clip.fps_den;
  return Number.isInteger(fps) ? `${fps}` : fps.toFixed(2);
}

function formatResolution(clip: ClipListItem): string {
  return clip.width !== null && clip.height !== null ? `${clip.width}×${clip.height}` : "—";
}

function formatCaptureDate(value: string | null): string {
  if (!value) return "—";
  return value.replace("T", " ").replace(/\.\d+Z$/, "Z").slice(0, 16);
}

function ClipStatus({ clip }: { clip: ClipListItem }) {
  if (clip.status === "unreadable") {
    return (
      <span className="clip-badge danger" title={clip.error ?? undefined}>
        不可读
      </span>
    );
  }
  if (clip.status === "duplicate") {
    return (
      <span className="clip-badge muted" title={clip.error ?? undefined}>
        已存在
      </span>
    );
  }
  if (clip.is_vfr) {
    return <span className="clip-badge" title="可变帧率素材:时间映射已按采样表处理,可正常使用">VFR</span>;
  }
  return <span className="clip-badge ready">就绪</span>;
}

export function LazyCover({ src, alt }: { src: string | null; alt: string }) {
  const boundaryRef = useRef<HTMLSpanElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (!src || inView) return;
    const boundary = boundaryRef.current;
    if (!boundary || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "120px 0px" },
    );
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [inView, src]);

  if (!src) {
    return <span className="clip-cover skeleton" aria-hidden="true" />;
  }
  return (
    <span className="clip-cover-boundary" ref={boundaryRef} data-cache-src={src}>
      {inView ? (
        <img
          className="clip-cover"
          src={src}
          alt={alt}
          crossOrigin="anonymous"
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        <span className="clip-cover skeleton" aria-hidden="true" />
      )}
    </span>
  );
}

function statusLabel(status: ArtifactStatus): string {
  switch (status) {
    case "pending":
      return "等待生成";
    case "running":
      return "正在生成";
    case "ready":
      return "已就绪";
    case "direct":
      return "原片直读";
    case "failed":
      return "生成失败";
    default:
      return "尚未生成";
  }
}

function WaveformCanvas({ url, status }: { url: string | null; status: ArtifactStatus }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!url) {
      setWaveform(null);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    setFailed(false);
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`waveform HTTP ${response.status}`);
        return (await response.json()) as WaveformData;
      })
      .then((value) => {
        if (value.version !== 1 || value.bins !== 2_000 || value.peaks.length !== 2_000) {
          throw new Error("waveform schema mismatch");
        }
        setWaveform(value);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          console.warn("waveform request failed", requestError);
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, [url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveform) return;

    const draw = () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const styles = getComputedStyle(canvas);
      context.strokeStyle = styles.getPropertyValue("--waveform-midline").trim();
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, height / 2 + 0.5);
      context.lineTo(width, height / 2 + 0.5);
      context.stroke();

      context.strokeStyle = styles.getPropertyValue("--accent").trim();
      const halfHeight = height / 2 - 5;
      const step = width / waveform.peaks.length;
      context.beginPath();
      waveform.peaks.forEach(([minimum, maximum], index) => {
        const x = (index + 0.5) * step;
        context.moveTo(x, height / 2 - maximum * halfHeight);
        context.lineTo(x, height / 2 - minimum * halfHeight);
      });
      context.stroke();
    };

    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [waveform]);

  if (!url || failed) {
    return (
      <div className={`waveform-placeholder ${failed ? "failed" : ""}`}>
        <span>{failed ? "波形读取失败" : statusLabel(status)}</span>
      </div>
    );
  }
  return (
    <canvas
      ref={canvasRef}
      className={waveform ? "waveform-canvas" : "waveform-canvas loading"}
      role="img"
      aria-label="素材音频波形"
    />
  );
}

function ArtifactDetail({
  clip,
  artifacts,
  loading,
  error,
}: {
  clip: ClipListItem;
  artifacts: ClipArtifacts | null;
  loading: boolean;
  error: string | null;
}) {
  const stripStatus = artifacts?.statuses.strip ?? "pending";
  const waveformStatus = artifacts?.statuses.waveform ?? "pending";
  return (
    <div className="artifact-detail" role="row" aria-label={`${clip.file_name} 预览产物`}>
      <div className="artifact-heading">
        <span>CONTACT SHEET / 胶片条</span>
        <small>{error ?? (loading ? "正在读取缓存状态" : statusLabel(stripStatus))}</small>
      </div>
      <div className="filmstrip-stage">
        {artifacts?.strip ? (
          <img
            src={artifacts.strip}
            alt={`${clip.file_name} 胶片条`}
            crossOrigin="anonymous"
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : (
          <div className="filmstrip-skeleton" aria-label={statusLabel(stripStatus)}>
            {Array.from({ length: 8 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
        )}
      </div>
      <div className="waveform-row">
        <span className="waveform-label">AUDIO</span>
        <WaveformCanvas url={artifacts?.waveform ?? null} status={waveformStatus} />
        <span className={`artifact-state ${waveformStatus}`}>{statusLabel(waveformStatus)}</span>
      </div>
    </div>
  );
}

function rowTop(index: number, selectedIndex: number | null): number {
  return index * ROW_HEIGHT + (selectedIndex !== null && index > selectedIndex ? DETAIL_HEIGHT : 0);
}

function rowIndexAtOffset(offset: number, selectedIndex: number | null): number {
  if (selectedIndex === null) return Math.floor(offset / ROW_HEIGHT);
  const detailStart = (selectedIndex + 1) * ROW_HEIGHT;
  if (offset < detailStart) return Math.floor(offset / ROW_HEIGHT);
  if (offset < detailStart + DETAIL_HEIGHT) return selectedIndex;
  return Math.floor((offset - DETAIL_HEIGHT) / ROW_HEIGHT);
}

export function VirtualClipList({
  clips,
  viewportHeight = 396,
  checkedIds = [],
  onCheck,
}: {
  clips: ClipListItem[];
  viewportHeight?: number;
  checkedIds?: number[];
  onCheck?: (id: number) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [artifacts, setArtifacts] = useState<ClipArtifacts | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const selectedIndex =
    selectedId === null ? -1 : clips.findIndex((clip) => clip.id === selectedId);
  const normalizedSelectedIndex = selectedIndex >= 0 ? selectedIndex : null;
  const selectedClip = normalizedSelectedIndex === null ? null : clips[normalizedSelectedIndex];
  const startIndex = Math.max(
    0,
    rowIndexAtOffset(scrollTop, normalizedSelectedIndex) - OVERSCAN_ROWS,
  );
  const endIndex = Math.min(
    clips.length,
    rowIndexAtOffset(scrollTop + viewportHeight, normalizedSelectedIndex) + OVERSCAN_ROWS + 2,
  );
  const visibleClips = clips.slice(startIndex, endIndex);

  useEffect(() => {
    if (selectedId !== null && normalizedSelectedIndex === null) {
      setSelectedId(null);
      setArtifacts(null);
    }
  }, [normalizedSelectedIndex, selectedId]);

  useEffect(() => {
    if (selectedId === null) return;
    let active = true;
    let firstRequest = true;
    let timer: number | undefined;
    const refreshArtifacts = async () => {
      if (firstRequest) setArtifactLoading(true);
      try {
        const next = await getClipArtifacts(selectedId);
        if (active) {
          setArtifacts(next);
          setArtifactError(null);
        }
      } catch (requestError) {
        if (active) setArtifactError(String(requestError));
      } finally {
        if (active) setArtifactLoading(false);
        firstRequest = false;
        if (active) timer = window.setTimeout(() => void refreshArtifacts(), 2_000);
      }
    };
    setArtifacts(null);
    setArtifactError(null);
    void refreshArtifacts();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [selectedId]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  const selectClip = (clip: ClipListItem) => {
    if (clip.id === null || clip.status !== "ready") return;
    setSelectedId((current) => (current === clip.id ? null : clip.id));
  };

  const handleRowKey = (event: KeyboardEvent<HTMLDivElement>, clip: ClipListItem) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectClip(clip);
    }
  };

  const canvasHeight =
    clips.length * ROW_HEIGHT + (normalizedSelectedIndex === null ? 0 : DETAIL_HEIGHT);

  return (
    <div className="clip-table" role="table" aria-label="已扫描素材">
      <div
        className="clip-viewport"
        style={{ height: viewportHeight }}
        onScroll={handleScroll}
        data-total-rows={clips.length}
      >
      <div className="clip-table-head" role="row">
        <span role="columnheader">素材</span>
        <span role="columnheader">时长</span>
        <span role="columnheader">画面</span>
        <span role="columnheader">编码 / FPS</span>
        <span role="columnheader">拍摄时间</span>
        <span role="columnheader">L1 质量</span>
        <span role="columnheader">状态</span>
      </div>
        <div className="clip-virtual-canvas" style={{ height: canvasHeight }}>
          {visibleClips.map((clip, visibleIndex) => {
            const index = startIndex + visibleIndex;
            const selected = clip.id !== null && clip.id === selectedId;
            return (
              <div
                className={["clip-row", clip.status, selected ? "selected" : null]
                  .filter(Boolean)
                  .join(" ")}
                role="row"
                aria-rowindex={index + 2}
                aria-selected={selected}
                tabIndex={clip.id !== null && clip.status === "ready" ? 0 : -1}
                key={`${clip.id ?? clip.status}-${clip.path}-${index}`}
                style={{
                  height: ROW_HEIGHT,
                  transform: `translateY(${rowTop(index, normalizedSelectedIndex)}px)`,
                }}
                onClick={() => selectClip(clip)}
                onKeyDown={(event) => handleRowKey(event, clip)}
              >
                <span className={`clip-identity${onCheck && clip.id !== null ? " selectable" : ""}`} role="cell">
                  {onCheck && clip.id !== null ? <input type="checkbox" aria-label={`选择 ${clip.file_name}`} checked={checkedIds.includes(clip.id)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onChange={() => onCheck(clip.id!)} /> : null}
                  <LazyCover src={clip.cover_url} alt={`${clip.file_name} 封面`} />
                  <span className="clip-name" title={clip.path}>
                    <strong>{clip.file_name}</strong>
                    <small>{clip.error ?? clip.path}</small>
                  </span>
                </span>
                <span role="cell">{formatDuration(clip)}</span>
                <span role="cell">{formatResolution(clip)}</span>
                <span role="cell">
                  {(clip.codec ?? "—").toUpperCase()} / {formatFps(clip)}
                </span>
                <span role="cell">{formatCaptureDate(clip.captured_at)}</span>
                <span className="clip-analysis-cell" role="cell">
                  <AnalysisBadges clip={clip} compact />
                  {clip.analysis ? (
                    <small className="scene-count">{clip.analysis.scene_count} 片段</small>
                  ) : null}
                </span>
                <span role="cell">
                  <ClipStatus clip={clip} />
                </span>
              </div>
            );
          })}
          {selectedClip && normalizedSelectedIndex !== null ? (
            <div
              className="artifact-detail-position"
              style={{
                height: DETAIL_HEIGHT,
                transform: `translateY(${rowTop(normalizedSelectedIndex, normalizedSelectedIndex) + ROW_HEIGHT}px)`,
              }}
            >
              <ArtifactDetail
                clip={selectedClip}
                artifacts={artifacts}
                loading={artifactLoading}
                error={artifactError}
              />
            </div>
          ) : null}
        </div>
      </div>
      {selectedClip ? (
        <AnalysisPanel clip={selectedClip} onClose={() => setSelectedId(null)} />
      ) : null}
    </div>
  );
}

export function ImportPage() {
  const [progress, setProgress] = useState<ImportProgress>(EMPTY_PROGRESS);
  const [toolchainMissing, setToolchainMissing] = useState(false);
  const [watched, setWatched] = useState<WatchedFolder[]>([]);
  const [watchNotice, setWatchNotice] = useState<string | null>(null);

  const refreshWatched = useCallback(async () => {
    setWatched(await listWatchedFolders().catch(() => []));
  }, []);

  useEffect(() => {
    void refreshWatched();
  }, [refreshWatched]);

  useEffect(() => {
    void getSettingsStatus()
      .then((status) => setToolchainMissing(!status.ffmpeg.available || !status.ffprobe.available))
      .catch(() => setToolchainMissing(false));
  }, []);
  const [clips, setClips] = useState<ClipListItem[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [checkedIds, setCheckedIds] = useState<number[]>([]);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshRequest = useRef(0);

  const refresh = useCallback(async (isActive: () => boolean = () => true) => {
    const request = ++refreshRequest.current;
    const [nextProgress, nextClips, currentEpisode] = await Promise.all([
      getImportProgress(),
      listClips(),
      getCurrentEpisode(),
    ]);
    if (!isActive() || request !== refreshRequest.current) return;
    setProgress(nextProgress);
    setClips(nextClips.filter((clip) => clip.episode_id === currentEpisode.id));
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let inFlight = false;
    const pageVisible = () => document.visibilityState !== "hidden";
    const poll = async () => {
      if (!active || inFlight || !pageVisible()) return;
      inFlight = true;
      try {
        await refresh(() => active);
        if (active) setRefreshError(null);
      } catch (pollError) {
        if (active) setRefreshError(String(pollError));
      } finally {
        inFlight = false;
        if (active && pageVisible()) timer = window.setTimeout(() => void poll(), 1_500);
      }
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (pageVisible()) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      ++refreshRequest.current;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const onAction = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "import-pick") void chooseFolder();
    };
    window.addEventListener("tripcut:action", onAction);
    return () => window.removeEventListener("tripcut:action", onAction);
  });

  const chooseFolder = async () => {
    setChoosing(true);
    setError(null);
    setNotice(null);
    try {
      const selected = await pickImportFolder();
      if (!selected) return;
      setFolder(selected);
      const started = await startImport(selected);
      const duplicateNote = started.skipped > 0 ? `，跳过 ${started.skipped} 项已入库或已排队素材（可能属于其他集）` : "";
      setNotice(`已发现 ${started.total} 个视频，新增 ${started.enqueued} 项${duplicateNote}`);
      await refresh();
    } catch (importError) {
      setError(String(importError));
    } finally {
      setChoosing(false);
    }
  };

  const readyClips = useMemo(() => clips.filter((clip) => clip.status === "ready"), [clips]);
  const quality = analysisProgress(readyClips, "analysis");
  const motion = analysisProgress(readyClips, "motion");
  const completed = progress.done + progress.failed;
  const percent = progress.total === 0 ? 0 : Math.round((completed / progress.total) * 100);
  const pending = Math.max(0, progress.total - completed - progress.running);
  const summary = useMemo(
    () => `${clips.filter((clip) => clip.status === "ready").length} 条可用素材`,
    [clips],
  );

  return (
    <section className="import-panel" aria-label="素材导入">
      {toolchainMissing ? (
        <div className="toolchain-warning" role="alert">
          <span>应用内置的媒体工具不可用，暂时无法解析画面与时长。请重新安装完整 DMG；开发调试时也可到设置页「工具链」填写可信的自定义路径。</span>
          <a href="#/settings">去设置 →</a>
        </div>
      ) : null}
      <div className="import-toolbar">
        <div className="import-source">
          <span className="source-label">SOURCE / 引用式导入</span>
          <strong title={folder ?? undefined}>
            {folder ?? (watched.length > 0 ? `已关注 ${watched.length} 个素材文件夹` : "尚未选择素材文件夹")}
          </strong>
          <small>只建立索引，不复制或改写原片</small>
        </div>
        <button
          className="import-button"
          type="button"
          onClick={() => void chooseFolder()}
          disabled={choosing}
        >
          <span aria-hidden="true">＋</span>
          {choosing ? "正在扫描…" : folder ? "选择其他文件夹" : "选择素材文件夹"}
        </button>
      </div>

      {progress.total > 0 && progress.done + progress.failed === progress.total && progress.running === 0 ? (
        <div className="import-done-cta">
          <span>{progress.failed > 0
            ? `索引结束，${progress.failed} 项未能导入；可先筛选已就绪素材`
            : "素材索引已完成，可开始筛片；后台分析进度见下方"}</span>
          <a href="#/review">进入筛片工作台 →</a>
        </div>
      ) : null}
      {watched.length > 0 ? (
        <div className="watched-folders" aria-label="已关注的素材文件夹">
          <header>
            <span>WATCHED / 已关注的素材文件夹</span>
            <small>子文件夹名会自动成为素材分类;开启自动同步后每 5 分钟增量检查新素材(适合 NAS/云盘)</small>
            <button
              type="button"
              onClick={() => {
                setWatchNotice("正在扫描…");
                void rescanWatchedFolders()
                  .then((outcome) => {
                    // NAS 断线时必须说清「没扫成」,不能显示成「没有新素材」
                    const parts: string[] = [];
                    if (outcome.enqueued > 0) parts.push(`发现 ${outcome.enqueued} 条新素材,已开始导入`);
                    else if (outcome.scanned > 0) parts.push("没有新素材");
                    if (outcome.unavailable > 0) {
                      parts.push(`${outcome.unavailable} 个文件夹当前不可用(未挂载或已移除),本轮未扫描`);
                    }
                    setWatchNotice(parts.join(";") || "没有可扫描的关注文件夹");
                  })
                  .then(refreshWatched)
                  .catch((error) => setWatchNotice(String(error)));
              }}
            >立即扫描</button>
          </header>
          {watchNotice ? <p className="watched-notice">{watchNotice}</p> : null}
          {watched.map((folder) => (
            <div className="watched-folder-row" key={folder.id}>
              <strong title={folder.path}>{folder.path}</strong>
              <small>{folder.last_scan_at ? `上次同步 ${folder.last_scan_at.slice(0, 16).replace("T", " ")}` : "尚未自动同步"}</small>
              <label className="suspect-filter">
                <input
                  type="checkbox"
                  checked={folder.auto_sync}
                  onChange={(event) => {
                    const next = event.currentTarget.checked;
                    void setWatchedFolderSync(folder.id, next).then(refreshWatched).catch((error) => setWatchNotice(String(error)));
                  }}
                />
                <span aria-hidden="true" />
                自动同步
              </label>
              <button
                type="button"
                className="watched-remove"
                title="仅取消关注,已导入素材不受影响"
                onClick={() => void removeWatchedFolder(folder.id).then(refreshWatched).catch((error) => setWatchNotice(String(error)))}
              >移除</button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="import-progress" aria-live="polite">
        <div className="progress-copy">
          <span>
            <strong>{completed}</strong> / {progress.total} 已处理
          </span>
          <span>
            {progress.running > 0 ? `${progress.running} 正在探测` : `${pending} 等待中`} · {summary}
          </span>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={completed}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="progress-stats">
          <span>{percent}%</span>
          <span className={progress.failed > 0 ? "has-failures" : undefined}>
            {progress.done} 完成 · {progress.failed} 失败
          </span>
        </div>
      </div>

      {readyClips.length > 0 ? (
        <div className="analysis-progress-summary" aria-label="当前集分析进度">
          <AnalysisStage label="画质分析" progress={quality} total={readyClips.length} />
          <AnalysisStage label="运镜分析" progress={motion} total={readyClips.length} />
          <p>封面出现后即可筛片。分析在后台继续；失败原因可点击素材查看。</p>
        </div>
      ) : null}
      {refreshError ? <div className="import-message error" role="status">刷新暂时失败，正在重试：{refreshError}</div> : null}
      {error ? <div className="import-message error" role="alert">{error}</div> : null}
      {!error && notice ? <div className="import-message">{notice}</div> : null}

      <ImportManagement selectedIds={checkedIds.filter((id) => clips.some((clip) => clip.id === id))} onChanged={() => {
        setCheckedIds([]);
        void refresh().then(() => refreshWatched()).catch((e) => setError(String(e)));
        window.dispatchEvent(new Event("tripcut:library-changed"));
      }} />
      {clips.length > 0 ? (
        <VirtualClipList clips={clips} checkedIds={checkedIds} onCheck={(id) => setCheckedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])} />
      ) : (
        <div className="import-empty">
          <span aria-hidden="true">01</span>
          <div>
            <strong>等待第一批素材</strong>
            <p>选择相机卡、移动硬盘或本地文件夹后，元数据会在这里逐条出现。</p>
          </div>
        </div>
      )}
    </section>
  );
}

export function analysisProgress(clips: ClipListItem[], kind: "analysis" | "motion") {
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

function AnalysisStage({ label, progress, total }: {
  label: string;
  progress: ReturnType<typeof analysisProgress>;
  total: number;
}) {
  return (
    <div className="analysis-stage">
      <strong>{label}</strong>
      <span>{progress.done} / {total} 完成</span>
      <span>{progress.running} 处理中 · {progress.waiting} 等待</span>
      {progress.failed > 0 ? <span className="analysis-stage-failed">{progress.failed} 失败</span> : null}
    </div>
  );
}
