import { useEffect, useState, type JSX } from "react";
import { listImportBatches, type ImportBatch } from "../../api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { SectionHeader } from "../ui/SectionHeader";
import { dispatchWorkspace } from "../WorkspaceStore";
import { batchStatusLabel, lastPathSegment } from "./importModel";

const RECENT_LIMIT = 3;

/**
 * 来源分页底部的「最近导入」卡:最近 3 批(名 · 状态 · 计数),只读——停止 / 撤销在任务分页。
 * `refreshKey` 变了(一次导入 / 扫描落地)就重拉一次;不轮询,轮询是任务分页的事。
 */
export function ImportRecentCard({ refreshKey }: { refreshKey: string | null }): JSX.Element {
  const [batches, setBatches] = useState<ImportBatch[] | null>(null);

  useEffect(() => {
    let active = true;
    void listImportBatches()
      .then((value) => {
        if (active) setBatches(value);
      })
      .catch(() => {
        if (active) setBatches([]);
      });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  const recent = (batches ?? []).slice(0, RECENT_LIMIT);

  return (
    <section className="import-section" aria-label="最近导入">
      <SectionHeader
        title="最近导入"
        meta={batches && batches.length > RECENT_LIMIT ? `共 ${batches.length} 批` : undefined}
        actions={
          <Button variant="ghost" size="sm" icon="chevron-right" onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "jobs" })}>
            查看全部任务
          </Button>
        }
      />
      <Card className="import-recent">
        {batches === null ? (
          <p className="import-recent-empty">正在读取…</p>
        ) : recent.length === 0 ? (
          <p className="import-recent-empty">还没有导入过素材</p>
        ) : (
          <ul className="import-recent-list">
            {recent.map((batch) => {
              const status = batchStatusLabel(batch.status);
              return (
                <li key={batch.id} className="import-recent-row">
                  <span className="import-recent-name" title={batch.source}>{lastPathSegment(batch.source)}</span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <span className="import-recent-count">{`新增 ${batch.imported} · ${batch.done} / ${batch.total}`}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
