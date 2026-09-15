import { useCallback, useEffect, useState, type JSX } from "react";

import { clearFailedJobs, listFailedJobs, type FailedJob } from "../../api";
import { failureText } from "../errorText";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { SectionHeader } from "../ui/SectionHeader";
import { runningJobLabel } from "./importModel";

/** R18 F8:AX 名冻结。 */
export const CLEAR_FAILED_JOBS = "清空全部失败";

/** 一条失败任务的第二行:失败原因;后端没写原因时也得有一句话,不能是空白行。 */
export function failedJobReason(job: FailedJob): string {
  const reason = job.summary?.trim();
  if (reason) return reason;
  return job.status === "blocked" ? "试了几次都没成功,没说原因" : "没说原因";
}

/**
 * R18 车道 settings F8:「后台任务」页的失败清单 + 一颗「清空全部失败」。
 *
 * 为什么不是前端循环 `cancel_job`(头脑风暴 F8 的原方案):`jobs::request_cancel`
 * 对 `blocked` / `failed` 两个状态直接返回,循环调多少次列表都不会少一条。真正
 * 能把它们从视野里拿掉的是后端 `clear_failed_jobs`(标成已知晓,不删行——失败
 * 原因留给诊断包)。反证钉在 `core/diagnostics.rs::request_cancel_does_not_clear_blocked_jobs`。
 *
 * 一条失败都没有时整段不画:不要一颗永远在那里、按下去什么都不发生的按钮。
 */
export function ImportFailedJobs({ onChanged }: { onChanged: () => void }): JSX.Element | null {
  const [jobs, setJobs] = useState<readonly FailedJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (isActive: () => boolean) => {
    try {
      const rows = (await listFailedJobs()) ?? [];
      if (isActive()) setJobs(rows);
    } catch {
      // 旧后端 / 替身没有这条命令就当作没有失败任务,不要让整页红。
      if (isActive()) setJobs([]);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refresh(() => active);
    const timer = window.setInterval(() => void refresh(() => active), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const clearAll = useCallback(async () => {
    setBusy(true);
    try {
      const cleared = await clearFailedJobs();
      setJobs([]);
      setNotice(`已清掉 ${cleared} 条失败任务;素材和已经算好的结果都留着,需要时可以重新分析。`);
      onChanged();
    } catch (error) {
      setNotice(failureText(CLEAR_FAILED_JOBS, error));
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  if (jobs.length === 0 && notice === null) return null;

  return (
    <section className="import-section import-failed" aria-label="失败的后台任务">
      {jobs.length > 0 ? (
        <>
          <SectionHeader
            title="没干成的后台任务"
            meta={`${jobs.length} 项`}
            actions={
              <Button variant="ghost" size="sm" tone="danger" busy={busy} disabled={busy} onClick={() => void clearAll()}>
                {CLEAR_FAILED_JOBS}
              </Button>
            }
          />
          <ul className="import-failed-list">
            {jobs.map((job) => (
              <Card as="li" key={job.id} className="import-failed-row" data-kind={job.kind}>
                <span className="import-failed-copy">
                  <strong className="import-failed-label">{runningJobLabel(job.kind)}</strong>
                  {job.file_name ? <span className="import-failed-file" title={job.file_name}>{job.file_name}</span> : null}
                  <small className="import-failed-reason">{failedJobReason(job)}</small>
                </span>
                <Badge tone="danger">{job.status === "blocked" ? "已放弃" : "失败"}</Badge>
              </Card>
            ))}
          </ul>
        </>
      ) : null}
      {notice ? (
        <p className="import-note" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
