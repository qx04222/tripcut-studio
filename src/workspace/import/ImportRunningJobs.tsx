import { useState, type JSX } from "react";
import type { RunningJob } from "../../api";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { SectionHeader } from "../ui/SectionHeader";
import { runningJobLabel } from "./importModel";

/**
 * R16 P1-6:「正在处理」——每行一项正在跑的后台任务 + 「取消」。取消不可逆但无数据损失,
 * 所以确认**一次**(行内换成「确定取消?」两颗按钮),不弹原生对话框。
 */
export function ImportRunningJobs({
  jobs,
  busy,
  onCancel,
}: {
  jobs: readonly RunningJob[];
  busy: boolean;
  onCancel: (id: number) => void;
}): JSX.Element | null {
  const [arming, setArming] = useState<number | null>(null);
  if (jobs.length === 0) return null;
  return (
    <section className="import-section import-running" aria-label="正在处理">
      <SectionHeader title="正在处理" meta={`${jobs.length} 项`} />
      <ul className="import-running-list">
        {jobs.map((job) => {
          const label = runningJobLabel(job.kind);
          const name = job.file_name ?? "";
          const armed = arming === job.id;
          return (
            <Card as="li" key={job.id} className="import-running-row" data-kind={job.kind}>
              <span className="import-running-copy">
                <strong className="import-running-label">{label}</strong>
                {name ? <span className="import-running-file" title={name}>{name}</span> : null}
                {job.cancel_requested ? <span className="import-running-note">正在停止…</span> : null}
              </span>
              <span className="import-running-actions">
                {job.cancel_requested ? null : armed ? (
                  <>
                    <span className="import-running-confirm">确定取消?</span>
                    <Button size="sm" tone="danger" disabled={busy} aria-label={`确定取消 ${label}${name ? ` ${name}` : ""}`} onClick={() => { setArming(null); onCancel(job.id); }}>
                      取消任务
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setArming(null)}>
                      保留
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={`取消 ${label}${name ? ` ${name}` : ""}`} onClick={() => setArming(job.id)}>
                    取消
                  </Button>
                )}
              </span>
            </Card>
          );
        })}
      </ul>
    </section>
  );
}
