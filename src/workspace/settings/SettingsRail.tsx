import type { JSX, KeyboardEvent } from "react";

import type { SettingsSectionId } from "../../settingsSections";
import { Button, Icon } from "../ui";
import { SETTINGS_GROUPS, SETTINGS_QUICK_LINKS, type SettingsGroupId } from "./settingsGroups";

export interface SettingsRailProps {
  value: SettingsGroupId;
  onChange(id: SettingsGroupId): void;
  /** 底部快捷入口:直落某个旧分区(高级项会自动展开)。 */
  onJump(section: SettingsSectionId): void;
}

export function railTabId(id: SettingsGroupId): string {
  return `settings-sheet-tab-${id}`;
}

export function railPanelId(id: SettingsGroupId): string {
  return `settings-sheet-panel-${id}`;
}

/**
 * 左侧竖向分区轨:`role="tablist"` 名「设置分区」(冻结),R13 起六个 `tab`
 * (项目与缓存 / 快捷键 / 播放与导出 / 性能 / 工具与模型 / 关于;AX 名只有 label,说明 `aria-hidden`);
 * ↑ ↓ Home End roving + 自动激活。底部常驻两个快捷入口「云端补镜」「隐私与诊断」—— 它们是
 * design-system §6 冻结的冒烟锚点,不是 tab,以按钮形式留在左轨,点一下直落对应分区的那一段。
 */
export function SettingsRail({ value, onChange, onJump }: SettingsRailProps): JSX.Element {
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    let to: number;
    if (event.key === "ArrowDown") to = (from + 1) % SETTINGS_GROUPS.length;
    else if (event.key === "ArrowUp") to = (from - 1 + SETTINGS_GROUPS.length) % SETTINGS_GROUPS.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = SETTINGS_GROUPS.length - 1;
    else return;
    event.preventDefault();
    const target = SETTINGS_GROUPS[to];
    if (!target) return;
    onChange(target.id);
    document.getElementById(railTabId(target.id))?.focus();
  };

  return (
    <div className="settings-sheet-rail">
      <div role="tablist" aria-label="设置分区" aria-orientation="vertical" className="settings-sheet-rail-tabs">
        {SETTINGS_GROUPS.map((tab, index) => {
          const selected = tab.id === value;
          const classes = ["settings-sheet-tab", selected ? "is-selected" : ""].filter(Boolean).join(" ");
          return (
            <button
              key={tab.id}
              id={railTabId(tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={railPanelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              className={classes}
              data-settings-nav={tab.id}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => move(event, index)}
            >
              <Icon name={tab.icon} size={16} />
              <span className="settings-sheet-tab-text">
                <span className="settings-sheet-tab-label">{tab.label}</span>
                <span className="settings-sheet-tab-desc" aria-hidden="true">{tab.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="settings-sheet-rail-links">
        <span className="settings-sheet-rail-links-title" aria-hidden="true">直达</span>
        {SETTINGS_QUICK_LINKS.map((link) => (
          <Button key={link.section} variant="ghost" size="sm" className="settings-sheet-rail-link" onClick={() => onJump(link.section)}>
            {link.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
