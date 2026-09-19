import { useEffect, useState, type JSX } from "react";

import { CLIP_MODEL_DIR_KEY, enqueueMomentsBackfill, enqueueOcrForEpisode } from "../../api";
import { SETTINGS_ACTIONS } from "../copy";
import { failureText } from "../errorText";
import { loadModels, useModels } from "../modelStore";
import { Button, SectionHeader, Select, showToast } from "../ui";
import { ModelCard } from "./ModelCard";
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

/** 排队命令本该毫秒级返回;超过这个时长还没回,先说一声,免得像没按到。 */
export const RERUN_WATCHDOG_MS = 2_500;

/** R18 F7:「清空 = 用内置」这件事此前只能靠用户自己把框选中删干净。AX 名是「恢复内置 <组件名>」。 */
export const RESTORE_BUILTIN = "恢复内置";

/** R19 P-06:转写档位 → 清单里的模型 id(清单见 Rust core/model_catalog.rs)。 */
export function whisperModelIdForTier(tier: string): string {
  return tier === "small" ? "whisper-small" : "whisper-large-v3-turbo";
}
export const CLIP_MODEL_ID = "chinese-clip-vit-b-16";

export function ToolsSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings, status, componentStatuses, busy, rollbackNotice } = form;
  const toolStatus = (readout: string) =>
    readout === "视频处理组件" ? status?.ffmpeg : readout === "媒体信息组件" ? status?.ffprobe : status?.whisper.binary;
  const component = (id: string) => componentStatuses.find((entry) => entry.id === id);
  // R19 P-06:模型卡读全局 modelStore(与状态条 / 首启气泡同一份);进设置页时刷一次,
  // 装完(installed 事件)后 store 自己重读;转写模型装完再 refreshStatus 让 model_available 翻绿。
  const models = useModels();
  const whisperCard = models.cards.find((card) => card.id === whisperModelIdForTier(settings["tools.whisper_model_tier"] ?? "large-v3-turbo"));
  const clipCard = models.cards.find((card) => card.id === CLIP_MODEL_ID);
  useEffect(() => {
    void loadModels();
  }, []);
  const installedCount = models.cards.filter((card) => card.installed).length;
  const { refreshStatus } = form;
  const modelsLoaded = models.loaded;
  useEffect(() => {
    if (modelsLoaded) void refreshStatus().catch(() => undefined);
  }, [installedCount, modelsLoaded, refreshStatus]);
  // R16 P2-5:换了更好的模型之后整集重算 —— 两条排队命令,耗时在文案里说清,结果 toast 说排了几条。
  // A16-04(0.8.0 真机):按下没反应。任何一次按下都要有一条 toast:排了 n 条 / 没有要算的 /
  // 失败白话 / 后端过时不回也说一声;两个按钮只在自己在跑时禁用,不再跟着别的操作的 busy 一起灰掉。
  const [rerunning, setRerunning] = useState<"moments" | "ocr" | null>(null);
  const rerun = async (kind: "moments" | "ocr") => {
    const verb = kind === "moments" ? "计算" : "识别";
    const what = kind === "moments" ? "时刻分" : "画面文字";
    const title = kind === "moments" ? SETTINGS_ACTIONS.recomputeMoments : SETTINGS_ACTIONS.rerunOcr;
    setRerunning(kind);
    const watchdog = setTimeout(() => showToast(`「${title}」还没回话,后台可能正忙;稍后看导入抽屉的「任务」页`, { tone: "neutral" }), RERUN_WATCHDOG_MS);
    try {
      const count = kind === "moments" ? await enqueueMomentsBackfill() : await enqueueOcrForEpisode();
      clearTimeout(watchdog);
      showToast(count > 0 ? `已排队 ${count} 条素材重新${verb}${what},后台慢慢跑,不用等` : `没有需要重新${verb}的素材:每条素材都已有${what}`, { tone: count > 0 ? "success" : "neutral" });
    } catch (error) {
      clearTimeout(watchdog);
      showToast(failureText(title, error), { tone: "danger" });
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
              {/* R18 F7:填过路径才有得恢复;空框按下去什么都不会变,所以直接禁用。 */}
              <div className="settings-sheet-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${RESTORE_BUILTIN} ${tool.readout}`}
                  disabled={busy || (settings[tool.key] ?? "").trim() === ""}
                  onClick={() => {
                    form.setDraft(tool.key, "");
                    void form
                      .savePath(tool.key, "")
                      .then(() => showToast(`${tool.readout}已恢复内置:留空时自动在本机搜索`, { tone: "success" }))
                      .catch((error) => showToast(failureText(`${RESTORE_BUILTIN} ${tool.readout}`, error), { tone: "danger" }));
                  }}
                >
                  {RESTORE_BUILTIN}
                </Button>
              </div>
              <RollbackControl componentStatus={component(tool.componentId)} busy={busy} onRollback={() => void form.rollbackTool(tool.componentId)} />
            </SettingsRow>
          );
        })}
        <SettingsRow
          title="转写模型"
          help="把说话内容转成文字。点「安装」后台下载到应用的 models 目录,装完自动启用;缺失不影响导入、挑选与导出。"
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
          </div>
          {/* R19 P-06:当前档位那一张模型卡——「未安装 · 安装」/「下载中 · 取消」/「已安装 · 位置」。 */}
          {whisperCard ? <ModelCard card={whisperCard} busy={busy} /> : null}
          {/* R10 U-24 → R19:离线机器的兜底——自己下好的文件走「导入模型文件…」(校验 SHA-256 后落位)。 */}
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
          {/* R19 P-06:画面理解模型一键安装(替代此前的「组件尚未提供」灰按钮);装完自动成为侧车的模型目录。 */}
          {clipCard ? <ModelCard card={clipCard} busy={busy} /> : null}
          {/* 模型与运行环境是两件事:模型可以先装好,但 Python 运行环境仍要等签名组件包(不在本轮范围)。 */}
          {status && !status.clip_sidecar.available ? (
            <p className="settings-sheet-inline-notice" role="note">
              画面识别的运行环境还没就位(等带签名的组件包);模型可以先装好,组件到位后自动启用。
            </p>
          ) : null}
          <label className="settings-sheet-subfield" htmlFor="settings-clip-model-dir">
            <span>模型位置(留空 = 用上面自动安装的目录)</span>
            <input
              id="settings-clip-model-dir"
              className="settings-sheet-input"
              value={settings[CLIP_MODEL_DIR_KEY] ?? ""}
              placeholder={status?.clip_sidecar.model_dir ?? "自动安装目录"}
              spellCheck={false}
              onChange={(event) => form.setDraft(CLIP_MODEL_DIR_KEY, event.currentTarget.value)}
              onBlur={(event) => void form.savePath(CLIP_MODEL_DIR_KEY, event.currentTarget.value)}
            />
          </label>
          {status?.clip_sidecar.available ? (
            <Button size="sm" disabled={busy || !(status.clip_sidecar.model_available ?? true)} onClick={() => void form.runSelfCheck()}>
              运行自检
            </Button>
          ) : null}
        </SettingsRow>
        <SettingsRow title="整集重算" help="换了更好的模型、或觉得之前算得不准时用;会把本集每条素材重新排队,几十条要跑几分钟到十几分钟,后台进行,不影响继续筛片。" className="settings-sheet-row--stack">
          <div className="settings-sheet-actions">
            <Button size="sm" busy={rerunning === "moments"} disabled={rerunning !== null} onClick={() => void rerun("moments")}>
              {SETTINGS_ACTIONS.recomputeMoments}
            </Button>
            <Button size="sm" busy={rerunning === "ocr"} disabled={rerunning !== null} onClick={() => void rerun("ocr")}>
              {SETTINGS_ACTIONS.rerunOcr}
            </Button>
          </div>
        </SettingsRow>
      </div>
    </>
  );
}
