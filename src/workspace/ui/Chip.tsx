import type { ComponentPropsWithoutRef, JSX, MouseEventHandler, ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export type ChipTone = "neutral" | "accent" | "warn" | "danger";

export interface ChipProps extends Omit<ComponentPropsWithoutRef<"button">, "onClick" | "children"> {
  selected?: boolean;
  /** 右侧计数,进 AX 名(「全部 60」)。 */
  count?: number;
  tone?: ChipTone;
  icon?: IconName;
  /** 给了就渲染 `<button aria-pressed>`;不给是静态 `<span>`,不进 tab 序。 */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
}

/** 24px 高胶囊(规格 §2)。selected = 强调 tint + 强调边。 */
export function Chip(props: ChipProps): JSX.Element {
  const { selected = false, count, tone = "neutral", icon, onClick, children, className, ...rest } = props;
  const classes = [
    "ui-chip",
    `ui-chip--${tone}`,
    selected ? "ui-chip--selected" : "",
    onClick ? "ui-chip--button" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      {icon ? <Icon name={icon} size={12} /> : null}
      <span className="ui-chip-label">{children}</span>
      {count !== undefined ? (
        <>
          {" "}
          <span className="ui-chip-count">{count}</span>
        </>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button {...rest} type="button" className={classes} aria-pressed={selected} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <span className={classes}>{body}</span>;
}
