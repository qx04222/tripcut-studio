import { useEffect, useState, type JSX } from "react";

import { getImportProgress } from "../../api";
import { Badge, Button, EmptyState, SectionHeader } from "../ui";
import { useSettingsFormContext } from "./SettingsFormContext";
import { clockSourceLabel, deviceClockEmptyCopy, deviceClockLibraryState, type DeviceClockLibraryState } from "./settingsModel";

/** 空态要分「没数据 / 还没跑 / 跑完了没设备信息」(U-35),问一次索引进度就够。 */
function useLibraryState(enabled: boolean): DeviceClockLibraryState {
  const [state, setState] = useState<DeviceClockLibraryState>("unknown");
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void getImportProgress()
      .then((progress) => {
        if (alive && progress) setState(deviceClockLibraryState(progress));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled]);
  return state;
}

export function TimelineSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { deviceClocks, clockDrafts, busy } = form;
  const empty = deviceClockEmptyCopy(useLibraryState(deviceClocks.length === 0));
  return (
    <>
      <SectionHeader
        title="设备时钟校正"
        description="偏移只参与旅行时间轴排序，不会改写素材原始 captured_at。正数让设备时间向后移动，负数向前移动。"
      />
      {deviceClocks.length === 0 ? (
        <EmptyState icon="settings-timeline" title={empty.title} body={empty.body} size="inline" />
      ) : (
        <div className="settings-sheet-group">
          {deviceClocks.map((clock) => {
            const inputId = `settings-clock-${clock.device_model.replace(/\s+/g, "-")}`;
            return (
              <div className={clock.needs_review ? "settings-sheet-clock needs-review" : "settings-sheet-clock"} key={clock.device_model}>
                <div className="settings-sheet-clock-copy">
                  <strong>{clock.device_model}</strong>
                  <small>
                    {clock.clip_count} 条素材 · {clockSourceLabel(clock.source)}
                    {clock.confidence === null ? "" : ` · 置信度 ${Math.round(clock.confidence * 100)}%`}
                  </small>
                  {clock.timezone_conflicts > 0 ? (
                    <Badge tone="warn" icon="warning">
                      {clock.timezone_conflicts} 条素材的 GPS 推断时区与文件时区标记冲突
                    </Badge>
                  ) : null}
                </div>
                <label className="settings-sheet-clock-input" htmlFor={inputId}>
                  <span>偏移（秒）</span>
                  <input
                    id={inputId}
                    aria-label={`${clock.device_model} 偏移（秒）`}
                    type="number"
                    step="0.001"
                    min={-50_400}
                    max={50_400}
                    value={clockDrafts[clock.device_model] ?? "0"}
                    onChange={(event) => form.setClockDraft(clock.device_model, event.currentTarget.value)}
                  />
                </label>
                <Button size="sm" disabled={busy} onClick={() => void form.saveDeviceClock(clock.device_model)}>
                  应用到此设备
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
