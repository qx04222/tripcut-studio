import { useEffect, useRef, type JSX, type KeyboardEvent } from "react";

export interface MenuItem {
  id: string;
  label: string;
  /** AX 名(冻结用);不给就是 label。 */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface MenuProps {
  items: readonly MenuItem[];
  /** 视口坐标(右键点在哪就在哪弹)。 */
  x: number;
  y: number;
  ariaLabel: string;
  onSelect(id: string): void;
  onClose(): void;
}

/**
 * 最小右键菜单(R11 车道 E):`role="menu"` / `menuitem`,打开即聚焦第一项;↑ ↓ Home End
 * roving,Enter / Space 选中,Esc 与点外面关闭。位置按视口钉在右键点,贴边时往回收。
 * 只做一层,没有子菜单、没有分隔线——套件要的是"够用的一个",不是菜单系统。
 */
export function Menu({ items, x, y, ariaLabel, onSelect, onClose }: MenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // 贴边:菜单尺寸只有挂上之后才量得到,先按右键点放,超出视口再往回挪。
    const rect = node.getBoundingClientRect();
    const left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.querySelector<HTMLButtonElement>("[role='menuitem']:not([disabled])")?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (!node.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose, x, y]);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])") ?? []);
    if (buttons.length === 0) return;
    const current = buttons.findIndex((button) => button === document.activeElement);
    let to: number;
    if (event.key === "ArrowDown") to = (current + 1) % buttons.length;
    else if (event.key === "ArrowUp") to = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[to]?.focus();
  };

  return (
    <div ref={ref} className="ui-menu" role="menu" aria-label={ariaLabel} tabIndex={-1} onKeyDown={move}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="ui-menu-item"
          aria-label={item.ariaLabel}
          disabled={item.disabled}
          onClick={() => {
            onSelect(item.id);
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
