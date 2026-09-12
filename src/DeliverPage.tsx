import type { ExportStatus, JianyingAvailability, JianyingDraftResult, RoughCutTargetSeconds, TargetPlatform } from "./api";
import {
  PLATFORM_LABELS,
  PLATFORM_OPTIONS,
  ROUGH_CUT_TARGET_LABELS,
  ROUGH_CUT_TARGET_OPTIONS,
  STAGE_LABELS,
  formatDuration,
  itemStatusLabel,
  roughCutTargetKey,
  type TargetSecondsOption,
} from "./workspace/deliver/deliverModel";
import { useDeliverForm } from "./workspace/deliver/useDeliverForm";
import { useExportProgress } from "./workspace/deliver/useExportProgress";

// 常量与纯函数(R9 Task 6a)移到 `workspace/deliver/deliverModel.ts`,这里 re-export 给既有调用方。
export {
  PLATFORM_LABELS,
  ROUGH_CUT_TARGET_LABELS,
  ROUGH_CUT_TARGET_OPTIONS,
  STAGE_LABELS,
  closestTargetWithinBudget,
  formatDuration,
  itemStatusLabel,
  presetBudgetSeconds,
  type TargetSecondsOption,
} from "./workspace/deliver/deliverModel";

interface DeliverViewProps {
  status: ExportStatus;
  destination: string | null;
  busy: boolean;
  error: string | null;
  jianying: JianyingAvailability;
  nativeBusy: boolean;
  nativeResult: JianyingDraftResult | null;
  nativeNotice: string | null;
  episodePlatform: TargetPlatform;
  overridePlatform: TargetPlatform;
  includeContactSheet: boolean;
  targetSeconds: TargetSecondsOption;
  onOverridePlatformChange: (platform: TargetPlatform) => void;
  onIncludeContactSheetChange: (include: boolean) => void;
  onTargetSecondsChange: (targetSeconds: TargetSecondsOption) => void;
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
  episodePlatform,
  overridePlatform,
  includeContactSheet,
  targetSeconds,
  onOverridePlatformChange,
  onIncludeContactSheetChange,
  onTargetSecondsChange,
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

      <label className="deliver-platform-override" aria-label="本次交付平台">
        本次交付平台
        <select
          value={overridePlatform}
          onChange={(event) => onOverridePlatformChange(event.currentTarget.value as TargetPlatform)}
        >
          {PLATFORM_OPTIONS.map((platform) => (
            <option key={platform} value={platform}>
              {PLATFORM_LABELS[platform]}
              {platform === episodePlatform ? "(本集设置)" : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="deliver-rough-cut-target" aria-label="参考粗剪时长">
        参考粗剪时长
        <select
          value={roughCutTargetKey(targetSeconds)}
          onChange={(event) => {
            const key = event.currentTarget.value;
            onTargetSecondsChange(key === "full" ? null : (Number(key) as RoughCutTargetSeconds));
          }}
        >
          {ROUGH_CUT_TARGET_OPTIONS.map((option) => (
            <option key={roughCutTargetKey(option)} value={roughCutTargetKey(option)}>
              {ROUGH_CUT_TARGET_LABELS[roughCutTargetKey(option)]}
            </option>
          ))}
        </select>
      </label>

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
          <label className="deliver-content-card deliver-contact-sheet-toggle" aria-label="联系表.pdf">
            <span>03</span>
            <div>
              <strong>
                <input
                  type="checkbox"
                  checked={includeContactSheet}
                  onChange={(event) => onIncludeContactSheetChange(event.currentTarget.checked)}
                />
                联系表.pdf
              </strong>
              <p>A4 网格联系表，封面缩略图 + 序号/入出点/章节，按本次交付平台的画布方向排横版或竖版。</p>
            </div>
          </label>
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
  const progress = useExportProgress();
  const form = useDeliverForm(progress);

  return (
    <DeliverView
      status={progress.status}
      destination={form.destination}
      busy={form.busy}
      error={form.error}
      jianying={form.jianying}
      nativeBusy={form.nativeBusy}
      nativeResult={form.nativeResult}
      nativeNotice={form.nativeNotice}
      episodePlatform={form.episodePlatform}
      overridePlatform={form.overridePlatform}
      includeContactSheet={form.includeContactSheet}
      targetSeconds={form.targetSeconds}
      onOverridePlatformChange={form.setOverridePlatform}
      onIncludeContactSheetChange={form.setIncludeContactSheet}
      onTargetSecondsChange={form.setTargetSeconds}
      onGenerate={() => void form.generate()}
      onGenerateNative={() => void form.generateNative()}
      onCancel={() => void form.cancel()}
      onReveal={() => void form.reveal()}
    />
  );
}
