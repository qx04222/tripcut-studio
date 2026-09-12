import type { JSX, KeyboardEvent } from "react";

import type { SettingsSectionId } from "../../settingsSections";
import { Icon } from "../ui";
import { SETTINGS_TABS } from "./settingsModel";

export interface SettingsRailProps {
  value: SettingsSectionId;
  onChange(id: SettingsSectionId): void;
}

export function railTabId(id: SettingsSectionId): string {
  return `settings-sheet-tab-${id}`;
}

export function railPanelId(id: SettingsSectionId): string {
  return `settings-sheet-panel-${id}`;
}

/**
 * 左侧竖向分区轨:`role="tablist"` 名「设置分区」,九个 `tab`(AX 名只有 label,说明
 * `aria-hidden`);↑ ↓ Home End roving + 自动激活(套件 `Tabs` 是横向的 ← →,竖轨另写)。
 * 「缓存与重建」danger 色靠底。
 */
export function SettingsRail({ value, onChange }: SettingsRailProps): JSX.Element {
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    let to: number;
    if (event.key === "ArrowDown") to = (from + 1) % SETTINGS_TABS.length;
    else if (event.key === "ArrowUp") to = (from - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = SETTINGS_TABS.length - 1;
    else return;
    event.preventDefault();
    const target = SETTINGS_TABS[to];
    if (!target) return;
    onChange(target.id);
    document.getElementById(railTabId(target.id))?.focus();
  };

  return (
    <div role="tablist" aria-label="设置分区" aria-orientation="vertical" className="settings-sheet-rail">
      {SETTINGS_TABS.map((tab, index) => {
        const selected = tab.id === value;
        const classes = ["settings-sheet-tab", selected ? "is-selected" : "", tab.danger ? "is-danger" : ""]
          .filter(Boolean)
          .join(" ");
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
  );
}
