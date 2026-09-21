import { useEffect, useState, type JSX } from "react";
import { Button, Card } from "../ui";
import { listArchives, resumeArchive, undoArchive, type ArchiveOperation } from "./archiveApi";

/**
 * PH-11:交付抽屉里唯一新增的入口——「上次交付未完成」。三张交付卡不动;这块只在归档
 * 日志里有记录时出现(第一次交付前根本不渲染),平时折叠成一行,展开才看冻结清单 / 错误 /
 * 继续 / 撤销。文案两条硬约束:原片始终保留;撤销只撤本次创建且未修改的文件。
 */
const REFRESH_MS = 3000;

/**
 * R21 W3 P1-2(业主拍板「照片的逻辑不应该是视频的那一套」):照片工作台里这个入口说「导出」,
 * 视频工作台仍说「交付」;两边只列各自那一类归档(照片 = kind photo,视频 = 素材包 / 整包)。
 */
export type ArchiveRecoveryVariant = "video" | "photo";

const WORDING: Readonly<Record<ArchiveRecoveryVariant, { verb: string; unfinished: string; history: string; resume: string; files: string }>> = {
  video: { verb: "交付", unfinished: "上次交付未完成 · 查看与继续", history: "交付记录与撤销", resume: "继续交付", files: "本次交付文件清单" },
  photo: { verb: "导出", unfinished: "上次导出未完成 · 查看与继续", history: "导出记录与撤销", resume: "继续导出", files: "本次导出文件清单" },
};

function belongsTo(op: ArchiveOperation, variant: ArchiveRecoveryVariant): boolean {
  return variant === "photo" ? op.kind === "photo" : op.kind !== "photo";
}

function stateLabel(op: ArchiveOperation, verb: string): string {
  if (op.status === "done") return `${verb}已完成`;
  if (op.status === "undone") return "复制已撤销";
  return op.undo_requested ? "撤销尚未完成" : `${verb}尚未完成`;
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function ArchiveRecoveryEntry({ variant = "video" }: { variant?: ArchiveRecoveryVariant } = {}): JSX.Element | null {
  const wording = WORDING[variant];
  const [allOperations, setOperations] = useState<ArchiveOperation[]>([]);
  const operations = allOperations.filter((op) => belongsTo(op, variant));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void listArchives()
        .then((rows) => {
          if (alive && Array.isArray(rows)) setOperations(rows);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const act = async (operation: ArchiveOperation, undo: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await (undo ? undoArchive(operation.id) : resumeArchive(operation.id));
      setOperations(await listArchives());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (operations.length === 0) return null;
  const unfinished = operations.some((op) => !["done", "undone"].includes(op.status));
  return (
    <Card className={`deliver-archive-recovery${unfinished ? " deliver-archive-recovery--unfinished" : ""}`} padding={4}>
      <details className="deliver-parts deliver-archive-details">
        <summary className="deliver-parts-summary deliver-archive-summary">
          {unfinished ? wording.unfinished : wording.history}
        </summary>
        <p className="deliver-archive-note">原片始终保留。撤销只撤销本次创建且未修改的文件;已修改的文件会保留并列出。</p>
        {error && (
          <p className="deliver-archive-error" role="alert">
            {error}
          </p>
        )}
        <ul className="deliver-archive-ops">
          {operations.map((op) => {
            const finished = op.status === "done" || op.status === "undone";
            return (
              <li key={op.id} className={`deliver-archive-op deliver-archive-op--${op.status}`}>
                <p className="deliver-archive-op-head">
                  <span className="deliver-archive-op-state">{stateLabel(op, wording.verb)}</span>
                  <span className="deliver-archive-op-path">{op.destination}</span>
                </p>
                {op.files && op.files.length > 0 && (
                  <ul className="deliver-archive-files" aria-label={wording.files}>
                    {op.files.map((file) => (
                      <li key={file.destination}>
                        {fileName(file.source)} → {fileName(file.destination)}
                        {file.derived ? "(转换副本)" : "(原样复制)"}
                      </li>
                    ))}
                  </ul>
                )}
                {op.errors.map((message, index) => (
                  <p key={index} className="deliver-archive-op-error">
                    {message}
                  </p>
                ))}
                <div className="deliver-archive-actions">
                  {!finished && (
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act(op, false)}>
                      {op.undo_requested ? "继续撤销" : wording.resume}
                    </Button>
                  )}
                  {op.status !== "undone" && !op.undo_requested && (
                    <Button variant="ghost" size="sm" tone="danger" disabled={busy} onClick={() => void act(op, true)}>
                      撤销复制
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </details>
    </Card>
  );
}
