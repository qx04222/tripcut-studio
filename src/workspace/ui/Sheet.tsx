import type { JSX, ReactNode } from "react";
import { ModalSurface } from "./ModalSurface";

export interface SheetProps {
  open: boolean;
  title: string;
  width?: string;
  height?: string;
  onClose(): void;
  actions?: ReactNode;
  children: ReactNode;
}

/** 居中 sheet(规格 §2):默认 960 × 80vh,与 Drawer 共用 ModalSurface。 */
export function Sheet(props: SheetProps): JSX.Element | null {
  const { open, title, width = "960px", height = "80vh", onClose, actions, children } = props;
  return (
    <ModalSurface open={open} title={title} placement="center" width={width} height={height} onClose={onClose} actions={actions}>
      {children}
    </ModalSurface>
  );
}
