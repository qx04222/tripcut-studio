import type { JSX } from "react";

import { Button, SectionHeader } from "../ui";
import { Segmented, SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";

const THEMES = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
] as const;

const SCALES = [
  ["0.9", "90%"],
  ["1.0", "100%"],
  ["1.15", "115%"],
  ["1.3", "130%"],
] as const;

export function AppearanceSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings, workspaceV2 } = form;
  return (
    <>
      <SectionHeader title="外观" description="让全屏工作台保持舒展，同时按观看距离调整整套字号。" />
      <div className="settings-sheet-group">
        <SettingsRow title="主题" help="跟随 macOS 外观，或为工作台固定明暗主题。">
          <Segmented options={THEMES} value={settings["appearance.theme"] ?? "system"} onChange={(value) => void form.save("appearance.theme", value)} />
        </SettingsRow>
        <SettingsRow title="界面缩放" help="同步调整筛片、导入、交付与设置页的阅读尺度。">
          <Segmented options={SCALES} value={settings["appearance.ui_scale"] ?? "1.0"} onChange={(value) => void form.save("appearance.ui_scale", value)} />
        </SettingsRow>
        <SettingsRow
          title="界面"
          help={
            workspaceV2
              ? "旅剪工作台是当前默认界面;需要时可以随时切回旧版四步页面。"
              : "当前是旧版四步页面;随时可以切回旅剪工作台。"
          }
          align="end"
        >
          {/* 这一行是个真开关,不是单向门(R8 终审 M2):文案与写入值都由当前
              ui.workspace_v2 决定——旧壳里点它才有路回到新壳。 */}
          <Button onClick={() => void form.toggleWorkspaceFlag()}>
            {workspaceV2 ? "切回旧界面" : "切换到新界面"}
          </Button>
        </SettingsRow>
      </div>
    </>
  );
}
