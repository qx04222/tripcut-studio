import { useCallback, useEffect, useState } from "react";

import {
  CHAPTER_SKIPPED_PREFIX,
  arrangeSelectedSegments,
  getSettings,
  skipChapter,
  undoArrange,
  undoAutoSelect,
  type ArrangeOutcome,
} from "../api";
import { autoSelectToast, autoSelectToastActions, type AutoSelectResult } from "./BandAutoSelect";
import { failureText } from "./errorText";
import { OPEN_AUTO_SELECT_EVENT } from "./onboarding";
import type { BandChapter } from "./shotBandModel";
import { showToast } from "./ui/Toast";
import { runUndoById } from "./undoStack";
import { refreshClipsFeed } from "./useClipsFeed";
import { dispatchWorkspace } from "./WorkspaceStore";

/**
 * R12 §2 / §3(车道 B):镜头带的「挑选 → 排列」联动状态 —— 一键排入(可撤销)、
 * 「这章够了」(settings 键 `story.chapter_skipped.<id>`)、「回到第 2 步挑几条」、
 * 自动挑选结果的 toast。纯文案函数在上面,组件只拿回调。
 */

/** 「撤销」类 toast 的停留时长(与 ShotBand.GAP_UNDO_MS 同一个数)。 */
const UNDO_TOAST_MS = 5_000;

/** R12 §2:「一键排入」结果的 toast 文案。 */
export function arrangeToast(outcome: ArrangeOutcome): string {
  if (outcome.placed === 0) return "挑好的片段都已经在镜头带上了";
  return `已排入 ${outcome.placed} 段 · 覆盖 ${outcome.chapters} 章`;
}

/** settings 里「这章够了」标过的章 id。 */
export function skippedChaptersFrom(settings: Readonly<Record<string, string>> | null | undefined): Set<number> {
  const out = new Set<number>();
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (!key.startsWith(CHAPTER_SKIPPED_PREFIX) || value !== "true") continue;
    const id = Number.parseInt(key.slice(CHAPTER_SKIPPED_PREFIX.length), 10);
    if (Number.isFinite(id)) out.add(id);
  }
  return out;
}

/** R12 §3:自动挑选结果的 toast 文案 —— 挑了几段、排进去几段。 */
export function autoSelectPlacedToast(outcome: AutoSelectResult): string {
  const placed = outcome.placed ?? 0;
  if (placed > 0) return `${autoSelectToast(outcome)} · 已排进镜头带`;
  return `${autoSelectToast(outcome)} · 还没排进镜头带,点「一键排入」`;
}

export function useBandArrange(): {
  skipped: ReadonlySet<number>;
  onSkipChapter: (chapter: BandChapter, skipped: boolean) => void;
  arranging: boolean;
  onArrange: () => void;
  onBackToSelect: () => void;
  onAutoSelected: (outcome: AutoSelectResult) => void;
} {
  // R12 §2「这章够了」:跳过的章 id 从 settings 读一次,点过之后就地更新。
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => getSettings())
      .then((settings) => {
        if (active) setSkipped(skippedChaptersFrom(settings));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const onSkipChapter = useCallback((chapter: BandChapter, next: boolean) => {
    if (chapter.chapterId === null) return;
    const id = chapter.chapterId;
    void skipChapter(id, next)
      .then(() => {
        setSkipped((current) => {
          const copy = new Set(current);
          if (next) copy.add(id);
          else copy.delete(id);
          return copy;
        });
        if (next) {
          showToast(`「${chapter.title}」这章够了,不再算缺口`, {
            action: { label: "撤销", onClick: () => onSkipChapter(chapter, false) },
          });
        }
      })
      .catch((error) => showToast(failureText("标记这章", error), { tone: "danger" }));
  }, []);

  // R12 §2「一键排入」:本集全部精选段按章写进镜头带;toast 带「撤销」只撤这一批。
  const [arranging, setArranging] = useState(false);
  const onArrange = useCallback(() => {
    setArranging(true);
    void arrangeSelectedSegments("append")
      .then((outcome) => {
        showToast(arrangeToast(outcome), {
          tone: outcome.placed > 0 ? "success" : "neutral",
          action:
            outcome.placed > 0
              ? {
                  label: "撤销",
                  onClick: () => {
                    void undoArrange(outcome.batch_id)
                      .then(() => {
                        showToast("已撤销这次排入");
                        return refreshClipsFeed(true);
                      })
                      .catch((error) => showToast(failureText("撤销", error), { tone: "danger" }));
                  },
                }
              : undefined,
        });
        return refreshClipsFeed(true);
      })
      .catch((error) => showToast(failureText("排入", error, "先在第 2 步挑几条片段"), { tone: "danger" }))
      .finally(() => setArranging(false));
  }, []);

  // 「回到第 2 步挑几条」:把焦点交回媒体池,并打开自动挑选面板(第 2 步的主动作)。
  const onBackToSelect = useCallback(() => {
    dispatchWorkspace({ type: "focus-pane", pane: "pool" });
    window.dispatchEvent(new CustomEvent(OPEN_AUTO_SELECT_EVENT));
  }, []);

  // R11 §1.2 / R12 §3:自动挑选的结果走全局 Toast,「撤销」撤这一批(段没了,带上的镜块级联消失)。
  const onAutoSelected = useCallback((outcome: AutoSelectResult) => {
    // R19 Wave 2 接线:带 `run_id` 时结果面板(P-03)同时打开、里面有「全部撤销」+ ⌘Z ——
    // toast 不再重复一颗「撤销」(首次零决定的用户只看一处入口);没有 run_id 的旧路径照旧带。
    const undoAction =
      outcome.run_id !== undefined
        ? undefined
        : {
            label: "撤销",
            onClick: () => {
              // R19 P-03(results 车道,两行):这批已经在 ⌘Z 栈里(`undo_id`)就走同一条,撤过一次不再撤第二次;
              // 没有 undo_id(旧路径)照旧直接撤。
              const undone = outcome.undo_id !== undefined ? runUndoById(outcome.undo_id).then((ran) => (ran ? undefined : Promise.reject(new Error("这批已经撤销过了")))) : undoAutoSelect(outcome.batch_id);
              undone
                .then(() => {
                  showToast("已撤销这批挑选");
                  return refreshClipsFeed(true);
                })
                .catch((error) => showToast(failureText("撤销", error), { tone: "danger" }));
            },
          };
    showToast(autoSelectPlacedToast(outcome), {
      tone: "success",
      durationMs: UNDO_TOAST_MS,
      // R19 U-09(flow 车道,一行):首次零决定跑完,给「改范围 / 改时长」入口(次要动作,排在「撤销」之后)。
      actions: autoSelectToastActions(outcome),
      action: undoAction,
    });
  }, []);
  return { skipped, onSkipChapter, arranging, onArrange, onBackToSelect, onAutoSelected };
}

export { pushReplaceUndo } from "./useBandArrangeReplace";
