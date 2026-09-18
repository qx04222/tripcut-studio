import type { JSX, ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export interface EmptyStateProps {
  icon: IconName;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  /** pane = 栏内竖直居中;inline = 紧凑一行内嵌。 */
  size?: "pane" | "inline";
  /** dark = 压在监视器井底上。 */
  tone?: "light" | "dark";
  className?: string;
  /** R19 U-02:这张空态卡此刻是教学槽的持有者(仲裁器给的),挂 `data-teach`。 */
  teach?: string;
}

/** 空状态(规格 §2 / §3.4):图标 32 淡色 + 15 标题(`<p>`,不是 heading)+ 13 灰说明。 */
export function EmptyState(props: EmptyStateProps): JSX.Element {
  const { icon, title, body, action, size = "pane", tone = "light", className, teach } = props;
  const classes = ["ui-empty", `ui-empty--${size}`, `ui-empty--${tone}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-teach={teach}>
      <Icon name={icon} size={32} className="ui-empty-icon" />
      <p className="ui-empty-title">{title}</p>
      {body ? <p className="ui-empty-body">{body}</p> : null}
      {action ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  );
}
