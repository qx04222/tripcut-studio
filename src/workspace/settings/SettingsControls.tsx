import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import type { ComponentStatus, ToolStatus } from "../../api";
import { Badge, Button, Field } from "../ui";

/**
 * 设置 sheet 的表单原语(B 稿抽屉表单语法,A 稿密度):
 * - `SettingsRow` = 左标题 + 右控件,说明压在控件下(`Field` 行式);
 * - `Segmented` = 分段选择,按下态 `aria-pressed`;
 * - `StatusPill` / `ToolReadout` / `RollbackControl` / `ThresholdRow` 文案逐字迁自 SettingsPage。
 */

export function SettingsRow({
  title,
  help,
  htmlFor,
  align = "start",
  className,
  children,
}: {
  title: string;
  help?: ReactNode;
  htmlFor?: string;
  /** end = 控件贴右(开关行);start = 控件贴标签(选择器 / 输入框)。 */
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const classes = ["settings-sheet-row", `settings-sheet-row--${align}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <Field label={title} help={help} htmlFor={htmlFor} className={classes}>
      {children}
    </Field>
  );
}

export function Segmented({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<readonly [value: string, label: string]>;
  value: string;
  onChange(value: string): void;
}): JSX.Element {
  return (
    <div className="settings-sheet-segmented">
      {options.map(([optionValue, label]) => (
        <button
          type="button"
          key={optionValue}
          className={value === optionValue ? "is-on" : undefined}
          aria-pressed={value === optionValue}
          onClick={() => onChange(optionValue)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function StatusPill({ available, children }: { available: boolean; children: string }): JSX.Element {
  return (
    <Badge tone={available ? "accent" : "warn"} icon={available ? "check" : "warning"}>
      {children}
    </Badge>
  );
}

export function ToolReadout({ label, status }: { label: string; status: ToolStatus | undefined }): JSX.Element {
  return (
    <div className="settings-sheet-readout">
      <div className="settings-sheet-readout-head">
        <strong>{label}</strong>
        <StatusPill available={status?.available ?? false}>
          {status?.available ? "已就绪" : "未找到"}
        </StatusPill>
      </div>
      {/* R12 术语 v2:路径与版本号收进「详情」,新手只看到「视频处理组件 已就绪」一行。 */}
      <details className="settings-sheet-readout-details">
        <summary>详情</summary>
        <code>{status?.resolved_path || "等待检测"}</code>
        <small>{status?.version ?? status?.note ?? "读取版本首行确认工具可执行"}</small>
      </details>
    </div>
  );
}

export function RollbackControl({
  componentStatus,
  busy,
  onRollback,
}: {
  componentStatus: ComponentStatus | undefined;
  busy: boolean;
  onRollback: () => void;
}): JSX.Element | null {
  if (!componentStatus?.has_previous) return null;
  return (
    <div className="settings-sheet-rollback">
      <Button size="sm" disabled={busy} onClick={onRollback}>
        回滚到上一版
      </Button>
      {componentStatus.previous_version ? (
        <small>上一版本：{componentStatus.previous_version}</small>
      ) : null}
    </div>
  );
}

export interface ThresholdRowProps {
  label: string;
  description: string;
  settingKey: string;
  value: string;
  defaultValue: string;
  min: string;
  max: string;
  step: string;
  onChange: (key: string, value: string) => void;
  deferCommit?: boolean;
}

/** range + 数值读出 + 恢复默认;`deferCommit` 时拖动中不落盘,松手 / 键盘步进 / 失焦才提交。 */
export function ThresholdRow({
  label,
  description,
  settingKey,
  value,
  defaultValue,
  min,
  max,
  step,
  onChange,
  deferCommit = false,
}: ThresholdRowProps): JSX.Element {
  const [draft, setDraft] = useState(value);
  const lastSubmittedRef = useRef(value);
  useEffect(() => {
    setDraft(value);
    lastSubmittedRef.current = value;
  }, [value]);
  const shownValue = deferCommit ? draft : value;
  const commit = (nextValue: string) => {
    if (lastSubmittedRef.current === nextValue) return;
    lastSubmittedRef.current = nextValue;
    onChange(settingKey, nextValue);
  };
  return (
    <SettingsRow title={label} help={description} className="settings-sheet-row--threshold">
      <div className="settings-sheet-threshold">
        <input
          aria-label={label}
          type="range"
          min={min}
          max={max}
          step={step}
          value={shownValue}
          onChange={(event) => {
            const nextValue = event.currentTarget.value;
            if (deferCommit) setDraft(nextValue);
            else onChange(settingKey, nextValue);
          }}
          onPointerUp={(event) => {
            if (deferCommit) commit(event.currentTarget.value);
          }}
          onKeyUp={(event) => {
            if (deferCommit && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              commit(event.currentTarget.value);
            }
          }}
          onBlur={(event) => {
            if (deferCommit) commit(event.currentTarget.value);
          }}
        />
        {/* 不用 <output>:它的隐含角色是 status,会跟页脚状态行抢 role=status。 */}
        <span className="settings-sheet-threshold-value" aria-hidden="true">{Number(shownValue).toFixed(2)}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (deferCommit) setDraft(defaultValue);
            commit(defaultValue);
          }}
        >
          恢复默认
        </Button>
      </div>
    </SettingsRow>
  );
}

/** 两格读数(「本月调用 12 / 200」「状态 已关闭」),预算熔断时整块转 warn。 */
export function BudgetMeter({
  exhausted,
  cells,
}: {
  exhausted: boolean;
  cells: ReadonlyArray<readonly [label: string, value: ReactNode]>;
}): JSX.Element {
  return (
    <div className={exhausted ? "settings-sheet-meter is-exhausted" : "settings-sheet-meter"}>
      {cells.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

/** 静默的说明块(隐私条款 / generated 目录说明):标题 13 + 段落 12。 */
export function Note({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="settings-sheet-note">
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
