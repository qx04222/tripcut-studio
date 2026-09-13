import { useEffect, useRef, type JSX } from "react";

import type { ClipListItem } from "../api";
import { ratingLabelFor } from "./inspectorModel";
import { isTopModal, popModal, pushModal } from "./modalStack";
import { TEMPLATE_POOL_RULE } from "./bandTemplateModel";
import { Button, CoverImage, EmptyState } from "./ui";
import { useFocusTrap } from "../useFocusTrap";
import { dispatchWorkspace } from "./WorkspaceStore";

/**
 * 「从媒体池选择…」的小选择列表(R10 U-17 / U-18):空槽位与空章占位上按一下就弹出,
 * 列当前池里「收藏 ∪ ≥3 星」且还不在带上的素材,点一条即加入(走 `useBandDrag.insert`
 * —— 与拖排同一条 `set_story_order` 写入路径,可撤销)。这是不靠拖拽的第二条路。
 *
 * 弹层压在镜头带栏内,进模态栈(Esc 由栈顶决定),点外面即收起。
 */
/** 这条为什么在列表里:收藏 / n 星 / 有精选段(只靠精选段入选的素材评级是「未评」,直说更清楚)。 */
export function pickerReasonLabel(clip: ClipListItem): string {
  const label = ratingLabelFor(clip);
  return label === "未评" && clip.select_count > 0 ? `${clip.select_count} 段精选` : label;
}

export function ShotBandPicker({
  chapterTitle,
  candidates,
  busy,
  onPick,
  onClose,
}: {
  chapterTitle: string | null;
  candidates: readonly ClipListItem[];
  busy: boolean;
  onPick: (clipId: number) => void;
  onClose: () => void;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const modalToken = useRef({});
  useFocusTrap(rootRef, true);

  useEffect(() => {
    const token = modalToken.current;
    pushModal(token);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isTopModal(token)) return;
      event.stopPropagation();
      onClose();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
      popModal(token);
    };
  }, [onClose]);

  const goPool = () => {
    onClose();
    dispatchWorkspace({ type: "set-filter", filter: "all" });
    dispatchWorkspace({ type: "focus-pane", pane: "pool" });
    document.querySelector<HTMLElement>('[data-pane="pool"]')?.focus();
  };

  return (
    <div ref={rootRef} className="band-picker" role="dialog" aria-modal="false" aria-label="从媒体池选择" tabIndex={-1}>
      <div className="band-picker-head">
        <strong>{chapterTitle ? `加入「${chapterTitle}」` : "加入镜头带"}</strong>
        <span className="band-picker-rule">{`只列${TEMPLATE_POOL_RULE}的素材`}</span>
        <Button variant="icon" size="sm" icon="close" aria-label="关闭选择列表" onClick={onClose} />
      </div>
      {candidates.length === 0 ? (
        <EmptyState
          icon="heart"
          size="inline"
          title={`没有素材满足『${TEMPLATE_POOL_RULE}』`}
          body="先在媒体池按 F 收藏几条,或评到 3 星以上,再回来选。"
          action={
            <Button variant="secondary" size="sm" onClick={goPool}>
              去媒体池
            </Button>
          }
        />
      ) : (
        <ul className="band-picker-list">
          {candidates.map((clip) => (
            <li key={clip.id}>
              <button
                type="button"
                className="band-picker-item"
                disabled={busy}
                aria-label={`加入 ${clip.file_name}`}
                onClick={() => onPick(clip.id as number)}
              >
                <span className="band-picker-thumb" aria-hidden="true">
                  <CoverImage src={clip.cover_url} lazy />
                </span>
                <span className="band-picker-name">{clip.file_name}</span>
                <span className="band-picker-rating">{pickerReasonLabel(clip)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
