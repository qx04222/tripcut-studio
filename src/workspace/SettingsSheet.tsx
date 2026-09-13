import { useCallback, useEffect, useRef, useState, type JSX, type SyntheticEvent } from "react";

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
import { SETTINGS_GROUPS, groupForSection, isAdvancedSection, type SettingsGroupId } from "./settings/settingsGroups";
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
 * 设置 sheet(规格 §4.3 × R11 简化专项 #2):居中 880 × 80vh,左侧三个分区(常用 / 工具与模型 / 关于),
 * 右侧把该分区的常用段直接摆出来,其余收进一个「高级…」折叠;页脚 = 状态行 + 「关闭」。
 * 九个旧分区(`SettingsSectionId`)一段不少,`openSettings(section)` 直落时高级项自动展开。
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
  const [active, setActive] = useState<SettingsGroupId>(requested ? groupForSection(requested) : "general");
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(requested ? isAdvancedSection(requested) : false);
  const [focusSection, setFocusSection] = useState<SettingsSectionId | null>(requested ?? null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const close = () => dispatchWorkspace({ type: "close-drawer" });
  const group = SETTINGS_GROUPS.find((candidate) => candidate.id === active) ?? SETTINGS_GROUPS[0]!;
  const tone = noticeTone(form.notice);

  const changeGroup = useCallback((id: SettingsGroupId) => {
    setActive(id);
    setAdvancedOpen(false);
    setFocusSection(null);
  }, []);

  // 快捷入口 / openSettings 直落:切组、高级项展开、把那一段滚进视野。
  const jump = useCallback((section: SettingsSectionId) => {
    setActive(groupForSection(section));
    setAdvancedOpen(isAdvancedSection(section));
    setFocusSection(section);
  }, []);

  useEffect(() => {
    if (!focusSection || !form.settingsLoaded) return;
    panelRef.current?.querySelector<HTMLElement>(`[data-section="${focusSection}"]`)?.scrollIntoView?.({ block: "start" });
  }, [focusSection, form.settingsLoaded, active, advancedOpen]);

  const onToggleAdvanced = useCallback((event: SyntheticEvent<HTMLDetailsElement>) => {
    setAdvancedOpen(event.currentTarget.open);
  }, []);

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
            {group.primary.map(renderSection)}
            {group.advanced.length > 0 ? (
              <details className="settings-sheet-advanced" open={advancedOpen} onToggle={onToggleAdvanced}>
                <summary className="settings-sheet-advanced-summary">
                  <Icon name="chevron-right" size={12} className={advancedOpen ? "settings-sheet-advanced-chevron is-open" : "settings-sheet-advanced-chevron"} />
                  <span>高级…</span>
                  <small aria-hidden="true">{group.advanced.map((id) => SECTION_LABELS[id]).join(" · ")}</small>
                </summary>
                <div className="settings-sheet-advanced-body">{group.advanced.map(renderSection)}</div>
              </details>
            ) : null}
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

/** 「高级…」摘要行里的小字:告诉人折叠里有什么,免得点开才知道。 */
const SECTION_LABELS: Record<SettingsSectionId, string> = {
  appearance: "外观",
  performance: "性能",
  timeline: "设备时钟",
  tools: "工具链",
  analysis: "分析与 AI",
  generation: "云端补镜",
  privacy: "隐私与诊断",
  about: "帮助与关于",
  cache: "缓存与重建",
};
