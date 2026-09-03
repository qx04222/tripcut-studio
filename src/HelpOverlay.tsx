import { useEffect, useRef, type MouseEvent } from "react";

import {
  HELP_FAQS,
  KEYBOARD_SHORTCUT_GROUPS,
  WORKFLOW_STEPS,
} from "./helpContent";

interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), details summary, [tabindex]:not([tabindex="-1"])';

export function HelpOverlay({ open, onClose }: HelpOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
    <div className="help-backdrop" onMouseDown={closeFromBackdrop}>
      <div
        className="help-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-dialog-title"
      >
        <header className="help-dialog-header">
          <div>
            <span>FIELD GUIDE / 中文帮助</span>
            <h2 id="help-dialog-title">从一堆旅途素材，到可继续精剪的故事</h2>
            <p>所有说明都对应本机工作流；快捷键列表直接由界面共用常量生成。</p>
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
          <section className="help-section workflow-help" aria-labelledby="workflow-help-title">
            <div className="help-section-heading">
              <span>01 / WORKFLOW</span>
              <div>
                <h3 id="workflow-help-title">五步工作流</h3>
                <p>先收束，再组织，最后交给熟悉的剪辑工具。</p>
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
              <span>02 / SHORTCUTS</span>
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
                          {shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}
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

          <section className="help-section faq-help" aria-labelledby="faq-help-title">
            <div className="help-section-heading">
              <span>03 / FAQ</span>
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
