import { useEffect, useRef, type MouseEvent } from "react";

import {
  HELP_FAQS,
  KEYBOARD_SHORTCUT_GROUPS,
  PIPELINE_MANUAL,
  SETTINGS_HELP_TOPICS,
  WORKFLOW_STEPS,
  shortcutKeys,
  shortcutsById,
} from "./helpContent";
import { useKeymap } from "./workspace/keymapStore";
import { isTopModal, popModal, pushModal } from "./workspace/modalStack";

interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), details summary, [tabindex]:not([tabindex="-1"])';

export function HelpOverlay({ open, onClose }: HelpOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // R13 §1:键帽随当前键位预设 / 自定义变化。
  const keymap = useKeymap();

  // 帮助层之上还能开命令面板(Cmd+K)。两层的 Esc 监听都挂在 document 上,
  // `stopPropagation()` 管不到同一节点上的兄弟监听,于是一次 Esc 会把两层一起
  // 关掉。改成只有自己是模态栈顶层时才响应,和 Drawer/CommandPalette 同一套
  // 模式(R8 终审 L9)。
  const modalToken = useRef({});
  useEffect(() => {
    if (!open) return;
    const token = modalToken.current;
    pushModal(token);
    return () => popModal(token);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!isTopModal(modalToken.current)) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="help-backdrop" role="presentation" onMouseDown={closeFromBackdrop}>
      <div
        className="help-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-dialog-title"
      >
        <header className="help-dialog-header">
          <div>
            <span>中文帮助</span>
            <h2 id="help-dialog-title">流水线手册</h2>
            <p>四步走完就是一集:导入 → 挑选 → 排列 → 导出。顶栏右上角永远有「下一步」。</p>
          </div>
          <button
            className="help-close"
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="关闭帮助"
          >
            <span aria-hidden="true">×</span>
            关闭
          </button>
        </header>

        <div className="help-dialog-scroll">
          <section className="help-section pipeline-manual" aria-labelledby="pipeline-manual-title">
            <div className="help-section-heading">
              <span>00 · 四步</span>
              <div>
                <h3 id="pipeline-manual-title">每一步怎么做</h3>
                <p>每步三句话,后面跟着这一步用得上的键。</p>
              </div>
            </div>
            <ol className="pipeline-manual-steps">
              {PIPELINE_MANUAL.map((entry) => (
                <li className="pipeline-manual-step" key={entry.step} data-pipeline-step={entry.step}>
                  <div className="pipeline-manual-head">
                    <span className="pipeline-manual-index" aria-hidden="true">{entry.step}</span>
                    <strong>{`第 ${entry.step} 步 · ${entry.title}`}</strong>
                  </div>
                  <ol className="pipeline-manual-howto">
                    {entry.howTo.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ol>
                  <div className="pipeline-manual-keys" aria-label={`第 ${entry.step} 步快捷键`}>
                    {shortcutsById(entry.shortcutIds).map((shortcut) => (
                      <span className="pipeline-manual-key" key={shortcut.id}>
                        <span className="shortcut-keys">
                          {shortcutKeys(shortcut, keymap.table).map((key) => <kbd key={key}>{key}</kbd>)}
                        </span>
                        <small>{shortcut.action}</small>
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="help-section workflow-help" aria-labelledby="workflow-help-title">
            <div className="help-section-heading">
              <span>01 · 界面导览</span>
              <div>
                <h3 id="workflow-help-title">一屏三栏</h3>
                <p>顶栏进出，三栏分工：左边找素材，中间看画面、排顺序，右边改这一条。</p>
              </div>
            </div>
            <ol className="workflow-map">
              {WORKFLOW_STEPS.map((step, index) => (
                <li key={step.id}>
                  <span className="workflow-step-number">{step.number}</span>
                  <div>
                    <small>{step.eyebrow}</small>
                    <strong>{step.label}</strong>
                    <p>{step.description}</p>
                  </div>
                  {index < WORKFLOW_STEPS.length - 1 ? (
                    <span className="workflow-arrow" aria-hidden="true">→</span>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>

          <section className="help-section" aria-labelledby="shortcut-help-title">
            <div className="help-section-heading">
              <span>02 · 快捷键</span>
              <div>
                <h3 id="shortcut-help-title">快捷键总表</h3>
                <p>中文输入法正在组词时，单键操作会自动暂停。</p>
              </div>
            </div>
            <div className="shortcut-tables">
              {KEYBOARD_SHORTCUT_GROUPS.map((group) => (
                <section className="shortcut-table" aria-label={`${group.label}快捷键`} key={group.id}>
                  <header>
                    <span>{group.eyebrow}</span>
                    <strong>{group.label}</strong>
                    <small>{group.shortcuts.length} 项</small>
                  </header>
                  <div>
                    {group.shortcuts.map((shortcut) => (
                      <div className="shortcut-row" key={shortcut.id}>
                        <span className="shortcut-keys">
                          {shortcutKeys(shortcut, keymap.table).map((key) => <kbd key={key}>{key}</kbd>)}
                        </span>
                        <strong>{shortcut.action}</strong>
                        <small>{shortcut.detail}</small>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </section>

          <section className="help-section settings-help" aria-labelledby="settings-help-title">
            <div className="help-section-heading">
              <span>03 · 设置</span>
              <div>
                <h3 id="settings-help-title">设置页导览</h3>
                <p>每个分区做什么、隐私与诊断信息去了哪里。</p>
              </div>
            </div>
            <div className="settings-help-topics">
              {SETTINGS_HELP_TOPICS.map((topic) => (
                <article data-help-topic={topic.id} key={topic.id}>
                  <header>
                    <span>{topic.eyebrow}</span>
                    <strong>{topic.label}</strong>
                    <small>{topic.description}</small>
                  </header>
                  {topic.paragraphs.map((paragraph, index) => (
                    <p key={index}>{paragraph}</p>
                  ))}
                </article>
              ))}
            </div>
          </section>

          <section className="help-section faq-help" aria-labelledby="faq-help-title">
            <div className="help-section-heading">
              <span>04 · 常见问题</span>
              <div>
                <h3 id="faq-help-title">常见问题</h3>
                <p>围绕本机工具链、剪映交付和素材安全。</p>
              </div>
            </div>
            <div className="faq-list">
              {HELP_FAQS.map((faq, index) => (
                <details key={faq.id} open={index === 0}>
                  <summary>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    {faq.question}
                    <i aria-hidden="true">＋</i>
                  </summary>
                  <p>{faq.answer}</p>
                </details>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
