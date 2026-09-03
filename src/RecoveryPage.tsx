import { useEffect, useState } from "react";

import {
  exportDecisionData,
  getDoctorReport,
  openLogsDirectory,
  rebuildRecoveryCache,
  restoreLatestSnapshot,
  type DoctorReport,
} from "./api";

interface RecoveryPageProps {
  report: DoctorReport | null;
  loadError?: string;
  onContinue: () => void;
  onReport: (report: DoctorReport) => void;
}

const STATUS_COPY = {
  OK: "正常",
  WARN: "需关注",
  FAIL: "阻断",
} as const;

export function RecoveryPage({
  report,
  loadError,
  onContinue,
  onReport,
}: RecoveryPageProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState(
    loadError ?? (report ? "自检完成，请先确认恢复状态。" : "正在运行启动自检…"),
  );
  const [restoreArmed, setRestoreArmed] = useState(false);

  useEffect(() => {
    if (loadError) {
      setNotice(loadError);
    } else if (report) {
      setNotice((current) => current === "正在运行启动自检…" ? "自检完成，请先确认恢复状态。" : current);
    }
  }, [loadError, report]);

  const refresh = async () => {
    const next = await getDoctorReport();
    onReport(next);
  };

  const run = async (name: string, operation: () => Promise<string | void>) => {
    setBusy(name);
    try {
      const message = await operation();
      setNotice(typeof message === "string" ? message : "操作已完成");
      await refresh();
    } catch (error) {
      setNotice(`${name}失败：${String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const restore = () => {
    if (!restoreArmed) {
      setRestoreArmed(true);
      setNotice("再次点击确认：将用最近快照回填项目数据库，并保留当前数据库备份。");
      return;
    }
    setRestoreArmed(false);
    void run("快照恢复", restoreLatestSnapshot);
  };

  const blocked = loadError || report?.status === "FAIL" || report?.restart_required;
  const canRestore = report?.status === "FAIL" && Boolean(report.snapshots.length);

  return (
    <main className="recovery-page" aria-label="旅剪启动恢复">
      <header className="recovery-hero">
        <span className="recovery-kicker">TRIPCUT DOCTOR / STARTUP RECOVERY</span>
        <h1>{report?.status === "FAIL" ? "项目需要恢复后才能继续" : "上次会话没有正常结束"}</h1>
        <p>
          原始素材始终保持只读。这里仅处理项目数据库、可重建缓存与诊断日志，不会把异常状态带进工作台。
        </p>
        <div className="recovery-summary" data-status={report?.status ?? "WARN"}>
          <strong>{report ? STATUS_COPY[report.status] : "检测中"}</strong>
          <span>{notice}</span>
        </div>
      </header>

      <section className="recovery-checks" aria-label="启动自检清单">
        {(report?.checks ?? []).map((check) => (
          <article key={check.id} data-status={check.status}>
            <span>{STATUS_COPY[check.status]}</span>
            <div>
              <h2>{check.title}</h2>
              <p>{check.detail}</p>
            </div>
          </article>
        ))}
        {!report && (
          <article data-status="WARN">
            <span>检测中</span>
            <div>
              <h2>正在读取本地恢复状态</h2>
              <p>{loadError ?? "检查数据库、缓存、磁盘余量、工具链与异常退出标记。"}</p>
            </div>
          </article>
        )}
      </section>

      <section className="recovery-actions" aria-label="恢复操作">
        <button
          type="button"
          className={restoreArmed ? "danger armed" : "danger"}
          disabled={Boolean(busy) || !canRestore}
          onClick={restore}
        >
          <strong>{restoreArmed ? "确认从最近快照恢复" : "从快照恢复"}</strong>
          <span>{canRestore ? `可用 ${report?.snapshots.length ?? 0} 份，保留最近 5 份` : "仅在 FAIL 恢复模式且存在快照时可用"}</span>
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void run("决策数据导出", exportDecisionData)}
        >
          <strong>导出决策数据</strong>
          <span>导出评级、片段、故事顺序与人工偏好 JSON</span>
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void run("缓存重建", rebuildRecoveryCache)}
        >
          <strong>重建缓存</strong>
          <span>清理可重建产物，不触碰原片与人工决策</span>
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void run("打开日志目录", openLogsDirectory)}
        >
          <strong>打开日志目录</strong>
          <span>panic 日志仅保留 7 天，路径只记录文件名</span>
        </button>
      </section>

      <footer className="recovery-footer">
        <div>
          <strong>恢复摘要</strong>
          <span>
            已回收 {report?.recovered_jobs ?? 0} 个中断任务 · 缓存抽查 {report?.cache_sampled ?? 0} 条 / 异常 {report?.cache_missing ?? 0} 条
          </span>
        </div>
        <button type="button" disabled={Boolean(blocked) || Boolean(busy)} onClick={onContinue}>
          进入工作台
        </button>
      </footer>
    </main>
  );
}
