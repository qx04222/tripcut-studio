import type { JSX, ReactNode } from "react";

export interface ToolbarProps {
  children: ReactNode;
  /** 给了才是 `role="toolbar"`(没名字的 toolbar landmark 是噪音)。 */
  ariaLabel?: string;
  /** 子项间距 2px 而不是 4px,用在栏标题条里。 */
  dense?: boolean;
  className?: string;
}

/** 28px 一行,子项 4px 间距(规格 §2);分组用 `Toolbar.Divider`,推右用 `Toolbar.Spacer`。 */
export function Toolbar({ children, ariaLabel, dense = false, className }: ToolbarProps): JSX.Element {
  const classes = ["ui-toolbar", dense ? "ui-toolbar--dense" : "", className ?? ""].filter(Boolean).join(" ");
  if (ariaLabel) {
    return (
      <div role="toolbar" aria-label={ariaLabel} className={classes}>
        {children}
      </div>
    );
  }
  return <div className={classes}>{children}</div>;
}

Toolbar.Divider = function Divider(): JSX.Element {
  return <span className="ui-toolbar-divider" aria-hidden="true" />;
};

Toolbar.Spacer = function Spacer(): JSX.Element {
  return <span className="ui-toolbar-spacer" aria-hidden="true" />;
};
