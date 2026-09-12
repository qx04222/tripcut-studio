import type { JSX } from "react";
import type { ExportStatus, JianyingDraftResult } from "../../api";
import { Button, Card, Icon } from "../ui";
import { STAGE_LABELS } from "./deliverModel";
import { DeliverItemList } from "./DeliverProgressCard";

export interface DeliverResultCardProps {
  status: ExportStatus;
  onReveal(): void;
}

/** 完成 / 失败的结果卡(规格 §4.2 第 5 条):ok tint 带「打开文件夹」;danger tint 带错误原文。 */
export function DeliverResultCard({ status, onReveal }: DeliverResultCardProps): JSX.Element | null {
  if (status.status === "done") {
    return (
      <Card className="deliver-result deliver-result--ok" padding={4}>
        <span className="deliver-result-icon">
          <Icon name="check" size={16} />
        </span>
        <div className="deliver-result-copy">
          <p className="deliver-result-title">{STAGE_LABELS.complete}</p>
          <p className="deliver-result-meta">
            {status.completed_items} 项已写入{status.failed_items > 0 ? ` · ${status.failed_items} 项未成功` : ""}
          </p>
          {status.output_path ? <code className="deliver-result-path">{status.output_path}</code> : null}
        </div>
        {status.job_id !== null ? (
          <Button variant="secondary" size="sm" onClick={onReveal}>
            打开文件夹
          </Button>
        ) : null}
        <DeliverItemList items={status.items.filter((item) => item.status === "failed")} />
      </Card>
    );
  }
  if (status.status === "failed" || status.status === "blocked") {
    return (
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
          {status.output_path ? <code className="deliver-result-path">{status.output_path}</code> : null}
        </div>
        <DeliverItemList items={status.items.filter((item) => item.status === "failed")} />
      </Card>
    );
  }
  return null;
}

/** 剪映草稿已生成:草稿名 + 回读自检信息 + 路径。不声称已打开剪映。 */
export function JianyingResultCard({ result }: { result: JianyingDraftResult }): JSX.Element {
  return (
    <Card className="deliver-result deliver-result--ok" padding={4}>
      <span className="deliver-result-icon">
        <Icon name="check" size={16} />
      </span>
      <div className="deliver-result-copy">
        <p className="deliver-result-title">剪映草稿已生成</p>
        <p className="deliver-result-name">{result.draft_name}</p>
        <p className="deliver-result-meta">{result.message}</p>
        <code className="deliver-result-path">{result.output_path}</code>
      </div>
    </Card>
  );
}
