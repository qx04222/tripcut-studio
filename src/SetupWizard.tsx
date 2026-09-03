import { useCallback, useEffect, useState } from "react";

import {
  cancelComponentInstall,
  getComponentStatuses,
  getInstallProgress,
  getLlmStatus,
  openProviderLogin,
  startComponentInstall,
  type ComponentStatus,
} from "./api";

interface SetupWizardProps {
  onClose: () => void;
}

const PROVIDER_COPY: Record<string, { name: string; installHint: string }> = {
  claude: { name: "Claude Code", installHint: "npm install -g @anthropic-ai/claude-code" },
  codex: { name: "Codex CLI", installHint: "brew install codex" },
  kimi: { name: "Kimi CLI", installHint: "参见 kimi.moonshot.cn 安装指引" },
};

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** 新手友好设置向导:组件体检→一键补齐→AI 登录(可跳过)。 */
export function SetupWizard({ onClose }: SetupWizardProps) {
  const [components, setComponents] = useState<ComponentStatus[]>([]);
  const [installing, setInstalling] = useState<Map<string, number>>(new Map());
  const [notices, setNotices] = useState<Map<string, string>>(new Map());
  const [providers, setProviders] = useState<Array<{ provider: string; available: boolean }>>([]);

  const refresh = useCallback(async () => {
    setComponents(await getComponentStatuses().catch(() => []));
    const llm = await getLlmStatus().catch(() => null);
    setProviders(llm?.providers ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 安装中组件的进度轮询
  useEffect(() => {
    if (installing.size === 0) return;
    const timer = window.setInterval(() => {
      installing.forEach((_, component) => {
        void getInstallProgress(component).then(async (progress) => {
          if (progress.done) {
            setInstalling((current) => {
              const next = new Map(current);
              next.delete(component);
              return next;
            });
            setNotices((current) => new Map(current).set(
              component,
              progress.error ? `安装失败:${progress.error}` : "已安装 ✓",
            ));
            await refresh();
          } else {
            setInstalling((current) => new Map(current).set(component, progress.downloaded_bytes));
          }
        }).catch(() => undefined);
      });
    }, 800);
    return () => window.clearInterval(timer);
  }, [installing, refresh]);

  const install = async (component: string) => {
    try {
      await startComponentInstall(component);
      setNotices((current) => new Map(current).set(component, ""));
      setInstalling((current) => new Map(current).set(component, 0));
    } catch (error) {
      setNotices((current) => new Map(current).set(component, String(error)));
    }
  };

  const missingCritical = components.some(
    (component) => !component.installed && (component.id === "ffmpeg" || component.id === "ffprobe"),
  );

  return (
    <div className="setup-wizard-backdrop">
      <div className="setup-wizard" role="dialog" aria-modal="true" aria-label="安装向导">
        <header>
          <h2>欢迎使用旅剪工作台</h2>
          <p>三步准备好一切:补齐组件 → (可选)连接 AI → 开始导入素材。原片永远只读,任何一步都可以以后再做。</p>
        </header>

        <section aria-label="组件体检">
          <h3>01 · 本机组件</h3>
          {components.map((component) => {
            const progress = installing.get(component.id);
            const notice = notices.get(component.id);
            return (
              <div className="wizard-component" key={component.id} data-ok={component.installed ? "1" : "0"}>
                <span className="wizard-dot" aria-hidden="true">{component.installed ? "●" : "○"}</span>
                <div className="wizard-copy">
                  <strong>{component.title}</strong>
                  <small>{notice || component.detail}</small>
                  {progress !== undefined ? (
                    <div className="wizard-progress">
                      <div
                        className="wizard-progress-fill"
                        style={{ width: `${Math.min(100, (progress / 1024 / 1024 / Math.max(1, component.approx_size_mb)) * 100)}%` }}
                      />
                      <span>{formatMb(progress)} / 约 {component.approx_size_mb} MB</span>
                    </div>
                  ) : null}
                </div>
                {!component.installed && component.installable && progress === undefined ? (
                  <button type="button" onClick={() => void install(component.id)}>
                    一键安装{component.approx_size_mb > 0 ? ` (约 ${component.approx_size_mb} MB)` : ""}
                  </button>
                ) : null}
                {progress !== undefined ? (
                  <button type="button" onClick={() => void cancelComponentInstall(component.id)}>取消</button>
                ) : null}
              </div>
            );
          })}
        </section>

        <section aria-label="AI 助手">
          <h3>02 · AI 助手(可选)</h3>
          <p className="wizard-hint">
            连接你已订阅的 AI 命令行后,可用 AI 描述、导演问答与智能编排。没有订阅也不影响核心功能。
          </p>
          {providers.map((provider) => {
            const copy = PROVIDER_COPY[provider.provider] ?? { name: provider.provider, installHint: "" };
            return (
              <div className="wizard-component" key={provider.provider} data-ok={provider.available ? "1" : "0"}>
                <span className="wizard-dot" aria-hidden="true">{provider.available ? "●" : "○"}</span>
                <div className="wizard-copy">
                  <strong>{copy.name}</strong>
                  <small>
                    {provider.available
                      ? "已安装;若尚未登录,点右侧按钮在终端完成登录(会打开浏览器授权)"
                      : `未安装;安装命令:${copy.installHint}`}
                  </small>
                </div>
                {provider.available ? (
                  <button type="button" onClick={() => void openProviderLogin(provider.provider)}>
                    打开终端登录
                  </button>
                ) : null}
              </div>
            );
          })}
          <button type="button" className="wizard-refresh" onClick={() => void refresh()}>
            重新检测全部
          </button>
        </section>

        <footer>
          {missingCritical ? (
            <small>提示:FFmpeg/FFprobe 未就绪时无法解析素材,建议先安装再开始。</small>
          ) : (
            <small>核心组件已就绪,随时可以开始。</small>
          )}
          <button type="button" className="wizard-done" onClick={onClose}>
            {missingCritical ? "稍后再说,先看看" : "开始使用"}
          </button>
        </footer>
      </div>
    </div>
  );
}
