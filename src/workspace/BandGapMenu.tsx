import { useCallback, useState, type JSX } from "react";

import { Button, Menu, type MenuItem } from "./ui";

/**
 * 缺口卡的「···」:按钮 + 就地弹出的套件 Menu。菜单项由调用方给,选中即回调并关闭。
 */
export function GapMoreMenu({
  items,
  disabled,
  onSelect,
}: {
  items: readonly MenuItem[];
  disabled: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      <Button
        variant="icon"
        size="sm"
        className="band-slot-more-button"
        aria-label="更多"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 2 });
        }}
      >
        <span aria-hidden="true">···</span>
      </Button>
      {anchor ? (
        <Menu
          items={items}
          x={anchor.x}
          y={anchor.y}
          ariaLabel="缺口更多操作"
          onClose={close}
          onSelect={(id) => {
            close();
            onSelect(id);
          }}
        />
      ) : null}
    </>
  );
}
