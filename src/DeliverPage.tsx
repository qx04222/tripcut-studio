import { useCallback, useEffect, useMemo, useState } from "react";

import {
  cancelExport,
  generateJianyingDraft,
  getExportStatus,
  getJianyingAvailability,
  pickExportFolder,
  revealExport,
  startExport,
  type ExportStatus,
  type JianyingAvailability,
  type JianyingDraftResult,
} from "./api";

const EMPTY_STATUS: ExportStatus = {
  job_id: null,
  status: "idle",
  stage: "idle",
  selected_count: 0,
  selected_segment_count: 0,
  selected_whole_count: 0,
  total_duration_seconds: 0,
  completed_items: 0,
  failed_items: 0,
  items: [],
  output_path: null,
  error: null,
};

const CHECKING_JIANYING: JianyingAvailability = {
  installed_version: null,
  supported: false,
  reason: "正在检测剪映版本与草稿目录…",
};

const STAGE_LABELS: Record<ExportStatus["stage"], string> = {
  idle: "等待生成",
  queued: "已加入队列",
  remuxing: "整理精选片段",
  rough_cut: "生成参考粗剪",
  documents: "写入交付文档",
  finalizing: "完成原子交付",
  cancelling: "正在取消",
  cancelled: "已取消",
  complete: "交付完成",
  failed: "交付失败",
};

function formatDuration(totalSeconds: number): string {
  const rounded = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function itemStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "处理中";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return "等待中";
  }
}

interface DeliverViewProps {
  status: ExportStatus;
  destination: string | null;
  busy: boolean;
  error: string | null;
  jianying: JianyingAvailability;
  nativeBusy: boolean;
  nativeResult: JianyingDraftResult | null;
  nativeNotice: string | null;
  onGenerate: () => void;
  onGenerateNative: () => void;
  onCancel: () => void;
  onReveal: () => void;
}

