import { useEffect, useRef, type JSX } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { SectionHeader } from "../ui/SectionHeader";
import { batchStatusLabel, lastPathSegment, type AnalysisProgress } from "./importModel";
import { useImportJobs } from "./useImportJobs";

/** 解码许可吃满时的提示——文案逐字沿用 ImportPage.PermitWaitingHint。 */
function permitHint(waiting: number, pausedForMemory: boolean): string | null {
  // 内存暂停时「等待解码许可」会误导——排队的不是许可,是内存;说清楚真正的原因。
  if (pausedForMemory) return "「内存不足，已暂停解码与模型任务」";
  if (!waiting || waiting <= 0) return null;
  return `「${waiting} 等待解码许可」`;
}

function StageRow({ label, done, total, running, waiting, failed }: {
  label: string; done: number; total: number; running: number; waiting: number; failed: number;
}): JSX.Element {
  return (
    <li className="import-stage">
      <span className="import-stage-label">{label}</span>
      <span className="import-stage-done">{done} / {total} 完成</span>
      <span className="import-stage-rest">{running} 处理中 · {waiting} 等待</span>
      {failed > 0 ? <span className="import-stage-failed">{failed} 失败</span> : <span className="import-stage-failed" aria-hidden="true" />}
    </li>
  );
}

function analysisRow(label: string, progress: AnalysisProgress, total: number): JSX.Element {
  return <StageRow label={label} done={progress.done} total={total} running={progress.running} waiting={progress.waiting} failed={progress.failed} />;
}

/** 任务分页(规格 §4.1):进度卡(大数字 + 进度条 + 三阶段)、批次卡、批量操作行、确认框。 */
export function ImportJobsTab({ onChanged }: { onChanged: () => void }): JSX.Element {
  const jobs = useImportJobs({ onChanged });
  const { progress, readyClips, quality, motion, batches, busy, notice, confirmation, refreshError } = jobs;
  const completed = progress.done + progress.failed;
  const percent = progress.total === 0 ? 0 : Math.round((completed / progress.total) * 100);
  const pending = Math.max(0, progress.total - completed - progress.running);
  const hint = permitHint(progress.waiting_for_permit, progress.paused_for_memory);
  // 确认框接在批次列表之后,列表一长就在视口外;弹出时滚到它并把焦点交给它(alertdialog)。
  const confirmRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!confirmation) return;
    const node = confirmRef.current;
    node?.scrollIntoView?.({ block: "nearest" });
    node?.focus();
  }, [confirmation]);

  return (
    <div className="import-tab import-jobs">
      <section className="import-section" aria-label="索引进度">
        <SectionHeader title="索引进度" meta={`${percent}%`} />
        <Card className="import-index" aria-live="polite">
          <div className="import-index-head">
            <span className="import-index-big">{`已处理 ${completed} / ${progress.total}`}</span>
            <span className="import-index-sub">
              {progress.running > 0 ? `${progress.running} 正在探测` : `${pending} 等待中`} · {readyClips.length} 条可用素材
            </span>
          </div>
          <div
            className="import-index-track"
            role="progressbar"
            aria-label="索引进度"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={completed}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          {hint ? <p className="import-index-hint">{hint}</p> : null}
          <ul className="import-stages">
            <StageRow label="索引" done={progress.done} total={progress.total} running={progress.running} waiting={pending} failed={progress.failed} />
            {analysisRow("画质分析", quality, readyClips.length)}
            {analysisRow("运镜分析", motion, readyClips.length)}
          </ul>
          <p className="import-index-note">封面出现后即可筛片。分析在后台继续；失败原因可在检查器里查看。</p>
        </Card>
        {refreshError ? (
          <p className="import-note import-note--error" role="status">
            刷新暂时失败，正在重试：{refreshError}
          </p>
        ) : null}
      </section>

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
        {batches.length === 0 ? (
          <Card className="import-jobs-empty">
            <EmptyState size="inline" icon="import" title="还没有导入批次" body="从「来源」分页添加文件夹或拖入文件夹后，每次导入会在这里各成一批。" />
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
      </section>

      {confirmation ? (
        <Card ref={confirmRef} tabIndex={-1} level="raised" padding={4} className="import-confirm" role="alertdialog" aria-label="确认移除素材">
          <strong className="import-confirm-title">
            {confirmation.request.all ? "清空当前集并重新选择素材" : confirmation.request.batch_id ? "撤销这次导入" : "从当前集移除选中素材"}
          </strong>
          <p>将移除 {confirmation.preview.clips} 条素材、{confirmation.preview.favorites} 条评分记录、{confirmation.preview.selections} 个精选段和 {confirmation.preview.cache_entries} 项缓存记录。相关筛选与故事引用也会清除。</p>
          <p>磁盘原视频不会删除。先停止相关任务并保存数据库快照；相关文件夹自动同步会暂停。进行中的批次会先停止，最终数量可能增加。</p>
          <div className="import-confirm-actions">
            <Button disabled={busy} onClick={() => jobs.cancelConfirmation()}>取消</Button>
            <Button variant="primary" tone="danger" busy={busy} onClick={() => void jobs.confirmRemoval()}>
              {busy ? "正在停止任务并清理…" : "确认移除，保留原视频"}
            </Button>
          </div>
        </Card>
      ) : null}
      {notice ? (
        <p className="import-note" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
