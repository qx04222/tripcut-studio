import type { JSX } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { SectionHeader } from "../ui/SectionHeader";
import { batchStatusLabel, decodeQueueHint, lastPathSegment, ownedElsewhereLines, pausedByUserHint, pipelineHeadline, pipelineSegments, type PipelineSegment } from "./importModel";
import { RemovalConfirm } from "./RemovalConfirm";
import { ImportFailedJobs } from "./ImportFailedJobs";
import { ImportRunningJobs } from "./ImportRunningJobs";
import { useImportJobs } from "./useImportJobs";
import { dispatchWorkspace } from "../WorkspaceStore";
import { IMPORT_PROGRESS_LABEL } from "../copy";

/** 三段式的一段(R10 U-08):标签 + 「已处理 n / N」+ 百分比 + 自己的进度条 + 处理中 / 等待 / 失败。 */
function PipelineTile({ segment }: { segment: PipelineSegment }): JSX.Element {
  const { label, done, total, percent, running, waiting, failed } = segment;
  return (
    <li className="import-pipeline-tile" data-segment={segment.id}>
      <span className="import-pipeline-label">{label}</span>
      <span className="import-pipeline-count">{`已处理 ${done} / ${total}`}</span>
      <span className="import-pipeline-percent">{`${percent}%`}</span>
      <div
        className="import-index-track"
        role="progressbar"
        aria-label={`${label}进度`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="import-pipeline-rest">
        {running > 0 ? `${running} 处理中 · ` : ""}
        {`${waiting} 等待`}
        {failed > 0 ? <span className="import-stage-failed">{` · ${failed} 失败`}</span> : null}
      </span>
    </li>
  );
}

/** 任务分页(规格 §4.1):进度卡(三段式:索引 / 画质 / 运镜)、批次卡、批量操作行、确认框。 */
export function ImportJobsTab({ onChanged }: { onChanged: () => void }): JSX.Element {
  const jobs = useImportJobs({ onChanged });
  const { progress, clips, readyClips, quality, motion, batches, busy, notice, confirmation, refreshError, loaded } = jobs;
  const segments = pipelineSegments(progress, readyClips.length, quality, motion);
  // Z-13:「重复 n」里属于别的集的那几条要说清在哪一集。
  const elsewhere = ownedElsewhereLines(clips);
  const hint = decodeQueueHint(progress, segments);
  const pausedHint = pausedByUserHint(progress);

  return (
    <div className="import-tab import-jobs">
      <section className="import-section" aria-label={IMPORT_PROGRESS_LABEL}>
        <SectionHeader title={IMPORT_PROGRESS_LABEL} meta={loaded ? pipelineHeadline(segments) : "正在读取…"} />
        <Card className="import-index import-index--pipeline" aria-live="polite">
          {/* A16-01:第一拍没回来之前不画 0 / 0 —— 那副样子和「真的没素材」一模一样。 */}
          {loaded ? (
            <ul className="import-pipeline" aria-label="流水线三阶段">
              {segments.map((segment) => (
                <PipelineTile key={segment.id} segment={segment} />
              ))}
            </ul>
          ) : (
            <p className="import-index-note">正在读取任务进度…</p>
          )}
          {pausedHint ? <p className="import-index-hint import-index-hint--paused" role="status">{pausedHint}</p> : null}
          {hint ? <p className="import-index-hint">{hint}</p> : null}
          {loaded ? <p className="import-index-note">{`${readyClips.length} 条可用素材。封面出现后即可筛片；分析在后台继续，失败原因可在检查器里查看。`}</p> : null}
        </Card>
        {refreshError ? (
          <p className="import-note import-note--error" role="status">
            刷新暂时失败，正在重试：{refreshError}
          </p>
        ) : null}
      </section>

      {/* R16 P1-6:正在跑的任务逐行可取消。 */}
      <ImportRunningJobs jobs={jobs.runningJobs} busy={busy} onCancel={(id) => void jobs.cancelRunningJob(id)} />

      {/* R18 F8:没干成的任务单独一段 + 「清空全部失败」;一条都没有时整段不画。 */}
      <ImportFailedJobs onChanged={() => void jobs.refresh()} />

      <section className="import-section" aria-label="最近导入批次">
        <SectionHeader
          title="最近导入批次"
          meta={batches.length > 0 ? `${batches.length} 批` : undefined}
          actions={
            <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void jobs.dismissNotices()}>
                清理重复/失败提示
              </Button>
              <Button variant="ghost" size="sm" tone="danger" disabled={busy} onClick={() => jobs.arm({ batch_id: null, clip_ids: [], all: true })}>
                清空当前集素材…
              </Button>
            </>
          }
        />
        {!loaded ? (
          <Card className="import-jobs-empty">
            <p className="import-recent-empty">正在读取…</p>
          </Card>
        ) : batches.length === 0 ? (
          <Card className="import-jobs-empty">
            <EmptyState
              size="inline"
              icon="import"
              title="还没有导入批次"
              body="添加一个素材文件夹后,每次导入会在这里各成一批。"
              action={
                <Button variant="ghost" size="sm" onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" })}>
                  去添加文件夹
                </Button>
              }
            />
          </Card>
        ) : (
          <ul className="import-jobs-list">
            {batches.map((batch) => {
              const status = batchStatusLabel(batch.status);
              return (
                <Card as="li" key={batch.id} className="import-job">
                  <div className="import-job-copy">
                    <div className="import-job-head">
                      <strong className="import-job-name" title={batch.source}>{lastPathSegment(batch.source)}</strong>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                    <small className="import-job-meta">
                      新增 {batch.imported} · 重复 {batch.duplicates} · 失败 {batch.failed} · {batch.done} / {batch.total} 索引完成
                      {batch.running ? ` · ${batch.running} 正在处理` : ""}
                    </small>
                  </div>
                  <div className="import-job-actions">
                    <Button size="sm" disabled={busy || batch.status === "cancelled"} onClick={() => void jobs.cancelBatch(batch.id)}>
                      停止本批
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => jobs.arm({ batch_id: batch.id, clip_ids: [], all: false })}>
                      撤销本批…
                    </Button>
                  </div>
                </Card>
              );
            })}
          </ul>
        )}
        {elsewhere.length > 0 ? (
          <ul className="import-jobs-elsewhere" aria-label="已属于其他集的文件">
            {elsewhere.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {confirmation ? (
        <RemovalConfirm
          request={confirmation.request}
          preview={confirmation.preview}
          busy={busy}
          onCancel={() => jobs.cancelConfirmation()}
          onConfirm={() => void jobs.confirmRemoval()}
        />
      ) : null}
      {notice ? (
        <p className="import-note" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
