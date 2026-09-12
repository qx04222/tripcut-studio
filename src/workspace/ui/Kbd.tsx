import type { JSX, ReactNode } from "react";

/** 键位芯片(规格 §2 / C 稿):11px 等宽,卡面底 + 发丝边 + 2px 底边,像一颗真键帽。 */
export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="ui-kbd">{children}</kbd>;
}
