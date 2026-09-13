import type { JSX } from "react";

import { Button, SectionHeader, Select } from "../ui";
import { RollbackControl, SettingsRow, StatusPill, ToolReadout } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";
import { ToolchainGuide } from "./ToolchainGuide";
import { WhisperModelCard } from "./WhisperModelCard";

const TOOL_PATHS = [
  { key: "tools.ffmpeg_path", componentId: "ffmpeg", title: "FFmpeg 路径", help: "负责预览、音频与导出处理;留空时自动检测。", placeholder: "自动检测 ffmpeg", readout: "FFmpeg" },
  { key: "tools.ffprobe_path", componentId: "ffprobe", title: "FFprobe 路径", help: "负责读取媒体流与容器信息；留空时自动检测。", placeholder: "自动检测 ffprobe", readout: "FFprobe" },
  { key: "tools.whisper_path", componentId: "whisper-cli", title: "whisper-cli 路径", help: "负责本地语音转写；留空时自动检测。", placeholder: "自动检测 whisper-cli", readout: "Whisper" },
] as const;

export function ToolsSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings, status, componentStatuses, busy, rollbackNotice } = form;
  const toolStatus = (readout: string) =>
    readout === "FFmpeg" ? status?.ffmpeg : readout === "FFprobe" ? status?.ffprobe : status?.whisper.binary;
  const component = (id: string) => componentStatuses.find((entry) => entry.id === id);

  return (
    <>
      <SectionHeader title="工具链" description="留空时自动搜索环境变量与 PATH；填写路径后，失焦即保存并重新检测。" />
      <ToolchainGuide status={status} />
      {rollbackNotice ? (
        <p className="settings-sheet-inline-notice" role="status" aria-live="polite">
          {rollbackNotice}
        </p>
      ) : null}
      <div className="settings-sheet-group">
        {TOOL_PATHS.map((tool) => {
          const inputId = `settings-${tool.componentId}-path`;
          return (
            <SettingsRow key={tool.key} title={tool.title} help={tool.help} htmlFor={inputId} className="settings-sheet-row--stack">
              <input
                id={inputId}
                className="settings-sheet-input"
                value={settings[tool.key]}
                placeholder={tool.placeholder}
                spellCheck={false}
                onChange={(event) => form.setDraft(tool.key, event.currentTarget.value)}
                onBlur={(event) => void form.savePath(tool.key, event.currentTarget.value)}
              />
              <ToolReadout label={tool.readout} status={toolStatus(tool.readout)} />
              <RollbackControl componentStatus={component(tool.componentId)} busy={busy} onRollback={() => void form.rollbackTool(tool.componentId)} />
            </SettingsRow>
          );
        })}
        <SettingsRow
          title="Whisper 模型档位"
          help="可选模型不由应用联网下载；按状态区路径放置已校验的 ggml 文件。"
          htmlFor="settings-whisper-tier"
          className="settings-sheet-row--stack"
        >
          <Select
            id="settings-whisper-tier"
            value={settings["tools.whisper_model_tier"]}
            onChange={(event) => void form.saveWhisperTier(event.currentTarget.value)}
          >
            <option value="large-v3-turbo">large-v3-turbo / 默认质量</option>
            <option value="small">small / 低内存</option>
          </Select>
          <div className="settings-sheet-readout">
            <div className="settings-sheet-readout-head">
              <StatusPill available={status?.whisper.model_available ?? false}>
                {status?.whisper.model_available ? "模型已安装" : "模型缺失"}
              </StatusPill>
            </div>
            <code>{status?.whisper.model_path ?? "等待检测"}</code>
            <small>
              当前版本不提供在线下载。需要转写时，请自行核验来源与 SHA-256 后放入
              {status?.whisper.models_directory ?? "应用 models 目录"}；缺失不影响核心工作流。
            </small>
          </div>
          {/* R10 U-24:模型缺失才展开「去哪下 / 核对什么 / 放哪 / 导入」卡。 */}
          {status && !status.whisper.model_available ? (
            <WhisperModelCard component={component("whisper-model")} busy={busy} onImported={form.refreshStatus} />
          ) : null}
          <RollbackControl componentStatus={component("whisper-model")} busy={busy} onRollback={() => void form.rollbackTool("whisper-model")} />
        </SettingsRow>
        <SettingsRow title="Chinese-CLIP 画面识别组件" help={status?.clip_sidecar.note ?? "本地画面搜索服务。"} className="settings-sheet-row--stack">
          <div className="settings-sheet-readout">
            <div className="settings-sheet-readout-head">
              <StatusPill available={status?.clip_sidecar.available ?? false}>
                {status?.clip_sidecar.available
                  ? "已安装"
                  : status?.clip_sidecar.service_available === false
                    ? "资源缺失"
                    : "未安装"}
              </StatusPill>
            </div>
            <code>{status?.clip_sidecar.venv_path ?? "等待检测"}</code>
          </div>
          <Button size="sm" disabled={busy || !status?.clip_sidecar.available} onClick={() => void form.runSelfCheck()}>
            {status?.clip_sidecar.available ? "运行自检" : "组件尚未提供"}
          </Button>
        </SettingsRow>
      </div>
    </>
  );
}
