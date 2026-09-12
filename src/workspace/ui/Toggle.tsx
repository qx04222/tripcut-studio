import type { JSX } from "react";

export interface ToggleProps {
  checked: boolean;
  onChange(next: boolean): void;
  /** AX 名(不可见;可见文案由旁边的 Field / 行标签负责)。 */
  label: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** 32×18 滑块,`role="switch" aria-checked`(规格 §2、§6)。 */
export function Toggle({ checked, onChange, label, disabled = false, id, className }: ToggleProps): JSX.Element {
  const classes = ["ui-toggle", checked ? "ui-toggle--on" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={classes}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="ui-toggle-knob" aria-hidden="true" />
    </button>
  );
}
