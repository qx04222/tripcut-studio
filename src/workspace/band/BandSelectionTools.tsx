import { useState, type JSX } from "react";
import type { BandChapter } from "../shotBandModel";
import type { RatingAction } from "../../SelectPage";
import { Button, Menu } from "../ui";

export function BandSelectionTools({ count, chapters, disabled, move, remove, rate }: {
  count: number; chapters: readonly BandChapter[]; disabled: boolean;
  move(chapterId: number | null): void; remove(): void; rate(action: RatingAction): void;
}): JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "move" | "rate" } | null>(null);
  // R22-C 验收决策:没选中时整组不占标题条(「已选 0」常驻只是噪音;aria-live 元素留着,读屏能听到数字变化)。
  return <div className="band-selection-tools">
    <span className="band-selected-count" aria-live="polite">{count > 0 ? `已选 ${count}` : ""}</span>
    {count > 0 ? <>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, kind: "move" }); }}>移到章</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, kind: "rate" }); }}>批量评级</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={remove}>移出所选</Button>
    </> : null}
    {menu ? <Menu ariaLabel={menu.kind === "move" ? "移到章" : "批量评级"} x={menu.x} y={menu.y} onClose={() => setMenu(null)}
      items={menu.kind === "move" ? chapters.map(chapter => ({ id: String(chapter.chapterId), label: chapter.title })) : [
        { id: "favorite", label: "收藏" }, { id: "reject", label: "拒绝" },
        ...[1, 2, 3, 4, 5].map(n => ({ id: String(n), label: `${n} 星` })), { id: "clear", label: "清除评级" },
      ]}
      onSelect={id => menu.kind === "move" ? move(id === "null" ? null : Number(id)) : rate(id === "clear" ? { kind: "clear" } : id === "favorite" || id === "reject" ? { kind: "binary", value: id === "favorite" ? 1 : -1 } : { kind: "star", value: Number(id) as 1 | 2 | 3 | 4 | 5 })} /> : null}
  </div>;
}
