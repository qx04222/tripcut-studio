import type { ComponentPropsWithRef, ElementType, JSX, ReactNode } from "react";

export type CardLevel = "card" | "raised";

export interface CardProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  /** card = 卡片阴影;raised = 浮层阴影(popover / 拖动中的瓦片)。 */
  level?: CardLevel;
  /** hover 上浮 1px + 边变 strong;配 `as="button"` 才能点。 */
  interactive?: boolean;
  /** 双圈强调环。 */
  selected?: boolean;
  padding?: 3 | 4;
  /** 渲染成什么标签;`"button"` 时自动补 `type="button"`。 */
  as?: "div" | "button" | "article" | "section" | "li";
  /** 只对 `as="button"` 生效(模板卡在只读历史集里禁用)。 */
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/** 圆角 10 + card 阴影(规格 §2)。 */
export function Card(props: CardProps): JSX.Element {
  const {
    level = "card",
    interactive = false,
    selected = false,
    padding = 3,
    as = "div",
    disabled,
    className,
    children,
    ...rest
  } = props;
  const Tag = as as ElementType;
  const classes = [
    "ui-card",
    `ui-card--${level}`,
    `ui-card--pad-${padding}`,
    interactive ? "ui-card--interactive" : "",
    selected ? "ui-card--selected" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const extra = as === "button" ? { type: "button" as const, disabled } : {};
  return (
    <Tag {...extra} {...rest} className={classes} aria-pressed={as === "button" && selected ? true : undefined}>
      {children}
    </Tag>
  );
}
