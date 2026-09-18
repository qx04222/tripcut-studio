import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import type { SettingsSectionId } from "../settingsSections";
import { AboutSection } from "./settings/AboutSection";
import { AnalysisSection } from "./settings/AnalysisSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { CacheSection } from "./settings/CacheSection";
import { GenerationSection } from "./settings/GenerationSection";
import { KeymapSection } from "./settings/KeymapSection";
import { PerformanceSection } from "./settings/PerformanceSection";
import { PrivacySection } from "./settings/PrivacySection";
import { SettingsFormContext } from "./settings/SettingsFormContext";
import { SettingsRail, railPanelId, railTabId } from "./settings/SettingsRail";
import { SETTINGS_GROUPS, groupForSection, visibleSettingsSections, type SettingsGroupId } from "./settings/settingsGroups";
import { useShowAllFeatures } from "./showAllFeatures";
import { TimelineSection } from "./settings/TimelineSection";
import { ToolsSection } from "./settings/ToolsSection";
import { noticeTone } from "./settings/settingsModel";
import { useSettingsForm } from "./settings/useSettingsForm";
import { Button, Icon, Sheet } from "./ui";
import { dispatchWorkspace, useWorkspace, type WorkspaceState } from "./WorkspaceStore";

const SECTIONS: Record<SettingsSectionId, () => JSX.Element> = {
  appearance: AppearanceSection,
  keymap: KeymapSection,
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
 * 设置 sheet(规格 §4.3 × R13 §2 剪映式六分区):居中 880 × 80vh,左侧六块(项目与缓存 / 快捷键 / 播放与导出 /
 * 性能 / 工具与模型 / 关于),右侧顶部一句「这里管什么」,下面把该块的段全部摆出来 —— 没有「高级…」折叠;
 * 页脚 = 状态行 + 「关闭」。九个旧分区一段不少,`openSettings(section)` 直落时滚到那一段。
 */
export function SettingsSheet(): JSX.Element | null {
  const open = useWorkspace((state: WorkspaceState) => state.openDrawer === "settings");
  return open ? <SettingsSheetBody /> : null;
}

function SettingsSheetBody(): JSX.Element {
  const form = useSettingsForm();
  // 初始分区来自 `openSettings(section)`(检查器「去设置」等入口);顶栏按钮不带分区,落到常用。
  // 只在挂载时读一次——sheet 开着时再派发 open-drawer 不会把用户切走的分区抢回来。
  const requested = useWorkspace((state: WorkspaceState) => state.settingsSection);
  const [active, setActive] = useState<SettingsGroupId>(requested ? groupForSection(requested) : "project");
  const [focusSection, setFocusSection] = useState<SettingsSectionId | null>(requested ?? null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const close = () => dispatchWorkspace({ type: "close-drawer" });
  const group = SETTINGS_GROUPS.find((candidate) => candidate.id === active) ?? SETTINGS_GROUPS[0]!;
  // R19 P-05(flow 车道):「显示全部功能」关时工具块里不画「云端补镜」段;程序直落到它时照样画。
  const sections = visibleSettingsSections(group, useShowAllFeatures(), focusSection);
  const tone = noticeTone(form.notice);

  const changeGroup = useCallback((id: SettingsGroupId) => {
    setActive(id);
    setFocusSection(null);
  }, []);

  // 快捷入口 / openSettings 直落:切组、把那一段滚进视野。
  const jump = useCallback((section: SettingsSectionId) => {
    setActive(groupForSection(section));
    setFocusSection(section);
  }, []);

  useEffect(() => {
    if (!focusSection || !form.settingsLoaded) return;
    panelRef.current?.querySelector<HTMLElement>(`[data-section="${focusSection}"]`)?.scrollIntoView?.({ block: "start" });
  }, [focusSection, form.settingsLoaded, active]);

  const renderSection = (id: SettingsSectionId) => {
    const Section = SECTIONS[id];
    return (
      <section className="settings-sheet-block" data-section={id} key={id}>
        <Section />
      </section>
    );
  };

  return (
    <Sheet open title="设置" width="880px" height="80vh" onClose={close}>
      <SettingsFormContext.Provider value={form}>
        <div className="settings-sheet">
          <SettingsRail value={active} onChange={changeGroup} onJump={jump} />
          <div
            className="settings-sheet-panel"
            role="tabpanel"
            id={railPanelId(active)}
            aria-labelledby={railTabId(active)}
            aria-busy={!form.settingsLoaded}
            inert={form.settingsLoaded ? undefined : true}
            key={active}
            ref={panelRef}
          >
            <p className="settings-sheet-intro" data-settings-intro={group.id}>{group.intro}</p>
            {sections.map(renderSection)}
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
