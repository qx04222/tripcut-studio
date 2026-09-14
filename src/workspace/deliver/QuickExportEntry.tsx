import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Button } from "../ui";
import { Menu } from "../ui/Menu";
import { poolRatingMenuItems, runPoolRatingMenuItem } from "../poolRatingMenu";
import { requestQuickExport } from "./quickExportModel";

/**
 * R11 车道 E:「导出所选…」的两个入口。检查器「精选段」区一颗按钮(只导这条素材的这些段);
 * 媒体池多选右键菜单一项(只导这些素材的段与收藏)。两者都只是把选择交给交付抽屉的
 * 快速导出(`requestQuickExport`),自己不发命令。
 */

export function ExportSelectedButton({ segmentIds, disabled }: { segmentIds: readonly number[]; disabled?: boolean }): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      icon="deliver"
      aria-label="导出所选"
      title="只把这些精选段导出成视频文件"
      disabled={disabled || segmentIds.length === 0}
      onClick={() => requestQuickExport({ segment_ids: [...segmentIds] })}
    >
      导出所选…
    </Button>
  );
}

interface PoolMenuState {
  x: number;
  y: number;
  clipIds: number[];
}

/** 右键点在哪张卡上:卡片 id 是 `pool-clip-<clip id>`(MediaPool 已有的锚点约定)。 */
function clipIdFromTarget(target: EventTarget | null): number | null {
  const cell = (target as HTMLElement | null)?.closest?.("[role='gridcell']") as HTMLElement | null;
  const match = cell?.id.match(/^pool-clip-(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * 媒体池的右键菜单。挂在 `.media-pool` 里、网格旁边,自己去找同级的 `role="grid"` 监听
 * `contextmenu`(MediaPool.tsx 只追加一行,不改网格那段)。右键点中的卡在多选里就导整批
 * 多选,不在就只导它一张。
 */
export function PoolExportContextMenu({ multiSelection }: { multiSelection: readonly number[] }): JSX.Element | null {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<PoolMenuState | null>(null);
  const selectionRef = useRef(multiSelection);
  selectionRef.current = multiSelection;

  useEffect(() => {
    const grid = hostRef.current?.parentElement?.querySelector<HTMLElement>("[role='grid']");
    if (!grid) return;
    const onContextMenu = (event: MouseEvent) => {
      const clicked = clipIdFromTarget(event.target);
      if (clicked === null) return;
      event.preventDefault();
      const selected = selectionRef.current;
      const clipIds = selected.includes(clicked) ? [...selected] : [clicked];
      setMenu({ x: event.clientX, y: event.clientY, clipIds });
    };
    grid.addEventListener("contextmenu", onContextMenu);
    return () => grid.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const close = useCallback(() => setMenu(null), []);

  return (
    <div ref={hostRef} className="pool-context-menu-host">
      {menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          ariaLabel="素材操作"
          items={[
            // R16 车道 B(P1-5):收藏 / 拒绝 / 清除评级(n 条)三项追加在前(规格 §1 素材卡菜单顺序)。
            ...poolRatingMenuItems(menu.clipIds.length),
            { id: "export", label: menu.clipIds.length > 1 ? `导出所选（${menu.clipIds.length} 条）…` : "导出所选…", ariaLabel: "导出所选" },
          ]}
          onSelect={(id) => {
            if (runPoolRatingMenuItem(id, menu.clipIds)) return;
            requestQuickExport({ clip_ids: menu.clipIds });
          }}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
