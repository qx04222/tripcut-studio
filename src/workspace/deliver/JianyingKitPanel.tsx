import type { JSX } from "react";
import type { ExportStatus } from "../../api";
import { Button, Card, Icon } from "../ui";
import { STAGE_LABELS, formatDuration, isExportActive } from "./deliverModel";
import { DeliverItemList, DeliverProgressCard } from "./DeliverProgressCard";
import { KIT_LEAD_LINE, KIT_NEXT_STEPS, OPEN_JIANYING_ACTION, kitDoneLine, kitFolderLine } from "./kitExportModel";
import { folderDisplayName } from "./quickExportModel";
import { MissingSourcesNotice } from "./MissingSourcesNotice";
import type { JianyingKit } from "./useJianyingKit";

export interface JianyingKitPanelProps {
  kit: JianyingKit;
  status: ExportStatus;
}

/** 素材包导完后的结果卡:「已导出 n 个片段」+ 在剪映里接着做的三步 + 「打开剪映 / 在 Finder 中显示」。 */
export function JianyingKitResultCard({ kit, status }: JianyingKitPanelProps): JSX.Element {
  return (
    <Card className="kit-export-result deliver-result deliver-result--ok" padding={4} role="status">
      <span className="deliver-result-icon">
        <Icon name="check" size={16} />
      </span>
      <div className="deliver-result-copy">
        <p className="deliver-result-title">{kitDoneLine(status)}</p>
        {status.output_path ? <code className="deliver-result-path">{status.output_path}</code> : null}
        <ol className="kit-export-steps" aria-label="接下来在剪映里">
          {KIT_NEXT_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
      <div className="kit-export-result-actions">
        <Button variant="primary" size="sm" icon="deliver" onClick={kit.openJianying}>
          {OPEN_JIANYING_ACTION}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void kit.reveal()}>
          在 Finder 中显示
        </Button>
      </div>
      <DeliverItemList items={status.items.filter((item) => item.status === "failed")} />
    </Card>
  );
}

/**
 * 交付抽屉「剪映素材包」模式的正文(R14 §9 B):一句话「按镜头带顺序编号导出,拖进剪映时间线就是这个顺序」
 * + 编号清单;进行中换成进度卡,完成换成三步结果卡。
 */
export function JianyingKitPanel({ kit, status }: JianyingKitPanelProps): JSX.Element {
  const active = isExportActive(status);

  if (active) {
    return (
      <section className="kit-export" aria-label="剪映素材包">
        <p className="kit-export-lead">正在导出到「{folderDisplayName(kit.lastDir ?? "")}」</p>
        <DeliverProgressCard status={status} />
      </section>
    );
  }

  if (kit.done) {
    return (
      <section className="kit-export" aria-label="剪映素材包">
        <JianyingKitResultCard kit={kit} status={status} />
      </section>
    );
  }

  if (status.status === "failed" || status.status === "blocked") {
    return (
      <section className="kit-export" aria-label="剪映素材包">
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

  if (kit.planError || status.selected_count === 0) {
    return (
      <section className="kit-export" aria-label="剪映素材包">
        <Card className="quick-export-empty" padding={4}>
          <p className="quick-export-empty-title">镜头带上还没有片段</p>
          <p className="quick-export-empty-body">先到第 2 步挑几段、第 3 步点「一键排入」,再回来导出素材包。</p>
        </Card>
      </section>
    );
  }

  return (
    <section className="kit-export" aria-label="剪映素材包">
      <p className="kit-export-lead">{KIT_LEAD_LINE}</p>
      <MissingSourcesNotice missing={kit.plan?.missing} />
      <Card className="quick-export-list-card" padding={4}>
        <p className="quick-export-summary">
          {kit.plan ? `${kit.plan.files.length} 个片段` : `${status.selected_count} 个片段`} · 共 {formatDuration(status.total_duration_seconds)} · 附「顺序.txt」
        </p>
        {kit.plan ? (
          <ol className="quick-export-list kit-export-list" aria-label="将导出的文件">
            {kit.plan.files.map((name) => (
              <li key={name} className="quick-export-file">
                <Icon name="play" size={12} />
                <span className="quick-export-file-name">{name}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="quick-export-summary">正在整理清单…</p>
        )}
        {kit.plan && kit.plan.dir ? <p className="quick-export-folder">文件夹：{folderDisplayName(kit.plan.dir)}</p> : null}
      </Card>
    </section>
  );
}

export interface JianyingKitFooterProps {
  kit: JianyingKit;
  status: ExportStatus;
  onClose(): void;
}

/** 素材包页脚:「导出到 <上次文件夹>」一句 + 「更改文件夹…」(ghost)+ 主按钮「导出素材包」(AX 名「导出剪映素材包到上次文件夹」)。 */
export function JianyingKitFooter({ kit, status, onClose }: JianyingKitFooterProps): JSX.Element {
  const active = isExportActive(status);
  const processed = status.completed_items + status.failed_items;
  const percent = status.selected_count === 0 ? 0 : Math.min(100, Math.round((processed / status.selected_count) * 100));
  const line = kit.error
    ? { text: kit.error, tone: "danger", alert: true }
    : active
      ? { text: `${STAGE_LABELS[status.stage]} · ${processed} / ${status.selected_count}`, tone: "neutral", alert: false }
      : kit.done
        ? status.failed_items > 0
          // Z-10:有失败时页脚不说「导完了」。
          ? { text: `${kitDoneLine(status)}。腾出空间或换个文件夹后再导一次。`, tone: "danger", alert: true }
          : { text: "导完了。打开剪映,把这些片段拖进时间线。", tone: "neutral", alert: false }
        : { text: kitFolderLine(kit.lastDir), tone: "neutral", alert: false };

  return (
    <footer className={`deliver-footer${active ? " deliver-footer--active" : ""}`}>
      {active ? <span className="deliver-footer-progress" style={{ width: `${percent}%` }} aria-hidden="true" /> : null}
      <p className={`deliver-footer-status deliver-footer-status--${line.tone}`} role={line.alert ? "alert" : "status"}>
        {line.text}
      </p>
      <div className="deliver-footer-actions">
        <Button variant="ghost" tone={active ? "danger" : "neutral"} onClick={active ? () => void kit.cancel() : onClose}>
          {active ? "取消" : "关闭"}
        </Button>
        {!active ? (
          <Button variant="ghost" aria-label="更改文件夹" onClick={() => void kit.changeFolder()}>
            更改文件夹…
          </Button>
        ) : null}
        <Button
          variant="primary"
          icon="deliver"
          busy={kit.busy}
          disabled={!kit.canExport}
          aria-label="导出剪映素材包到上次文件夹"
          title={kit.lastDir ? `导出到 ${kit.lastDir}` : "先选一个文件夹，以后记住"}
          onClick={() => void kit.exportNow()}
        >
          {kit.lastDir ? "导出素材包" : "导出素材包…"}
        </Button>
      </div>
    </footer>
  );
}
