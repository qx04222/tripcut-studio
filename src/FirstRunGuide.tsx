import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getSettingsStatus, setFirstRunDone, type SettingsStatus } from "./api";
import { onboardingSteps, requiredToolsMissing } from "./toolchainSteps";


const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Tauri WebView may expose the API while denying the write; use the DOM fallback below.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("当前 WebView 不允许写入剪贴板");
}


/**
 * R10 U-22:弹与不弹只看 `onboarding.first_run_done`(由 App 按 settings 判,false 才挂本组件)。
 * 「暂时进入」/ Esc 把它写成 true 并通过 `onDismiss` 通知 App——本次启动内切新旧壳、恢复页之后都不再重放;
 * 「打开安装向导」只收起,由向导走完时写 true。工具链齐全没有步骤可讲时也静默写 true,下次启动不再检测。
 */
export function FirstRunGuide({ onDismiss }: { onDismiss?: () => void } = {}) {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [copyNotice, setCopyNotice] = useState("");
  const dialogRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setStatus(await getSettingsStatus());
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const steps = useMemo(() => (status ? onboardingSteps(status) : []), [status]);
  // R11 简化专项 #1:新用户第一眼看到的是工作区里的三步引导卡,不再是这个弹窗。
  // 只有 ffmpeg / ffprobe 这种必需组件缺失(没有它们导入导出都做不了)才自动弹;
  // 检测中 / 检测失败 / 只缺可选组件都不弹 —— 可选项在 设置 → 工具与模型 里能看到。
  // 一旦因必需组件缺失而弹出,就保持打开直到用户关掉——「重新检测」中途不闪一下。
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!checking && !error && status !== null && requiredToolsMissing(status)) setArmed(true);
  }, [checking, error, status]);
  const open = armed && !dismissed;

  const finish = useCallback(() => {
    setDismissed(true);
    void setFirstRunDone().catch(() => undefined);
    onDismiss?.();
  }, [onDismiss]);

  useEffect(() => {
    // 必需组件齐全 = 首启引导无事可做:记成已完成,不再每次启动都探一遍工具链。
    // (可选组件缺不缺都不弹,也一样记完成;检测失败不记,下次启动再探一次。)
    if (!dismissed && !checking && !error && status && !requiredToolsMissing(status)) finish();
  }, [checking, dismissed, error, finish, status]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    dialog?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
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
  }, [finish, open]);

  if (!open) return null;

  const copyCommand = async (command: string, label: string) => {
    try {
      await writeClipboard(command);
      setCopyNotice(`${label}已复制`);
    } catch (copyError) {
      setCopyNotice(`复制失败：${String(copyError)}；请手动选择命令。`);
    }
  };

  const openSetupWizard = () => {
    setDismissed(true);
    onDismiss?.();
    window.location.hash = "/settings";
    window.setTimeout(() => window.dispatchEvent(new CustomEvent("tripcut:open-wizard")), 120);
  };

  return (
    <div className="first-run-backdrop" role="presentation">
      <section
        className="first-run-guide"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-title"
        tabIndex={-1}
      >
        <header>
          <span className="first-run-kicker">本机准备</span>
          <h2 id="first-run-title">先把本地工具链接好</h2>
          <p>正式安装包已包含核心媒体工具,这次没找到。下面的检测不会上传素材。</p>
        </header>

        {checking ? (
          <div className="first-run-state" role="status">正在检测视频处理、转写与画面识别组件…</div>
        ) : error ? (
          <div className="first-run-state error" role="alert">
            <strong>工具链检测失败</strong>
            <span>{error}</span>
          </div>
        ) : (
          <ol className="first-run-steps">
            {steps.map((step, index) => (
              <li className={step.tone === "danger" ? "danger" : undefined} key={step.id}>
                <span className="first-run-index">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                  {step.command ? (
                    <div className="first-run-command">
                      <code>{step.command}</code>
                      <button type="button" onClick={() => void copyCommand(step.command!, step.commandLabel ?? "命令")}>
                        {step.commandLabel ?? "复制命令"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}

        <footer>
          <span role="status" aria-live="polite">{copyNotice}</span>
          <div>
            <button className="first-run-secondary" type="button" disabled={checking} onClick={() => void refresh()}>
              重新检测
            </button>
            <button className="first-run-secondary" type="button" onClick={openSetupWizard}>
              打开安装向导
            </button>
            <button className="first-run-primary" type="button" onClick={finish}>
              暂时进入工作台
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
export { onboardingSteps, type GuideStep } from "./toolchainSteps";
