import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import { clipMenuItems, runClipMenuAction, type ClipMenuContext } from "./clipMenuModel";
import { duelMenuItem, requestDuel } from "./duel/duelBus";
import { CLIP_MENU_LABEL, MORE_BUTTON_LABEL } from "./copy";
import { EpisodeMoveMenu, useEpisodeCount } from "./EpisodeMoveMenu";
import { Button, Menu } from "./ui";
import { useClipsFeed } from "./useClipsFeed";

/**
 * R16 §1(车道 A):素材卡的两个菜单入口。项目表与动作表都在 `clipMenuModel.ts`,这里只管
 * 「在哪弹、弹给哪些素材」。只读历史集里,会改数据的项禁用(导出照常)。
 */

function useReadOnly(): boolean {
  return useClipsFeed().episode.viewing !== null;
}

/** 右键点在哪张卡上:卡片 id 是 `pool-clip-<clip id>`(MediaPool 既有的锚点约定)。 */
function clipIdFromTarget(target: EventTarget | null): number | null {
  const cell = (target as HTMLElement | null)?.closest?.("[role='gridcell']") as HTMLElement | null;
  const match = cell?.id.match(/^pool-clip-(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * 媒体池右键菜单(接替 R11 只有「导出所选…」一项的 PoolExportContextMenu):挂在 `.media-pool` 里、
 * 网格旁边,自己去找同级的 `role="grid"` 监听 `contextmenu`。右键点中的卡在多选里 → 整批多选;不在 → 只它一张。
 */
export function PoolClipContextMenu({ multiSelection, context }: { multiSelection: readonly number[]; context?: ClipMenuContext }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; clipIds: number[]; clicked: number } | null>(null);
  // R17 epmove:「移到其他集…」的后半步(目标集菜单)开在同一个点。
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number; clipIds: number[] } | null>(null);
  const selectionRef = useRef(multiSelection);
  selectionRef.current = multiSelection;
  const readOnly = useReadOnly();
  const episodeCount = useEpisodeCount(menu !== null);

  useEffect(() => {
    const grid = hostRef.current?.parentElement?.querySelector<HTMLElement>("[role='grid']");
    if (!grid) return;
    const onContextMenu = (event: MouseEvent) => {
      const clicked = clipIdFromTarget(event.target);
      if (clicked === null) return;
      event.preventDefault();
      const selected = selectionRef.current;
      setMenu({ x: event.clientX, y: event.clientY, clipIds: selected.includes(clicked) ? [...selected] : [clicked], clicked });
    };
    grid.addEventListener("contextmenu", onContextMenu);
    return () => grid.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const close = useCallback(() => setMenu(null), []);
  const closeMove = useCallback(() => setMoveMenu(null), []);
  return (
    <div ref={hostRef} className="pool-context-menu-host">
      {menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          ariaLabel={CLIP_MENU_LABEL}
          items={[...clipMenuItems(menu.clipIds.length, { readOnly, canReveal: context?.canReveal, canAddToBand: context?.canAddToBand, episodeCount }), duelMenuItem(readOnly)]}
          onSelect={(id) =>
            id === "duel" ? requestDuel({ clipIds: menu.clipIds }) : void runClipMenuAction(id, menu.clipIds, {
              ...context,
              readOnly,
              revealClipId: menu.clicked,
              onMoveToEpisode: (clipIds) => setMoveMenu({ x: menu.x, y: menu.y, clipIds: [...clipIds] }),
            })
          }
          onClose={close}
        />
      ) : null}
      {moveMenu ? <EpisodeMoveMenu x={moveMenu.x} y={moveMenu.y} clipIds={moveMenu.clipIds} onClose={closeMove} /> : null}
    </div>
  );
}

/** 检查器头部的「···」:同一张项目表,作用于当前这条(它在多选里时作用于整组)。 */
export function ClipMoreButton({ clipId, multiSelection = [], context }: { clipId: number; multiSelection?: readonly number[]; context?: ClipMenuContext }): JSX.Element {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [moveAnchor, setMoveAnchor] = useState<{ x: number; y: number; clipIds: number[] } | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const closeMove = useCallback(() => setMoveAnchor(null), []);
  const readOnly = useReadOnly();
  const episodeCount = useEpisodeCount(anchor !== null);
  const clipIds = multiSelection.includes(clipId) ? [...multiSelection] : [clipId];
  return (
    <>
      <Button
        variant="icon"
        aria-label={MORE_BUTTON_LABEL}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        className="inspector-head-more"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 2 });
        }}
      >
        <span aria-hidden="true">···</span>
      </Button>
      {anchor ? (
        <Menu
          x={anchor.x}
          y={anchor.y}
          ariaLabel={CLIP_MENU_LABEL}
          items={[...clipMenuItems(clipIds.length, { readOnly, canReveal: context?.canReveal, canAddToBand: context?.canAddToBand, episodeCount }), duelMenuItem(readOnly)]}
          onSelect={(id) =>
            id === "duel" ? requestDuel({ clipIds }) : void runClipMenuAction(id, clipIds, {
              ...context,
              readOnly,
              revealClipId: clipId,
              onMoveToEpisode: (ids) => setMoveAnchor({ x: anchor.x, y: anchor.y, clipIds: [...ids] }),
            })
          }
          onClose={close}
        />
      ) : null}
      {moveAnchor ? <EpisodeMoveMenu x={moveAnchor.x} y={moveAnchor.y} clipIds={moveAnchor.clipIds} onClose={closeMove} /> : null}
    </>
  );
}
