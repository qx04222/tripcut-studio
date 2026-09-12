import type { ComponentPropsWithRef, JSX } from "react";
import { Icon } from "./icons";

/** 原生 `<select>` + chevron-down 覆层(规格 §2):高 28,卡面 + 发丝边。`className` 落在外套上。 */
export function Select(props: ComponentPropsWithRef<"select">): JSX.Element {
  const { className, children, ...rest } = props;
  const classes = ["ui-select", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={classes}>
      <select {...rest} className="ui-select-native">
        {children}
      </select>
      <Icon name="chevron-down" size={12} className="ui-select-chevron" />
    </span>
  );
}
