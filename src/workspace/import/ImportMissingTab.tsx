import type { JSX } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { SectionHeader } from "../ui/SectionHeader";
import { useMissingMedia } from "./useMissingMedia";

/** 缺失素材分页(规格 §4.1):按卷分组的卡 + 「重新定位」;结果行文案逐字沿用 MissingMediaPanel。 */
export function ImportMissingTab(): JSX.Element {
  const missing = useMissingMedia();
  const { groups, busy, results, notice } = missing;

  return (
    <div className="import-tab import-missing">
      <section className="import-section" aria-label="缺失素材重连">
        <SectionHeader
          title="缺失素材"
          meta={missing.clips.length > 0 ? `${missing.clips.length} 个文件` : undefined}
          description="原片所在的卷不在了(拔卡、换盘、改名)。指向它的新位置,分析结果与评分都会保留。"
        />
        {groups.length === 0 ? (
          <Card className="import-missing-empty">
            <EmptyState size="inline" icon="check" title="所有素材都在原位" body="当前集引用的每个原片都能读到。" />
          </Card>
        ) : (
          <ul className="import-missing-list">
            {groups.map((group) => {
              const outcome = results[group.volumeUuid];
              const relinking = busy === group.volumeUuid;
              return (
                <Card as="li" key={group.volumeUuid} className="import-missing-volume">
                  <div className="import-missing-head">
                    <strong className="import-missing-label">{group.volumeLabel ?? group.volumeUuid}</strong>
                    <Badge tone="warn">{`${group.clips.length} 个文件缺失`}</Badge>
                    <Button
                      size="sm"
                      icon="search"
                      busy={relinking}
                      className="import-missing-relink"
                      onClick={() => void missing.relink(group.volumeUuid)}
                    >
                      {relinking ? "正在重连…" : "重新定位"}
                    </Button>
                  </div>
                  <ul className="import-missing-files">
                    {group.clips.map((clip) => (
                      <li key={clip.clip_id}>{clip.file_name}</li>
                    ))}
                  </ul>
                  {outcome ? (
                    <p className="import-note" role="status">
                      已重绑 {outcome.relinked}（已更新卷标识）、拒绝 {outcome.rejected.length}
                      {outcome.rejected.length ? `（${outcome.rejected.join("、")}）` : ""}
                      、仍缺失 {outcome.still_missing}
                    </p>
                  ) : null}
                </Card>
              );
            })}
          </ul>
        )}
      </section>
      {notice ? (
        <p className="import-note import-note--error" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
