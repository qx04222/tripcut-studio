import type { JSX } from "react";

import { pickQuickExportFolder } from "../../api";
import { SETTINGS_ACTIONS } from "../copy";
import { failureText } from "../errorText";
import { resetLayout } from "../layoutReset";
import { notifyPlayerPref, type PlayerPrefKey } from "../playerPrefs";
import { Button, SectionHeader, Toggle, showToast } from "../ui";
import { readUiBool, readUiSetting } from "../uiSettings";
import { Segmented, SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";

/** 与 `deliver/useQuickExport.ts` 的 LAST_DIR_KEY 同一个键(那份文件归车道 E,这里不 import 它)。 */
const EXPORT_DIR_KEY = "ui.export.last_dir";

const THEMES = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
  // R13 §5:近剪映的深灰工作台 + 青绿强调(自己配色,不默认)。
  ["jianying-dark", "剪映风格深色"],
] as const;

const SCALES = [
  ["0.9", "90%"],
  ["1.0", "100%"],
  ["1.15", "115%"],
  ["1.3", "130%"],
] as const;

export function AppearanceSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings } = form;
  // R11 简化专项 #2:「导出文件夹」进常用分区 —— 与快速导出的「更改文件夹」写同一个键。
  const exportDir = readUiSetting(settings, EXPORT_DIR_KEY);
  const changeExportDir = async () => {
    const picked = await pickQuickExportFolder().catch(() => null);
    if (picked) await form.save(EXPORT_DIR_KEY, picked);
  };
  // R11 §3:播放器偏好写表之余同步进程内快照,监视器不用重读设置。
  const savePlayerPref = (key: PlayerPrefKey, next: boolean) => {
    notifyPlayerPref(key, next);
    void form.save(key, String(next));
  };
  return (
    <>
      <SectionHeader title="播放与导出" description="主题、字号、播放习惯与导出去向 —— 平时会碰的都在这里。" />
      <div className="settings-sheet-group">
        <SettingsRow title="主题" help="跟随 macOS 外观，或固定明暗主题;「剪映风格深色」是近剪映的深灰工作台。">
          <Segmented options={THEMES} value={settings["appearance.theme"] ?? "system"} onChange={(value) => void form.save("appearance.theme", value)} />
        </SettingsRow>
        <SettingsRow title="界面缩放" help="同步调整筛片、导入、交付与设置页的阅读尺度。">
          <Segmented options={SCALES} value={settings["appearance.ui_scale"] ?? "1.0"} onChange={(value) => void form.save("appearance.ui_scale", value)} />
        </SettingsRow>
        <SettingsRow title="选中素材从最精彩处开播" help="按画面分析找到最精彩的时刻,选中素材时预览帧就停在那里;按空格才开始播。" align="end">
          <Toggle
            label="选中素材从最精彩处开播"
            checked={readUiBool(settings, "ui.player.start_at_best")}
            onChange={(next) => savePlayerPref("ui.player.start_at_best", next)}
          />
        </SettingsRow>
        <SettingsRow title="播完自动播下一条" help="按媒体池当前顺序接着播;到最后一条停下。监视器上的「连播」开关是同一个设置。" align="end">
          <Toggle
            label="播完自动播下一条"
            checked={readUiBool(settings, "ui.player.auto_advance")}
            onChange={(next) => savePlayerPref("ui.player.auto_advance", next)}
          />
        </SettingsRow>
        <SettingsRow
          title="导出文件夹"
          help={exportDir ? `快速导出会直接存到这里:${exportDir}` : "还没选过;第一次导出时会让你选一个文件夹,之后记住。"}
          align="end"
        >
          <div className="settings-sheet-actions">
            <Button onClick={() => void changeExportDir()}>{exportDir ? "更改…" : "选择…"}</Button>
            {/* R16 P2-8:忘掉这个文件夹,回到「每次导出先问一次」。 */}
            {exportDir ? (
              <Button variant="ghost" aria-label="清除导出文件夹" onClick={() => void form.save(EXPORT_DIR_KEY, "")}>
                {SETTINGS_ACTIONS.clearExportDir}
              </Button>
            ) : null}
          </div>
        </SettingsRow>
        {/* R16 P2-12:栏拖没了 / 折叠找不回来时一键回默认(ui.pane.* 五个键)。 */}
        <SettingsRow title="界面布局" help="把媒体池、检查器的宽度和监视器的高度恢复成默认,折叠的栏也展开。" align="end">
          <Button
            onClick={() => {
              void resetLayout()
                .then(() => showToast("已恢复默认布局", { tone: "success" }))
                .catch((error) => showToast(failureText(SETTINGS_ACTIONS.resetLayout, error), { tone: "danger" }));
            }}
          >
            {SETTINGS_ACTIONS.resetLayout}
          </Button>
        </SettingsRow>
      </div>
    </>
  );
}
