import type { ComponentPropsWithRef, JSX } from "react";
import { Icon, type IconName } from "./icons";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "icon";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  /** primary = 强调底白字;secondary = 卡面 + 发丝边;ghost = 透明 hover 出底;icon = 28×28 方形。 */
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: IconName;
  /** 进行中:aria-busy + disabled,onClick 不再触发。 */
  busy?: boolean;
  tone?: "neutral" | "danger";
}

/**
 * 套件按钮(规格 §2)。`type="button"` 默认给上,表单里要提交的自己传 `type="submit"`。
 * `variant="icon"` 必须带 `aria-label` —— 没名字的图标按钮在 AX 树里是一个「按钮」,
 * 真机冒烟就是靠名字找控件的;缺了直接抛,别等到截图轮才发现。
 */
export function Button(props: ButtonProps): JSX.Element {
  const {
    variant = "secondary",
    size = "md",
    icon,
    busy = false,
    tone = "neutral",
    className,
    children,
    disabled,
    type = "button",
    ...rest
  } = props;

  if (variant === "icon" && !rest["aria-label"] && !rest["aria-labelledby"]) {
    throw new Error("Button variant=\"icon\" 必须给 aria-label(图标按钮不能没有名字)");
  }

  const classes = [
    "ui-button",
    `ui-button--${variant}`,
    `ui-button--${size}`,
    tone === "danger" ? "ui-button--danger" : "",
    busy ? "ui-button--busy" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {icon ? <Icon name={icon} size={size === "sm" ? 12 : 16} /> : null}
      {children !== undefined && children !== null ? <span className="ui-button-label">{children}</span> : null}
    </button>
  );
}
