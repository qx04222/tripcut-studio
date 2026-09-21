import type { JSX } from "react";
import type { ExportStatus } from "../../api";
import { Badge, Button, Card, Icon } from "../ui";
import { isExportActive } from "./deliverModel";
import { folderDisplayName } from "./quickExportModel";
import {
  PHOTO_EXPORT_EMPTY_BODY,
  PHOTO_EXPORT_EMPTY_TITLE,
  PHOTO_EXPORT_LABEL,
  PHOTO_EXPORT_LEAD_LINE,
  photoDoneLine,
  photoFolderLine,
  type PhotoExport,
} from "./usePhotoExport";

export interface PhotoExportPanelProps {
  photos: PhotoExport;
  status: ExportStatus;
}

/** 照片逐张状态:文件名 + 备注 + 状态(失败红)。只用照片的词,不借视频交付卡。 */
function PhotoItemList({ status, onlyFailed = false }: { status: ExportStatus; onlyFailed?: boolean }): JSX.Element | null {
  const items = onlyFailed ? status.items.filter((item) => item.status === "failed") : status.items;
  if (items.length === 0) return null;
  return (
    <ul className="deliver-job-items" aria-label="照片逐张状态">
      {items.map((item) => (
        <li key={`${item.clip_id}-${item.output_name}`} className={`deliver-job-item deliver-job-item--${item.status}`}>
          <span className="deliver-job-item-copy">
            <span className="deliver-job-item-name">{item.file_name}</span>
            {item.note ? <span className="deliver-job-item-note">{item.note}</span> : null}
          </span>
          <Badge tone={item.status === "failed" ? "danger" : item.status === "done" ? "accent" : "neutral"}>
            {item.status === "failed" ? "没导出来" : item.status === "done" ? "已复制" : item.status === "running" ? "复制中" : "等待"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * 照片工作台的导出正文(R21 照片线):一句话「收藏、3 星以上和擂台选出的照片…」+ 编号清单;
 * 进行中换成「正在复制 n / m」;完成换成「已导出 n 张照片」结果卡。没有平台 / 粗剪 / 镜头表 / 剪映。
 */
export function PhotoExportPanel({ photos, status }: PhotoExportPanelProps): JSX.Element {
  const active = isExportActive(status);
  const processed = status.completed_items + status.failed_items;

  if (active) {
    const percent = status.selected_count === 0 ? 0 : Math.min(100, Math.round((processed / status.selected_count) * 100));
    return (
      <section className="kit-export photo-export" aria-label={PHOTO_EXPORT_LABEL}>
        <p className="kit-export-lead">正在复制到「{folderDisplayName(photos.lastDir ?? "")}」</p>
        <Card className="deliver-progress-card" padding={4} aria-live="polite">
          <div className="deliver-progress-head">
            <span className="deliver-progress-stage">正在复制照片</span>
            <span className="deliver-progress-count">{processed} / {status.selected_count}</span>
          </div>
          <div className="deliver-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={status.selected_count} aria-valuenow={processed}>
            <span className="deliver-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="deliver-progress-note">{status.failed_items > 0 ? `${status.failed_items} 张没导出来 · ` : ""}原片只读,不会被改动</p>
          <PhotoItemList status={status} />
        </Card>
      </section>
    );
  }

  if (photos.done) {
    return (
      <section className="kit-export photo-export" aria-label={PHOTO_EXPORT_LABEL}>
        <Card className="kit-export-result deliver-result deliver-result--ok" padding={4} role="status">
          <span className="deliver-result-icon">
            <Icon name="check" size={16} />
          </span>
          <div className="deliver-result-copy">
            <p className="deliver-result-title">{photoDoneLine(status)}</p>
            {status.output_path ? <code className="deliver-result-path">{status.output_path}</code> : null}
            <p className="deliver-result-meta">原件与伴随文件一起复制;HEIC / RAW 另转出一份 JPG;顺序见「顺序.txt」。</p>
          </div>
          <div className="kit-export-result-actions">
            <Button variant="secondary" size="sm" onClick={() => void photos.reveal()}>
              在 Finder 中显示
            </Button>
          </div>
          <PhotoItemList status={status} onlyFailed />
        </Card>
      </section>
    );
  }

  if (status.status === "failed" || status.status === "blocked") {
    return (
      <section className="kit-export photo-export" aria-label={PHOTO_EXPORT_LABEL}>
        <Card className="deliver-result deliver-result--danger" padding={4}>
          <span className="deliver-result-icon">
            <Icon name="warning" size={16} />
          </span>
          <div className="deliver-result-copy">
            <p className="deliver-result-title">导出失败</p>
            {status.error ? (
              <p className="deliver-result-meta" role="alert">
                {status.error}
              </p>
            ) : null}
          </div>
        </Card>
      </section>
    );
  }

  if (photos.planError || (photos.plan !== null && photos.plan.files.length === 0)) {
    return (
      <section className="kit-export photo-export" aria-label={PHOTO_EXPORT_LABEL}>
        <Card className="quick-export-empty" padding={4}>
          <p className="quick-export-empty-title">{PHOTO_EXPORT_EMPTY_TITLE}</p>
          <p className="quick-export-empty-body">{PHOTO_EXPORT_EMPTY_BODY}</p>
        </Card>
      </section>
    );
  }

  const missing = photos.plan?.missing ?? [];
  return (
    <section className="kit-export photo-export" aria-label={PHOTO_EXPORT_LABEL}>
      <p className="kit-export-lead">{PHOTO_EXPORT_LEAD_LINE}</p>
      {missing.length > 0 ? (
        <p className="deliver-result-meta" role="alert">有 {missing.length} 张原片不在原位:{missing.join("、")}。先找回它们再导出。</p>
      ) : null}
      <Card className="quick-export-list-card" padding={4}>
        <p className="quick-export-summary">
          {photos.plan ? `${photos.plan.files.length} 张照片` : "正在整理清单…"} · 附「顺序.txt」
        </p>
        {photos.plan ? (
          <ol className="quick-export-list kit-export-list" aria-label="将导出的照片">
            {photos.plan.files.map((name) => (
              <li key={name} className="quick-export-file">
                <Icon name="film" size={12} />
                <span className="quick-export-file-name">{name}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {photos.plan && photos.plan.dir ? <p className="quick-export-folder">文件夹：{folderDisplayName(photos.plan.dir)}</p> : null}
      </Card>
    </section>
  );
}

export interface PhotoExportFooterProps {
  photos: PhotoExport;
  status: ExportStatus;
  onClose(): void;
}

/** 页脚:「导出到 <上次文件夹>」+ 「更改文件夹…」+ 主按钮「导出精选照片」。 */
export function PhotoExportFooter({ photos, status, onClose }: PhotoExportFooterProps): JSX.Element {
  const active = isExportActive(status);
  const processed = status.completed_items + status.failed_items;
  const percent = status.selected_count === 0 ? 0 : Math.min(100, Math.round((processed / status.selected_count) * 100));
  const line = photos.error
    ? { text: photos.error, tone: "danger", alert: true }
    : active
      ? { text: `正在复制 · ${processed} / ${status.selected_count}`, tone: "neutral", alert: false }
      : photos.done
        ? status.failed_items > 0
          ? { text: `${photoDoneLine(status)}。腾出空间或换个文件夹后再导一次。`, tone: "danger", alert: true }
          : { text: "导完了。原片没动,文件夹里是复制出来的一份。", tone: "neutral", alert: false }
        : { text: photoFolderLine(photos.lastDir), tone: "neutral", alert: false };

  return (
    <footer className={`deliver-footer${active ? " deliver-footer--active" : ""}`}>
      {active ? <span className="deliver-footer-progress" style={{ width: `${percent}%` }} aria-hidden="true" /> : null}
      <p className={`deliver-footer-status deliver-footer-status--${line.tone}`} role={line.alert ? "alert" : "status"}>
        {line.text}
      </p>
      <div className="deliver-footer-actions">
        <Button variant="ghost" tone={active ? "danger" : "neutral"} onClick={active ? () => void photos.cancel() : onClose}>
          {active ? "取消" : "关闭"}
        </Button>
        {!active ? (
          <Button variant="ghost" aria-label="更改文件夹" onClick={() => void photos.changeFolder()}>
            更改文件夹…
          </Button>
        ) : null}
        <Button
          variant="primary"
          icon="deliver"
          busy={photos.busy}
          disabled={!photos.canExport}
          aria-label="导出精选照片到上次文件夹"
          title={photos.lastDir ? `导出到 ${photos.lastDir}` : "先选一个文件夹,以后记住"}
          onClick={() => void photos.exportNow()}
        >
          {photos.lastDir ? PHOTO_EXPORT_LABEL : `${PHOTO_EXPORT_LABEL}…`}
        </Button>
      </div>
    </footer>
  );
}