export function DeliverView({
  status,
  destination,
  busy,
  error,
  jianying,
  nativeBusy,
  nativeResult,
  nativeNotice,
  onGenerate,
  onGenerateNative,
  onCancel,
  onReveal,
}: DeliverViewProps) {
  const processed = status.completed_items + status.failed_items;
  const percent =
    status.selected_count === 0
      ? 0
      : Math.min(100, Math.round((processed / status.selected_count) * 100));
  const active = status.status === "pending" || status.status === "running";
  const canGenerate = !busy && !active && status.selected_count > 0;
  const canGenerateNative =
    jianying.supported && !nativeBusy && !active && status.selected_count > 0;

  return (
    <section className="deliver-panel" aria-label="剪映交付">
      <div className="deliver-summary">
        <div className="deliver-stat primary">
          <span>DELIVERY ITEMS / 交付项</span>
          <strong>{status.selected_count}</strong>
          <small>{status.selected_segment_count} 段精选片段 · {status.selected_whole_count} 条整条收藏</small>
        </div>
        <div className="deliver-stat">
          <span>ESTIMATED DURATION / 预计交付时长</span>
          <strong>{formatDuration(status.total_duration_seconds)}</strong>
          <small>精选段按区间、整条收藏按原时长计算</small>
        </div>
        <div className="deliver-action-card">
          <span>STABLE PACKAGE / 稳定包</span>
          <strong>{status.output_path ?? destination ?? "选择保存位置后生成"}</strong>
          <div className="deliver-actions">
            <button
              className="deliver-primary-button"
              type="button"
              onClick={onGenerate}
              disabled={!canGenerate}
            >
              {busy ? "正在选择…" : "生成交付包"}
            </button>
            {active && status.job_id !== null ? (
              <button className="deliver-secondary-button danger" type="button" onClick={onCancel}>
                取消
              </button>
            ) : null}
            {status.status === "done" && status.job_id !== null ? (
              <button className="deliver-secondary-button" type="button" onClick={onReveal}>
                在访达中显示
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="jianying-draft-card" aria-label="剪映原生草稿实验功能">
        <div>
          <span>NATIVE DRAFT / 实验功能</span>
          <strong>剪映原生草稿</strong>
          <p>{nativeResult?.message ?? nativeNotice ?? jianying.reason}</p>
          {nativeResult ? <small title={nativeResult.output_path}>{nativeResult.output_path}</small> : null}
        </div>
        <button
          className="deliver-secondary-button"
          type="button"
          onClick={onGenerateNative}
          disabled={!canGenerateNative}
          title={jianying.supported ? "只新增一份草稿，不会修改剪映既有草稿" : jianying.reason}
        >
          {nativeBusy ? "正在生成并回读自检…" : "生成剪映草稿（实验）"}
        </button>
      </div>

      {status.selected_count === 0 && !active ? (
        <div className="deliver-notice warning" role="status">
          还没有交付项。请先在播放器保存精选片段，或到筛片页用 F 收藏整条素材。
        </div>
      ) : null}
      {error || status.error ? (
        <div className="deliver-notice danger" role="alert">
          {error ?? status.error}
        </div>
      ) : null}

      <div className="deliver-progress" aria-live="polite">
        <div className="deliver-progress-heading">
          <span>{STAGE_LABELS[status.stage]}</span>
          <strong>{active ? `${processed} / ${status.selected_count}` : `${percent}%`}</strong>
        </div>
        <div
          className="deliver-progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={status.selected_count}
          aria-valuenow={processed}
        >
          <span style={{ width: `${status.status === "done" ? 100 : percent}%` }} />
        </div>
        <div className="deliver-progress-meta">
          <span>{status.completed_items} 完成</span>
          <span className={status.failed_items > 0 ? "has-failures" : undefined}>
            {status.failed_items} 失败
          </span>
          <span>单条失败不会中断整包</span>
        </div>
      </div>

      {status.items.length > 0 ? (
        <div className="deliver-item-list" aria-label="交付逐条状态">
          {status.items.map((item, index) => (
            <div
              className={`deliver-item ${item.status}${item.warning ? " warning" : ""}`}
              key={`${item.clip_id}-${item.output_name}`}
            >
              <span className="deliver-item-index">{String(index + 1).padStart(3, "0")}</span>
              <span className="deliver-item-copy">
                <strong>{item.file_name}</strong>
                <small title={item.note ?? item.output_name}>{item.note ?? item.output_name}</small>
              </span>
              <span className="deliver-item-status">{itemStatusLabel(item.status)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="deliver-contents" aria-label="交付包内容">
          <PackagePart index="01" title="精选片段" body="打点片段帧精确重编码并回读 PTS；无片段的收藏素材整条 remux。" />
          <PackagePart index="02" title="参考粗剪" body="按拍摄时间顺序，统一生成 1080p H.264/AAC 文件。" />
          <PackagePart index="03" title="镜头表 CSV" body="UTF-8 BOM，含章节、故事顺序、画面参数、星级、L1 角标和失败备注。" />
          <PackagePart index="04" title="交付说明" body="一屏中文说明，告诉你如何把稳定包带入剪映。" />
        </div>
      )}
    </section>
  );
}

function PackagePart({ index, title, body }: { index: string; title: string; body: string }) {
  return (
    <div className="deliver-content-card">
      <span>{index}</span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  );
}

export function DeliverPage() {
  const [status, setStatus] = useState<ExportStatus>(EMPTY_STATUS);
  const [jobId, setJobId] = useState<number | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jianying, setJianying] = useState<JianyingAvailability>(CHECKING_JIANYING);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeResult, setNativeResult] = useState<JianyingDraftResult | null>(null);
  const [nativeNotice, setNativeNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getJianyingAvailability()
      .then((next) => {
        if (active) setJianying(next);
      })
      .catch((availabilityError) => {
        if (active) {
          setJianying({
            installed_version: null,
            supported: false,
            reason: `剪映兼容性检测失败：${String(availabilityError)}`,
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const next = await getExportStatus(jobId);
    setStatus(next);
    if (next.job_id !== null && jobId === null) setJobId(next.job_id);
  }, [jobId]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const next = await getExportStatus(jobId);
        if (!active) return;
        setStatus(next);
        if (next.job_id !== null && jobId === null) setJobId(next.job_id);
        setError(null);
      } catch (pollError) {
        if (active) setError(String(pollError));
      }
    };
    void poll();
    const interval = status.status === "pending" || status.status === "running" ? 750 : 2_000;
    const timer = window.setInterval(() => void poll(), interval);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [jobId, status.status]);

  useEffect(() => {
    let active = true;
    const resetForEpisode = () => {
      setJobId(null);
      setStatus(EMPTY_STATUS);
      setNativeResult(null);
      setError(null);
      void getExportStatus(null)
        .then((next) => {
          if (!active) return;
          setStatus(next);
          setJobId(next.job_id);
        })
        .catch((episodeError) => {
          if (active) setError(String(episodeError));
        });
    };
    window.addEventListener("tripcut:episode-changed", resetForEpisode);
    return () => {
      active = false;
      window.removeEventListener("tripcut:episode-changed", resetForEpisode);
    };
  }, []);

  useEffect(() => {
    const onAction = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "deliver-export") void generate();
    };
    window.addEventListener("tripcut:action", onAction);
    return () => window.removeEventListener("tripcut:action", onAction);
  });

  useEffect(() => {
    const active = status.status === "pending" || status.status === "running";
    window.dispatchEvent(new CustomEvent("tripcut:deliver-availability", {
      detail: !busy && !active && status.selected_count > 0,
    }));
    return () => {
      window.dispatchEvent(new CustomEvent("tripcut:deliver-availability", { detail: false }));
    };
  }, [busy, status.selected_count, status.status]);

  const generate = async () => {
    const active = status.status === "pending" || status.status === "running";
    if (busy || active || status.selected_count === 0) return;
    setBusy(true);
    setError(null);
    try {
      const selected = await pickExportFolder();
      if (!selected) return;
      setDestination(selected);
      const started = await startExport(selected);
      setStatus(started);
      setJobId(started.job_id);
    } catch (startError) {
      setError(String(startError));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (status.job_id === null) return;
    setError(null);
    try {
      await cancelExport(status.job_id);
      await refresh();
    } catch (cancelError) {
      setError(String(cancelError));
    }
  };

  const generateNative = async () => {
    setNativeBusy(true);
    setNativeResult(null);
    setNativeNotice(null);
    setError(null);
    try {
      const result = await generateJianyingDraft();
      setNativeResult(result);
    } catch (nativeError) {
      const reason = String(nativeError);
      setNativeNotice(`原生草稿未通过自检：${reason}。请选择位置后自动降级为稳定交付包。`);
      try {
        const selected = await pickExportFolder();
        if (!selected) {
          setError(`${reason}；未选择稳定包保存位置，尚未生成降级交付。`);
          return;
        }
        setDestination(selected);
        const started = await startExport(selected);
        setStatus(started);
        setJobId(started.job_id);
        setNativeNotice(`原生草稿未通过自检，已降级并开始生成稳定交付包。原因：${reason}`);
      } catch (fallbackError) {
        setError(`原生草稿失败：${reason}；稳定包降级也未能启动：${String(fallbackError)}`);
      }
    } finally {
      setNativeBusy(false);
    }
  };

  const reveal = async () => {
    if (status.job_id === null) return;
    setError(null);
    try {
      await revealExport(status.job_id);
    } catch (revealError) {
      setError(String(revealError));
    }
  };

  const view = useMemo(
    () => ({ status, destination, busy, error, jianying, nativeBusy, nativeResult, nativeNotice }),
    [status, destination, busy, error, jianying, nativeBusy, nativeResult, nativeNotice],
  );

  return (
    <DeliverView
      {...view}
      onGenerate={() => void generate()}
      onGenerateNative={() => void generateNative()}
      onCancel={() => void cancel()}
      onReveal={() => void reveal()}
    />
  );
}
