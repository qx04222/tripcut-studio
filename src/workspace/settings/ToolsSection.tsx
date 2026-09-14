import { useState, type JSX } from "react";

import { enqueueMomentsBackfill, enqueueOcrForEpisode } from "../../api";
import { SETTINGS_ACTIONS } from "../copy";
import { failureText } from "../errorText";
import { Button, SectionHeader, Select, showToast } from "../ui";
import { RollbackControl, SettingsRow, StatusPill, ToolReadout } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";
import { ToolchainGuide } from "./ToolchainGuide";
import { LutFilesRow, WhisperModelDelete } from "./ManagedFilesR16";
import { WhisperModelCard } from "./WhisperModelCard";

const TOOL_PATHS = [
  { key: "tools.ffmpeg_path", componentId: "ffmpeg", title: "视频处理组件的位置", help: "负责预览、音频与导出处理;留空时自动检测。", placeholder: "自动检测", readout: "视频处理组件" },
  { key: "tools.ffprobe_path", componentId: "ffprobe", title: "媒体信息组件的位置", help: "负责读取素材的画面与声音信息；留空时自动检测。", placeholder: "自动检测", readout: "媒体信息组件" },
  { key: "tools.whisper_path", componentId: "whisper-cli", title: "转写组件的位置", help: "负责本地语音转写；留空时自动检测。", placeholder: "自动检测", readout: "转写组件" },
] as const;

export function ToolsSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings, status, componentStatuses, busy, rollbackNotice } = form;
  const toolStatus = (readout: string) =>
    readout === "视频处理组件" ? status?.ffmpeg : readout === "媒体信息组件" ? status?.ffprobe : status?.whisper.binary;
  const component = (id: string) => componentStatuses.find((entry) => entry.id === id);
  // R16 P2-5:换了更好的模型之后整集重算 —— 两条排队命令,耗时在文案里说清,结果 toast 说排了几条。
  const [rerunning, setRerunning] = useState<"moments" | "ocr" | null>(null);
  const rerun = async (kind: "moments" | "ocr") => {
    setRerunning(kind);
    try {
      const count = kind === "moments" ? await enqueueMomentsBackfill() : await enqueueOcrForEpisode();
      const what = kind === "moments" ? "时刻分" : "画面文字";
      showToast(count > 0 ? `已排队 ${count} 条素材重新${kind === "moments" ? "计算" : "识别"}${what},后台慢慢跑,不用等` : `没有需要重新${kind === "moments" ? "计算" : "识别"}的素材`, { tone: count > 0 ? "success" : "neutral" });
    } catch (error) {
      showToast(failureText(kind === "moments" ? SETTINGS_ACTIONS.recomputeMoments : SETTINGS_ACTIONS.rerunOcr, error), { tone: "danger" });
    } finally {
      setRerunning(null);
    }
  };

  return (
    <>
      <SectionHeader title="工具链" description="留空时自动在本机搜索；填写位置后，离开输入框即保存并重新检测。" />
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
          title="转写模型"
          help="应用不联网下载模型；按下方路径放置已校验的模型文件。"
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
              当前版本不提供在线下载。需要转写时，请自行核验来源与校验码后放入
              {status?.whisper.models_directory ?? "应用 models 目录"}；缺失不影响核心工作流。
            </small>
          </div>
          {/* R10 U-24:模型缺失才展开「去哪下 / 核对什么 / 放哪 / 导入」卡。 */}
          {status && !status.whisper.model_available ? (
            <WhisperModelCard component={component("whisper-model")} busy={busy} onImported={form.refreshStatus} />
          ) : null}
          <RollbackControl componentStatus={component("whisper-model")} busy={busy} onRollback={() => void form.rollbackTool("whisper-model")} />
          {/* R16 P2-6:模型在的时候才有得删;删后重新检测,缺失卡自动出现。 */}
          {status?.whisper.model_available ? (
            <WhisperModelDelete tier={settings["tools.whisper_model_tier"] ?? "large-v3-turbo"} busy={busy} onDeleted={form.refreshStatus} />
          ) : null}
        </SettingsRow>
        {/* R16 P2-6:选错的 .cube 不再永远在列表里。 */}
        <LutFilesRow />
        <SettingsRow title="画面识别组件" help={status?.clip_sidecar.note ?? "本地画面搜索服务。"} className="settings-sheet-row--stack">
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
        <SettingsRow title="整集重算" help="换了更好的模型、或觉得之前算得不准时用;会把本集每条素材重新排队,几十条要跑几分钟到十几分钟,后台进行,不影响继续筛片。" className="settings-sheet-row--stack">
          <div className="settings-sheet-actions">
            <Button size="sm" busy={rerunning === "moments"} disabled={busy || rerunning !== null} onClick={() => void rerun("moments")}>
              {SETTINGS_ACTIONS.recomputeMoments}
            </Button>
            <Button size="sm" busy={rerunning === "ocr"} disabled={busy || rerunning !== null} onClick={() => void rerun("ocr")}>
              {SETTINGS_ACTIONS.rerunOcr}
            </Button>
          </div>
        </SettingsRow>
      </div>
    </>
  );
}
