import { useEffect, useRef, type JSX, type ReactNode } from "react";
import { useFocusTrap } from "../../useFocusTrap";
import { isTopModal, popModal, pushModal } from "../modalStack";

export type ModalPlacement = "left" | "right" | "center";

export interface ModalSurfaceProps {
  open: boolean;
  title: string;
  placement: ModalPlacement;
  /** CSS `width` 值,如 `"min(720px, 60vw)"` 或 `"960px"`。 */
  width: string;
  /** 只有居中 sheet 用;抽屉贴满全高。 */
  height?: string;
  onClose(): void;
  /** 标题栏右侧、关闭键之前的动作(「立即扫描」「生成」)。 */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Drawer / Sheet 共用的模态外壳(迁自 workspace/Drawer.tsx,逐段搬,四条行为一条不丢)。
 * 规格 §6:`role="dialog" aria-modal="true"` + `useFocusTrap` + Esc 关闭 + 关闭后焦点回到
 * 触发按钮(由 `useFocusTrap` 的停用清理段负责,这里不重复实现)。不改 hash —— Esc/关闭
 * 只 `onClose()`,从不碰 `window.location`。
 */
export function ModalSurface(props: ModalSurfaceProps): JSX.Element | null {
  const { open, title, placement, width, height, onClose, actions, children } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useFocusTrap(containerRef, open);

  // R8 报告说真机 `AXFocusedUIElement` 是 missing value —— useFocusTrap 只在容器外有焦点
  // 时才收进来,而 WebKit 里点了按钮后 activeElement 可能还是 body。打开时无条件把焦点
  // 放到对话框根上(tabIndex=-1),Esc 那条监听才有人听。
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) container.focus();
  }, [open]);

  // 抽屉之上还能开命令面板。两层的 Esc 监听都挂在 document 上,`stopPropagation()`
  // 管不到同一节点上的兄弟监听,于是一次 Esc 会把两层一起关掉。改成只有自己是
  // 模态栈顶层时才响应(R8 终审 L9)。
  const modalToken = useRef({});
  useEffect(() => {
    if (!open) return;
    const token = modalToken.current;
    pushModal(token);
    return () => popModal(token);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!isTopModal(modalToken.current)) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={`ui-modal-overlay ui-modal-overlay--${placement}`}
      role="presentation"
      // 点遮罩关闭。判的是"按下"的目标是不是遮罩本身 —— 只看 click 的话,在抽屉内
      // 按下、拖到遮罩上松手也会被当成"点了遮罩",选中一段文字就把抽屉关了。
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`ui-modal ui-modal--${placement}`}
        style={{ width, maxWidth: "100vw", height }}
      >
        <div className="ui-modal-titlebar">
          <div className="ui-modal-title">{title}</div>
          {actions ? <div className="ui-modal-actions">{actions}</div> : null}
          {/*
            可见的关闭控件。真机实测过(R8 收尾轮):交付抽屉开着按 Esc 没关,而抽屉
            是 `aria-modal="true"` —— 顶栏整个从 AX 树里消失,键盘那条路一断就彻底
            出不去了。Esc 不能是唯一出口。
          */}
          <button type="button" className="ui-modal-close" aria-label="关闭" onClick={onClose}>
            <span aria-hidden="true">×</span>
            <span aria-hidden="true">关闭</span>
          </button>
        </div>
        <div className="ui-modal-body">{children}</div>
      </div>
    </div>
  );
}
