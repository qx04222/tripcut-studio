import type { JSX, ReactNode } from "react";

export interface SectionHeaderProps {
  title: ReactNode;
  /** 右侧灰色元信息(「51 / 60 条」)。 */
  meta?: ReactNode;
  actions?: ReactNode;
  /** pane = 栏标题条(13 半粗,`<div>`,栏 landmark 已有名字);section = 抽屉内分节(15,`<h3>`)。 */
  size?: "pane" | "section";
  description?: ReactNode;
  className?: string;
}

export function SectionHeader(props: SectionHeaderProps): JSX.Element {
  const { title, meta, actions, size = "section", description, className } = props;
  const classes = ["ui-section-header", `ui-section-header--${size}`, className ?? ""].filter(Boolean).join(" ");
  const titleNode =
    size === "section" ? (
      <h3 className="ui-section-header-title">{title}</h3>
    ) : (
      <div className="ui-section-header-title">{title}</div>
    );
  return (
    <div className={classes}>
      <div className="ui-section-header-row">
        {titleNode}
        {meta !== undefined && meta !== null ? <span className="ui-section-header-meta">{meta}</span> : null}
        {actions ? <div className="ui-section-header-actions">{actions}</div> : null}
      </div>
      {description ? <p className="ui-section-header-description">{description}</p> : null}
    </div>
  );
}
