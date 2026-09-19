import { useCallback, useEffect, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { listAutoSelectRun, replaceAutoSegment, type AutoSelectRunRow, type AutoSelectRunView, type ClipListItem } from "../../api";
import { failureText } from "../errorText";
import { deleteSegmentWithUndo } from "../segmentDeletion";
import { Button, CoverImage, Icon } from "../ui";
import { showToast } from "../ui/Toast";
import { refreshClipsFeed, useClipsFeed } from "../useClipsFeed";
import { PromptInput } from "./PromptInput";
import { clipName, formatSecs, paramsText, reasonText, scoreLabel, siblingsLabel, summaryText } from "./resultsModel";

/** 结果面板的 AX 名(全部是新名;冻结名一个不动)。 */
export const RESULTS_PANEL_NAME = "为什么是这些";
export const RESULTS_LIST_NAME = "挑选结果";

/**
 * R19 P-03「为什么是这些」:自动挑选之后滑出的结果面板 —— 与 Wave 1 检查器滑出层**同一套机制**
 * (`position:absolute` 盖在栏内一侧,translateX 进出,--motion-slow 进 / --motion-exit 出,Esc 收),
 * 只是盖的是镜头带栏的右侧而不是中栏:带留在左边,行消失 / 段减少能同屏看见。
 * 挂载点:`BandAutoSelect` 找到 `[data-pane="band"]` 就 portal 进去;找不到(单测)就原地渲染。
 */
export function ResultsLayer({ open, container, children }: { open: boolean; container: Element | null; children: ReactNode }): JSX.Element | null {
  // 只在开着时挂载(收起即卸,不像检查器那样常驻空层 —— 镜头带栏没有 overflow:hidden 兜底,
  // 一个平移出栏外的空层会把栏撑出横向溢出);进场动画靠下一帧再加 .is-open。
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return undefined;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!open) return null;
  const node = (
    <div className={`results-layer${entered ? " is-open" : ""}`} data-open="true">
      {children}
    </div>
  );
  return container ? createPortal(node, container) : node;
}

export interface ResultsPanelProps {
  runId: string;
  onClose(): void;
  /** 「全部撤销」= 整批 ⌘Z(BandAutoSelect 推进撤销栈的那一条);回 false 表示已经撤过了。 */
  onUndoAll(): Promise<boolean>;
  /** P-01:面板顶部再来一句 → 再挑一批(BandAutoSelect 的 runSentence)。不传就不出输入行。 */
  onPrompt?(sentence: string): void;
  busy?: boolean;
}

