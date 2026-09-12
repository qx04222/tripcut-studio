import type { JSX } from "react";
import type { ExportItemStatus, ExportStatus } from "../../api";
import { Badge, Card, type BadgeTone } from "../ui";
import { STAGE_LABELS, itemStatusLabel } from "./deliverModel";

function badgeTone(status: ExportItemStatus["status"]): BadgeTone {
  if (status === "failed") return "danger";
  if (status === "done") return "accent";
  return "neutral";
}

/** 每项状态列表:文件名 + 备注 + 状态 Badge(失败红)。进度卡与失败结果卡共用。 */
export function DeliverItemList({ items }: { items: ExportItemStatus[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ul className="deliver-job-items" aria-label="交付逐条状态">
      {items.map((item) => (
        <li
          key={`${item.clip_id}-${item.output_name}`}
          className={`deliver-job-item deliver-job-item--${item.status}${item.warning ? " deliver-job-item--warning" : ""}`}
        >
          <span className="deliver-job-item-copy">
            <span className="deliver-job-item-name">{item.file_name}</span>
            {item.note ? <span className="deliver-job-item-note">{item.note}</span> : null}
          </span>
          <Badge tone={badgeTone(item.status)}>{itemStatusLabel(item.status)}</Badge>
        </li>
      ))}
    </ul>
  );
}

/** 进行中的进度卡:阶段名 + 进度条 + 每项状态(规格 §4.2 第 4 条)。取消键在页脚。 */
export function DeliverProgressCard({ status }: { status: ExportStatus }): JSX.Element {
  const processed = status.completed_items + status.failed_items;
  const total = status.selected_count;
  const percent = total === 0 ? 0 : Math.min(100, Math.round((processed / total) * 100));

  return (
    <Card className="deliver-progress-card" padding={4} aria-live="polite">
      <div className="deliver-progress-head">
        <span className="deliver-progress-stage">{STAGE_LABELS[status.stage]}</span>
        <span className="deliver-progress-count">
          {processed} / {total}
        </span>
      </div>
      <div className="deliver-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={processed}>
        <span className="deliver-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="deliver-progress-note">
        {status.failed_items > 0 ? `${status.failed_items} 条未成功 · ` : ""}单条失败不会中断整包
      </p>
      <DeliverItemList items={status.items} />
    </Card>
  );
}
