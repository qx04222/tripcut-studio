import { useState, type JSX } from "react";

import type { SettingsSectionId } from "../settingsSections";
import { AboutSection } from "./settings/AboutSection";
import { AnalysisSection } from "./settings/AnalysisSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { CacheSection } from "./settings/CacheSection";
import { GenerationSection } from "./settings/GenerationSection";
import { PerformanceSection } from "./settings/PerformanceSection";
import { PrivacySection } from "./settings/PrivacySection";
import { SettingsFormContext } from "./settings/SettingsFormContext";
import { SettingsRail, railPanelId, railTabId } from "./settings/SettingsRail";
import { TimelineSection } from "./settings/TimelineSection";
import { ToolsSection } from "./settings/ToolsSection";
import { noticeTone } from "./settings/settingsModel";
import { useSettingsForm } from "./settings/useSettingsForm";
import { Button, Icon, Sheet } from "./ui";
import { dispatchWorkspace, useWorkspace, type WorkspaceState } from "./WorkspaceStore";

const SECTIONS: Record<SettingsSectionId, () => JSX.Element> = {
  appearance: AppearanceSection,
  performance: PerformanceSection,
  timeline: TimelineSection,
  tools: ToolsSection,
  analysis: AnalysisSection,
  generation: GenerationSection,
  privacy: PrivacySection,
  about: AboutSection,
  cache: CacheSection,
};

const NOTICE_ICON = { info: "info", ok: "check", warn: "warning" } as const;

/**
 * 设置 sheet(规格 §4.3,B 稿表单语法 × A 稿密度):居中 880 × 80vh,左侧竖向分区轨
 * (九个 tab),右侧一次只渲染当前分区的表单,页脚 = 状态行(`role=status`,即旧页顶部
 * 的 notice)+「关闭」。全部状态来自 `useSettingsForm`,分区文件只从 context 取。
 */
export function SettingsSheet(): JSX.Element | null {
  const open = useWorkspace((state: WorkspaceState) => state.openDrawer === "settings");
  return open ? <SettingsSheetBody /> : null;
}

function SettingsSheetBody(): JSX.Element {
  const form = useSettingsForm();
  const [active, setActive] = useState<SettingsSectionId>("appearance");
  const close = () => dispatchWorkspace({ type: "close-drawer" });
  const Section = SECTIONS[active];
  const tone = noticeTone(form.notice);

  return (
    <Sheet open title="设置" width="880px" height="80vh" onClose={close}>
      <SettingsFormContext.Provider value={form}>
        <div className="settings-sheet">
          <SettingsRail value={active} onChange={setActive} />
          <div
            className="settings-sheet-panel"
            role="tabpanel"
            id={railPanelId(active)}
            aria-labelledby={railTabId(active)}
            aria-busy={!form.settingsLoaded}
            inert={form.settingsLoaded ? undefined : true}
            key={active}
          >
            <Section />
          </div>
          <footer className="settings-sheet-footer">
            <p className={`settings-sheet-notice is-${tone}`} role="status" aria-live="polite">
              <Icon name={NOTICE_ICON[tone]} size={12} />
              <span>{form.notice}</span>
            </p>
            <Button aria-label="关闭设置" onClick={close}>
              关闭
            </Button>
          </footer>
        </div>
      </SettingsFormContext.Provider>
    </Sheet>
  );
}
