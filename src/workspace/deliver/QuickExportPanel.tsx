import type { JSX } from "react";
import type { ExportStatus } from "../../api";
import { Button, Card, Icon } from "../ui";
import { STAGE_LABELS, formatDuration, isExportActive } from "./deliverModel";
import { DeliverProgressCard } from "./DeliverProgressCard";
import { DeliverItemList } from "./DeliverProgressCard";
import { folderDisplayName, quickDoneLine, quickLeadLine, selectionCount } from "./quickExportModel";
import type { QuickExport } from "./useQuickExport";

export interface QuickExportPanelProps {
  quick: QuickExport;
  status: ExportStatus;
}

/**
 * 交付抽屉「快速导出」模式的正文(R11 §2,业主原则「开包即用」):一句话说清
 * 「这些片段会导出到 <文件夹>」+ 将写的文件清单;进行中换成进度卡,完成换成
 * 「已导出 n 个文件 · 在 Finder 中显示」。没有粗剪 / 联系表 / 剪映区。
 */
export function QuickExportPanel({ quick, status }: QuickExportPanelProps): JSX.Element {
  const active = isExportActive(status);
  const picked = selectionCount(quick.selection);

  if (active) {
    return (
      <section className="quick-export" aria-label="快速导出">
        <p className="quick-export-lead">正在导出到「{folderDisplayName(quick.lastDir ?? "")}」</p>
        <DeliverProgressCard status={status} />
      </section>
    );
  }

  if (quick.done) {
    return (
      <section className="quick-export" aria-label="快速导出">
        <Card className="quick-export-toast deliver-result deliver-result--ok" padding={4} role="status">
          <span className="deliver-result-icon">
            <Icon name="check" size={16} />
          </span>
          <div className="deliver-result-copy">
            <p className="deliver-result-title">{quickDoneLine(status)}</p>
            {status.output_path ? <code className="deliver-result-path">{status.output_path}</code> : null}
          </div>
          <Button variant="secondary" size="sm" icon="deliver" onClick={() => void quick.reveal()}>
            在 Finder 中显示
          </Button>
          <DeliverItemList items={status.items.filter((item) => item.status === "failed")} />
        </Card>
      </section>
    );
  }

  if (status.status === "failed" || status.status === "blocked") {
    return (
      <section className="quick-export" aria-label="快速导出">
        <Card className="deliver-result deliver-result--danger" padding={4}>
          <span className="deliver-result-icon">
            <Icon name="warning" size={16} />
          </span>
          <div className="deliver-result-copy">
            <p className="deliver-result-title">{STAGE_LABELS.failed}</p>
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

  if (quick.planError || status.selected_count === 0) {
    return (
      <section className="quick-export" aria-label="快速导出">
        <Card className="quick-export-empty" padding={4}>
          <p className="quick-export-empty-title">还没有可导出的片段</p>
          <p className="quick-export-empty-body">在播放器打上入出点后点「保存片段」，或在媒体池按 F 收藏整条素材，再回来导出。</p>
        </Card>
      </section>
    );
  }

  return (
    <section className="quick-export" aria-label="快速导出">
      <p className="quick-export-lead">{quickLeadLine(quick.plan, status, quick.lastDir)}</p>
      {quick.selection ? (
        <p className="quick-export-scope">
          只导出你选的 {picked} 项
          <Button variant="ghost" size="sm" onClick={quick.clearSelection}>
            改为导出全部
          </Button>
        </p>
      ) : null}
      <Card className="quick-export-list-card" padding={4}>
        <p className="quick-export-summary">
          {status.selected_segment_count} 段精选片段 · {status.selected_whole_count} 条整条收藏 · 共 {formatDuration(status.total_duration_seconds)}
        </p>
        {quick.plan ? (
          <ul className="quick-export-list" aria-label="将导出的文件">
            {quick.plan.files.map((name) => (
              <li key={name} className="quick-export-file">
                <Icon name="play" size={12} />
                <span className="quick-export-file-name">{name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quick-export-summary">正在整理清单…</p>
        )}
        {quick.plan && quick.plan.dir ? <p className="quick-export-folder">文件夹：{folderDisplayName(quick.plan.dir)}</p> : null}
      </Card>
    </section>
  );
}

export interface QuickExportFooterProps {
  quick: QuickExport;
  status: ExportStatus;
  onClose(): void;
}

/** 快速模式页脚:一句状态 + 「更改文件夹…」(ghost)+ 主按钮「导出」(AX 名「导出到上次文件夹」)。 */
export function QuickExportFooter({ quick, status, onClose }: QuickExportFooterProps): JSX.Element {
  const active = isExportActive(status);
  const processed = status.completed_items + status.failed_items;
  const percent = status.selected_count === 0 ? 0 : Math.min(100, Math.round((processed / status.selected_count) * 100));
  const line = quick.error
    ? { text: quick.error, tone: "danger", alert: true }
    : active
      ? { text: `${STAGE_LABELS[status.stage]} · ${processed} / ${status.selected_count}`, tone: "neutral", alert: false }
      : quick.done
        ? { text: "导完了。可以继续挑片段再导一次。", tone: "neutral", alert: false }
        : quick.lastDir
          ? { text: `导出到 ${quick.lastDir}`, tone: "neutral", alert: false }
          : { text: "第一次导出会让你选一个文件夹，之后记住。", tone: "neutral", alert: false };

  return (
    <footer className={`deliver-footer${active ? " deliver-footer--active" : ""}`}>
      {active ? <span className="deliver-footer-progress" style={{ width: `${percent}%` }} aria-hidden="true" /> : null}
      <p className={`deliver-footer-status deliver-footer-status--${line.tone}`} role={line.alert ? "alert" : "status"}>
        {line.text}
      </p>
      <div className="deliver-footer-actions">
        <Button variant="ghost" tone={active ? "danger" : "neutral"} onClick={active ? () => void quick.cancel() : onClose}>
          {active ? "取消" : "关闭"}
        </Button>
        {!active ? (
          <Button variant="ghost" aria-label="更改文件夹" onClick={() => void quick.changeFolder()}>
            更改文件夹…
          </Button>
        ) : null}
        <Button
          variant="primary"
          icon="deliver"
          busy={quick.busy}
          disabled={!quick.canExport}
          aria-label="导出到上次文件夹"
          title={quick.lastDir ? `导出到 ${quick.lastDir}` : "先选一个文件夹，以后记住"}
          onClick={() => void quick.exportNow()}
        >
          {quick.lastDir ? "导出" : "导出…"}
        </Button>
      </div>
    </footer>
  );
}
