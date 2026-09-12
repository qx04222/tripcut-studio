import type { JSX, ReactNode } from "react";
import { ModalSurface } from "./ModalSurface";

export interface DrawerProps {
  open: boolean;
  title: string;
  side: "left" | "right";
  /** CSS `width` 值,如 `"min(720px, 60vw)"`。 */
  width: string;
  onClose(): void;
  actions?: ReactNode;
  children: ReactNode;
}

/** 侧滑抽屉(规格 §2):标题栏 52px(20px 标题 + 右侧 actions + 可见「关闭」),贴满全高。 */
export function Drawer({ open, title, side, width, onClose, actions, children }: DrawerProps): JSX.Element | null {
  return (
    <ModalSurface open={open} title={title} placement={side} width={width} onClose={onClose} actions={actions}>
      {children}
    </ModalSurface>
  );
}
