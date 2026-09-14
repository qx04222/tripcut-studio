import { useEffect, type CSSProperties, type JSX } from "react";

import { Button } from "./Button";
import { Icon, type IconName } from "./icons";
import { dismissToast, useToast, type ToastItem } from "./toastStore";

export { showToast, dismissToast, useToast, type ToastItem, type ToastOptions, type ToastTone } from "./toastStore";

const TONE_ICON: Record<ToastItem["tone"], IconName> = {
  neutral: "info",
  success: "check",
  danger: "warning",
};

/**
 * R12 §3:顶部居中的单条 toast(`role=status`)。文字 + 至多一个动作 + 关闭。
 * 底边一根按停留时长流走的细线,让「它会自己走」这件事看得见;`prefers-reduced-motion`
 * 下不做动画。宿主只在工作区壳里挂一次(`ToastHost`),别在栏里各挂一份。
 */
export function ToastHost(): JSX.Element | null {
  const toast = useToast();

  // Esc 关掉当前 toast —— 只在有 toast 时监听,别跟抽屉 / sheet 的 Esc 抢。
  useEffect(() => {
    if (toast === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissToast(toast.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast]);

  if (toast === null) return null;
  const { id, text, tone, action, durationMs } = toast;
  return (
    <div className="ui-toast-host">
      <div
        key={id}
        role="status"
        className={`ui-toast ui-toast--${tone}`}
        style={{ "--toast-ms": `${durationMs}ms` } as CSSProperties}
      >
        <span className="ui-toast-icon" aria-hidden="true">
          <Icon name={TONE_ICON[tone]} size={16} />
        </span>
        <span className="ui-toast-text">{text}</span>
        {action ? (
          <Button
            variant="ghost"
            size="sm"
            className="ui-toast-action"
            onClick={() => {
              dismissToast(id);
              action.onClick();
            }}
          >
            {action.label}
          </Button>
        ) : null}
        <Button variant="icon" size="sm" icon="x" className="ui-toast-close" aria-label="关闭提示" onClick={() => dismissToast(id)} />
        <span className="ui-toast-timer" aria-hidden="true" />
      </div>
    </div>
  );
}
