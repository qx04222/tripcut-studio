import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getSettingsStatus, type SettingsStatus } from "./api";

interface GuideStep {
  id: string;
  title: string;
  description: string;
  command?: string;
  commandLabel?: string;
  tone?: "danger";
}

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

export function onboardingSteps(status: SettingsStatus): GuideStep[] {
  const steps: GuideStep[] = [];

  if (!status.ffmpeg.available || !status.ffprobe.available || !status.whisper.binary.available) {
    steps.push({
      id: "bundled-tools-missing",
      title: "核心媒体工具不完整",
      description: "正式安装包应自带 FFmpeg、FFprobe 与 Whisper。请重新安装完整 DMG；不要自行修改 .app 内容，否则会破坏签名。",
      tone: "danger",
    });
  }

  if (!status.whisper.model_available) {
    steps.push({
      id: "whisper-model",
      title: "可选：提供已校验的 Whisper 模型",
      description: `当前正式版不会联网下载模型。需要本地转写时，请将已合法取得并核验的对应 ggml 模型放到：${status.whisper.model_path}；不安装不会影响导入、筛片、播放与交付。`,
    });
  }

  if (!status.clip_sidecar.service_available) {
    steps.push({
      id: "sidecar-resource",
      title: "应用资源不完整",
      description: `未找到 ${status.clip_sidecar.service_path}。请重新安装完整 DMG；不要在 .app 内手工补文件，否则会破坏签名。`,
      tone: "danger",
    });
  } else if (!status.clip_sidecar.available) {
    steps.push({
      id: "clip-sidecar",
      title: "初始化本地 Chinese-CLIP 环境",
      description: "正式版不在线安装 Python 运行环境。画面语义搜索将在签名组件包可用后启用；其余核心筛片与交付不受影响。",
    });
  }

  return steps;
}

export function FirstRunGuide() {
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
  const open = !dismissed && (checking || Boolean(error) || steps.length > 0);

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
        setDismissed(true);
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
  }, [open]);

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
          <span className="first-run-kicker">FIRST RUN / 本机准备</span>
          <h2 id="first-run-title">先把本地工具链接好</h2>
          <p>正式安装包已包含核心媒体工具；可选模型当前不会由应用联网下载。下面的检测不会上传素材。</p>
        </header>

        {checking ? (
          <div className="first-run-state" role="status">正在检测 FFmpeg、Whisper 与 Chinese-CLIP…</div>
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
            <button className="first-run-primary" type="button" onClick={() => setDismissed(true)}>
              暂时进入工作台
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
