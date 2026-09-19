import { useState, type JSX } from "react";

import { importWhisperModel, pickWhisperModelFile, type ComponentStatus } from "../../api";
import { Button } from "../ui";

export interface WhisperModelCardProps {
  /** `whisper-model` 组件状态(带官方地址 / 期望摘要 / 目标路径);没读到也能渲染按钮。 */
  component: ComponentStatus | undefined;
  busy: boolean;
  /** 导入成功后重新检测(model_available 翻绿由 SettingsStatus 决定)。 */
  onImported(): Promise<void>;
}

async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  throw new Error("当前 WebView 不允许写入剪贴板");
}

/**
 * R10 U-24 → R19 P-06:Whisper 模型缺失态的**离线兜底**。主路径已经是上方模型卡的「安装」
 * (后台下载 + 校验 + 自动启用);这张卡留给没法联网 / 想自己下的人:「去哪下 / 核对什么 / 放哪」
 * 三件事摆出来,再给一条不用手动拷文件的路:「导入模型文件…」(系统面板选文件 → 后端校验 SHA-256 后原子落位)。
 */
export function WhisperModelCard({ component, busy, onImported }: WhisperModelCardProps): JSX.Element {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const onImport = async () => {
    if (importing) return;
    setError(null);
    setNotice(null);
    try {
      const path = await pickWhisperModelFile();
      if (!path) return;
      setImporting(true);
      const outcome = await importWhisperModel(path);
      await onImported().catch(() => undefined);
      setNotice(
        outcome.matches_active_tier
          ? `已导入 ${outcome.file_name}（${outcome.tier}）`
          : `已导入 ${outcome.file_name}（${outcome.tier}），与当前档位不同——把上方档位切到 ${outcome.tier} 即可启用`,
      );
    } catch (importError) {
      setError(String(importError));
    } finally {
      setImporting(false);
    }
  };

  const onCopy = async () => {
    if (!component?.download_url) return;
    try {
      await copyText(component.download_url);
      setNotice("下载地址已复制");
    } catch (copyError) {
      setError(`复制失败：${String(copyError)}`);
    }
  };

  return (
    <div className="settings-sheet-readout settings-whisper-model" role="group" aria-label="转写模型文件">
      <small>没法联网、或想自己下载?下面是官方地址与校验码;下好后用「导入模型文件…」。</small>
      <dl className="settings-whisper-model-facts">
        <div>
          <dt>官方下载地址</dt>
          <dd>
            <code>{component?.download_url ?? "等待检测"}</code>
            <Button size="sm" variant="ghost" disabled={!component?.download_url} onClick={() => void onCopy()}>
              复制下载地址
            </Button>
          </dd>
        </div>
        <div>
          <dt>期望 SHA-256</dt>
          <dd>
            <code>{component?.expected_sha256 ?? "等待检测"}</code>
          </dd>
        </div>
        <div>
          <dt>目标路径</dt>
          <dd>
            <code>{component?.target_path ?? "等待检测"}</code>
          </dd>
        </div>
      </dl>
      <div className="settings-whisper-model-actions">
        <Button size="sm" disabled={busy} busy={importing} onClick={() => void onImport()}>
          {importing ? "正在校验并导入…" : "导入模型文件…"}
        </Button>
        <small>浏览器下载后在这里选中文件即可；应用会核对校验码再复制进模型目录，源文件不动（大文件算摘要要几秒）。</small>
      </div>
      {error ? (
        <p className="settings-sheet-inline-notice is-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="settings-sheet-inline-notice" role="status" aria-live="polite">
        {notice ?? ""}
      </p>
    </div>
  );
}
