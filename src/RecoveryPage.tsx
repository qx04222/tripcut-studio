import { useEffect, useState, type JSX } from "react";

import {
  exportDecisionData,
  getDoctorReport,
  openLogsDirectory,
  rebuildRecoveryCache,
  restoreLatestSnapshot,
  type DoctorReport,
} from "./api";
import { Badge, Button, Card, Icon, type BadgeTone, type IconName } from "./workspace/ui";

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

const STATUS_TONE: Record<keyof typeof STATUS_COPY, BadgeTone> = { OK: "accent", WARN: "warn", FAIL: "danger" };
const STATUS_ICON: Record<keyof typeof STATUS_COPY, IconName> = { OK: "check", WARN: "warning", FAIL: "warning" };

/**
 * 启动恢复页(P5-F2),R10 U-36 换成设计系统:没有英文 kicker,标题按视口自适应且
 * `text-wrap: balance`(1512 宽下不再折成「…结\n束」),「进入工作台」在吸底的操作条里
 * 首屏就看得见——不用滚到 4 张检查卡之后才找得到出口。四个恢复操作与自检清单是套件
 * Card / Button / Badge;样式在 styles/workspace/shell-r10.css 的 `.recovery-r10`。
 */
export function RecoveryPage({ report, loadError, onContinue, onReport }: RecoveryPageProps): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState(
    loadError ?? (report ? "自检完成，请先确认恢复状态。" : "正在运行启动自检…"),
  );
  const [restoreArmed, setRestoreArmed] = useState(false);

  useEffect(() => {
    if (loadError) {
      setNotice(loadError);
    } else if (report) {
      setNotice((current) => (current === "正在运行启动自检…" ? "自检完成，请先确认恢复状态。" : current));
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

  const blocked = Boolean(loadError) || report?.status === "FAIL" || Boolean(report?.restart_required);
  const canRestore = report?.status === "FAIL" && Boolean(report.snapshots.length);
  const status = report?.status ?? "WARN";
  const title = report?.status === "FAIL" ? "项目需要恢复后才能继续" : "上次会话没有正常结束";

  return (
    <main className="recovery-r10" aria-label="旅剪启动恢复">
      <div className="recovery-r10-scroll">
        <header className="recovery-r10-hero">
          <Badge tone={STATUS_TONE[status]} icon={STATUS_ICON[status]}>
            {report ? STATUS_COPY[report.status] : "检测中"}
          </Badge>
          <h1 className="recovery-r10-title">{title}</h1>
          <p className="recovery-r10-lead">
            原始素材始终保持只读。这里仅处理项目数据库、可重建缓存与诊断日志，不会把异常状态带进工作台。
          </p>
          <p className="recovery-r10-notice" role="status" aria-live="polite">
            <Icon name="info" size={12} />
            <span>{notice}</span>
          </p>
        </header>

        <section className="recovery-r10-section" aria-label="启动自检清单">
          <h2 className="recovery-r10-heading">启动自检</h2>
          <ul className="recovery-r10-checks">
            {(report?.checks ?? []).map((check) => (
              <Card as="li" key={check.id} className="recovery-r10-check" data-status={check.status}>
                <Badge tone={STATUS_TONE[check.status]}>{STATUS_COPY[check.status]}</Badge>
                <div className="recovery-r10-check-copy">
                  <strong>{check.title}</strong>
                  <span>{check.detail}</span>
                </div>
              </Card>
            ))}
            {!report ? (
              <Card as="li" className="recovery-r10-check" data-status="WARN">
                <Badge tone="warn">检测中</Badge>
                <div className="recovery-r10-check-copy">
                  <strong>正在读取本地恢复状态</strong>
                  <span>{loadError ?? "检查数据库、缓存、磁盘余量、工具链与异常退出标记。"}</span>
                </div>
              </Card>
            ) : null}
          </ul>
        </section>

        <section className="recovery-r10-section" aria-label="恢复操作">
          <h2 className="recovery-r10-heading">恢复操作</h2>
          <div className="recovery-r10-actions">
            <div className="recovery-r10-action">
              <Button tone="danger" variant={restoreArmed ? "primary" : "secondary"} icon="settings-cache" disabled={Boolean(busy) || !canRestore} onClick={restore}>
                {restoreArmed ? "确认从最近快照恢复" : "从快照恢复"}
              </Button>
              <span>{canRestore ? `可用 ${report?.snapshots.length ?? 0} 份，保留最近 5 份` : "仅在阻断恢复模式且存在快照时可用"}</span>
            </div>
            <div className="recovery-r10-action">
              <Button icon="save" busy={busy === "决策数据导出"} disabled={Boolean(busy)} onClick={() => void run("决策数据导出", exportDecisionData)}>
                导出决策数据
              </Button>
              <span>导出评级、片段、故事顺序与人工偏好 JSON</span>
            </div>
            <div className="recovery-r10-action">
              <Button icon="settings-performance" busy={busy === "缓存重建"} disabled={Boolean(busy)} onClick={() => void run("缓存重建", rebuildRecoveryCache)}>
                重建缓存
              </Button>
              <span>清理可重建产物，不触碰原片与人工决策</span>
            </div>
            <div className="recovery-r10-action">
              <Button icon="settings-privacy" busy={busy === "打开日志目录"} disabled={Boolean(busy)} onClick={() => void run("打开日志目录", openLogsDirectory)}>
                打开日志目录
              </Button>
              <span>panic 日志仅保留 7 天，路径只记录文件名</span>
            </div>
          </div>
        </section>
      </div>

      <footer className="recovery-r10-bar">
        <div className="recovery-r10-bar-inner">
          <div className="recovery-r10-summary">
            <strong>恢复摘要</strong>
            <span>
              已回收 {report?.recovered_jobs ?? 0} 个中断任务 · 缓存抽查 {report?.cache_sampled ?? 0} 条 / 异常 {report?.cache_missing ?? 0} 条
            </span>
          </div>
          <Button variant="primary" icon="chevron-right" disabled={blocked || Boolean(busy)} onClick={onContinue}>
            进入工作台
          </Button>
        </div>
      </footer>
    </main>
  );
}
