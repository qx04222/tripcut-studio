import type { JSX, ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export type BadgeTone = "neutral" | "accent" | "warn" | "danger" | "ink";

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: IconName;
  className?: string;
  children: ReactNode;
}

/** 11px 角标(规格 §2):「AI 生成」「2 条候选」「缺口 1」。ink = 深底浅字,压在封面上用。 */
export function Badge({ tone = "neutral", icon, className, children }: BadgeProps): JSX.Element {
  const classes = ["ui-badge", `ui-badge--${tone}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={classes}>
      {icon ? <Icon name={icon} size={12} /> : null}
      <span className="ui-badge-label">{children}</span>
    </span>
  );
}
