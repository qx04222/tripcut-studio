import type { JSX, ReactNode } from "react";

export interface FieldProps {
  label: string;
  help?: ReactNode;
  /** 关联的控件 id;不给时标签渲染成 `<span>`(一组开关 / 一段分段选择没有单一控件)。 */
  htmlFor?: string;
  /** 行式(左标签 + 右控件,B 稿抽屉表单语法);false 时上下堆叠。 */
  inline?: boolean;
  className?: string;
  children: ReactNode;
}

/** 表单三件套(规格 §2):label 13 + 控件 + help 12 灰在下。 */
export function Field({ label, help, htmlFor, inline = true, className, children }: FieldProps): JSX.Element {
  const classes = ["ui-field", inline ? "ui-field--inline" : "ui-field--stacked", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      {htmlFor ? (
        <label className="ui-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="ui-field-label">{label}</span>
      )}
      <div className="ui-field-control">{children}</div>
      {help ? <p className="ui-field-help">{help}</p> : null}
    </div>
  );
}
