import { useRef, type JSX, type KeyboardEvent } from "react";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  items: readonly TabItem[];
  value: string;
  onChange(id: string): void;
  ariaLabel: string;
  className?: string;
}

/**
 * 下划线式分页(规格 §2):`role="tablist"` / `tab` + `aria-selected`;tab 的 AX 名只有
 * label(计数放在 `aria-hidden` 的 span 里,不进名字——冒烟脚本按「任务」找,不按「任务 3」)。
 * 键盘:← → Home End 在 tab 间 roving,移动即选中(自动激活)。
 */
export function Tabs({ items, value, onChange, ariaLabel, className }: TabsProps): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  const classes = ["ui-tabs", className ?? ""].filter(Boolean).join(" ");

  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    let to: number;
    if (event.key === "ArrowRight") to = (from + 1) % items.length;
    else if (event.key === "ArrowLeft") to = (from - 1 + items.length) % items.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = items.length - 1;
    else return;
    event.preventDefault();
    const target = items[to];
    if (!target) return;
    onChange(target.id);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']");
    buttons?.[to]?.focus();
  };

  return (
    <div ref={listRef} role="tablist" aria-label={ariaLabel} className={classes}>
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={selected ? "ui-tab ui-tab--selected" : "ui-tab"}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => move(event, index)}
          >
            <span className="ui-tab-label">{item.label}</span>
            {item.count !== undefined ? (
              <span className="ui-tab-count" aria-hidden="true">
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