function ResultRow({
  row,
  clips,
  busy,
  onDrop,
  onReplace,
}: {
  row: AutoSelectRunRow;
  clips: readonly ClipListItem[];
  busy: boolean;
  onDrop(row: AutoSelectRunRow): void;
  onReplace(row: AutoSelectRunRow): void;
}): JSX.Element {
  const clip = clips.find((candidate) => candidate.id === row.clip_id);
  const name = clipName(clip, row.clip_id);
  return (
    <li className="results-row" data-segment-id={row.segment_id}>
      <span className="results-row-thumb" aria-hidden="true">
        <CoverImage src={clip?.cover_url ?? null} lazy />
      </span>
      <span className="results-row-body">
        <span className="results-row-head">
          <strong className="results-row-name">{name}</strong>
          <span className="results-row-meta">{`${formatSecs(row.secs)} · ${scoreLabel(row.score)}`}</span>
        </span>
        <span className="results-row-reason">{reasonText(row.reasons)}</span>
        {row.siblings.length > 0 ? (
          <details className="results-siblings">
            <summary>{siblingsLabel(row.siblings.length)}</summary>
            <ul className="results-siblings-list">
              {row.siblings.map((sibling) => (
                <li key={sibling.clip_id}>{`${clipName(clips.find((candidate) => candidate.id === sibling.clip_id), sibling.clip_id)} · ${scoreLabel(sibling.score)}`}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </span>
      <span className="results-row-actions">
        <Button variant="ghost" size="sm" disabled={busy} aria-label={`换一段 · ${name}`} title="用相似的另一条(或这条素材的另一段)换掉" onClick={() => onReplace(row)}>
          换一段
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} aria-label={`不要这一段 · ${name}`} onClick={() => onDrop(row)}>
          不要这一段
        </Button>
      </span>
    </li>
  );
}

export function ResultsPanel({ runId, onClose, onUndoAll, onPrompt, busy = false }: ResultsPanelProps): JSX.Element {
  const { clips } = useClipsFeed();
  const [view, setView] = useState<AutoSelectRunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);
  const [undoing, setUndoing] = useState(false);

  const reload = useCallback(() => {
    return listAutoSelectRun(runId)
      .then((next) => {
        setView(next);
        setError(null);
      })
      .catch((cause) => setError(failureText("读取挑选结果", cause)));
  }, [runId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Esc 收起(与检查器滑出层同一条约定);输入框里的 Esc 让给输入框自己。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onDrop = useCallback(
    (row: AutoSelectRunRow) => {
      setBusyRow(row.segment_id);
      // 与检查器 / 镜块菜单的「删除精选段」同一条路:软删 + 5 秒撤销 + ⌘Z;恢复后这一行会回来。
      void deleteSegmentWithUndo(row.segment_id, () => void reload())
        .catch((cause) => showToast(failureText("不要这一段", cause), { tone: "danger" }))
        .finally(() => setBusyRow(null));
    },
    [reload],
  );

  const onReplace = useCallback(
    (row: AutoSelectRunRow) => {
      setBusyRow(row.segment_id);
      void replaceAutoSegment(row.segment_id)
        .then(async (next) => {
          const name = clipName(clips.find((candidate) => candidate.id === next.clip_id), next.clip_id);
          showToast(`已换成「${name}」· ${reasonText(next.reasons)}`);
          await refreshClipsFeed(true);
          await reload();
        })
        .catch((cause) => showToast(failureText("换一段", cause), { tone: "danger" }))
        .finally(() => setBusyRow(null));
    },
    [clips, reload],
  );

  const undoAll = useCallback(() => {
    setUndoing(true);
    void onUndoAll()
      .then((undone) => {
        showToast(undone ? "已撤销这批挑选" : "这批已经撤销过了");
        onClose();
      })
      .catch((cause) => showToast(failureText("全部撤销", cause), { tone: "danger" }))
      .finally(() => setUndoing(false));
  }, [onUndoAll, onClose]);

  const rows = view?.rows ?? [];
  return (
    <section className="results-panel" role="group" aria-label={RESULTS_PANEL_NAME}>
      <header className="results-head">
        <div className="results-head-copy">
          <strong className="results-title">{RESULTS_PANEL_NAME}</strong>
          <span className="results-summary">{view ? `${summaryText(rows)} · ${paramsText(view)}` : "正在读取…"}</span>
        </div>
        <div className="results-head-actions">
          <Button variant="secondary" size="sm" busy={undoing} disabled={undoing || rows.length === 0} onClick={undoAll}>
            全部撤销
          </Button>
          <Button variant="icon" size="sm" aria-label="收起挑选结果" title="收起(Esc)" onClick={onClose}>
            <Icon name="close" size={16} />
          </Button>
        </div>
      </header>
      {onPrompt ? <PromptInput busy={busy} onSubmit={onPrompt} /> : null}
      {error ? (
        <p className="results-empty" role="status">
          {error}
        </p>
      ) : null}
      {view && rows.length === 0 && !error ? (
        <p className="results-empty" role="status">
          这一批已经没有剩下的段了;再挑一次或从媒体池手动挑几条。
        </p>
      ) : null}
      <ul className="results-list" aria-label={RESULTS_LIST_NAME}>
        {rows.map((row) => (
          <ResultRow key={row.segment_id} row={row} clips={clips} busy={busyRow === row.segment_id || undoing} onDrop={onDrop} onReplace={onReplace} />
        ))}
      </ul>
    </section>
  );
}
