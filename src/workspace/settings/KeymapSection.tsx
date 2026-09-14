import { useCallback, useEffect, useState, type JSX } from "react";

import {
  DEFAULT_KEYMAP_PRESET,
  KEYMAP_ACTIONS,
  KEYMAP_ACTION_BY_ID,
  KEYMAP_CUSTOM_KEY,
  KEYMAP_PRESETS,
  KEYMAP_PRESET_KEY,
  chordFromEvent,
  conflictsFor,
  formatKey,
  withOverride,
  type KeymapAction,
  type KeymapGroup,
  type KeymapTable,
} from "../keymap";
import { notifyKeymap, useKeymap } from "../keymapStore";
import { Button, Kbd, SectionHeader, Select } from "../ui";
import { SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";

const PRESET_LABELS: Record<string, string> = Object.fromEntries(KEYMAP_PRESETS.map((preset) => [preset.id, preset.label]));

/** 表按组分段;组的顺序就是新手看表的顺序:先播放,再打点,再评级。 */
const GROUPS: readonly KeymapGroup[] = ["播放", "打点与片段", "评级", "建议与候选", "编辑", "工作区"];

/**
 * R13 §1 / §2:设置 → 「快捷键」分区(剪映同名)。预设下拉 + 动作表(每行:动作名 · 当前键 · 「修改」录制 · 冲突提示)+ 「恢复默认」。
 * 录制:点「修改」后按钮进入录制态,下一次 keydown 就是新键(只按修饰键不算,Esc 取消,失焦取消);
 * 录制中的 keydown 不往上冒 —— 否则 ⌘E 会先被壳当成「导出」开抽屉。
 * 改任何一行都把预设切到「自定义」并记住之前的底表(`withOverride`)。
 */
export function KeymapSection(): JSX.Element {
  const form = useSettingsFormContext();
  const keymap = useKeymap();
  const [recording, setRecording] = useState<KeymapAction | null>(null);

  const persist = useCallback(
    async (preset: string, custom: string) => {
      notifyKeymap(preset, custom);
      await form.save(KEYMAP_PRESET_KEY, preset);
      await form.save(KEYMAP_CUSTOM_KEY, custom);
    },
    [form],
  );

  const changePreset = (preset: string) => {
    setRecording(null);
    void persist(preset, keymap.custom);
  };

  const restoreDefaults = () => {
    setRecording(null);
    void persist(DEFAULT_KEYMAP_PRESET, "");
  };

  const commit = useCallback(
    (action: KeymapAction, chord: string) => {
      const custom = withOverride(keymap.preset, keymap.custom, action, [chord]);
      setRecording(null);
      void persist("custom", custom);
    },
    [keymap.custom, keymap.preset, persist],
  );

  // 录制:在 document 捕获阶段截下一次 keydown —— 比壳的 window 监听、监视器与 sheet 的
  // document 冒泡监听都早,⌘E 录进表而不是开导出抽屉,Esc 只取消录制而不关 sheet。
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const chord = chordFromEvent(event);
      if (chord === null) return; // 只按了修饰键,等下一下
      if (chord === "escape") setRecording(null);
      else commit(recording, chord);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [recording, commit]);

  return (
    <div className="settings-keymap">
      <SectionHeader
        title="快捷键"
        description="这里管键盘怎么用:选一套你熟悉的软件的键位,或者逐个改。与剪映一致的键,换过去也不用重学。"
      />
      <div className="settings-sheet-group">
        <SettingsRow title="键位预设" help="剪映是默认;改过任何一行就会变成「自定义」。" htmlFor="settings-keymap-preset">
          <div className="settings-keymap-preset">
            <Select id="settings-keymap-preset" value={keymap.preset} onChange={(event) => changePreset(event.currentTarget.value)}>
              {KEYMAP_PRESETS.map((preset) => (
                <option value={preset.id} key={preset.id}>{preset.label}</option>
              ))}
              <option value="custom">自定义</option>
            </Select>
            <Button size="sm" variant="ghost" onClick={restoreDefaults} disabled={keymap.preset === DEFAULT_KEYMAP_PRESET && keymap.custom === ""}>
              恢复默认
            </Button>
          </div>
        </SettingsRow>
      </div>
      <KeymapTableView table={keymap.table} recording={recording} onRecord={setRecording} presetLabel={PRESET_LABELS[keymap.preset] ?? "自定义"} />
    </div>
  );
}

interface KeymapTableViewProps {
  table: KeymapTable;
  recording: KeymapAction | null;
  presetLabel: string;
  onRecord(action: KeymapAction | null): void;
}

function KeymapTableView({ table, recording, presetLabel, onRecord }: KeymapTableViewProps): JSX.Element {
  return (
    <table className="settings-keymap-table" aria-label="快捷键表">
      <thead>
        <tr>
          <th scope="col">动作</th>
          <th scope="col">当前键</th>
          <th scope="col"><span className="settings-keymap-visually-hidden">修改</span></th>
        </tr>
      </thead>
      {GROUPS.map((group) => (
        <tbody key={group}>
          <tr className="settings-keymap-group-row">
            <th scope="rowgroup" colSpan={3}>{group}</th>
          </tr>
          {KEYMAP_ACTIONS.filter((meta) => meta.group === group).map((meta) => {
            const chords = table[meta.id] ?? [];
            const conflicts = conflictsFor(table, meta.id);
            const isRecording = recording === meta.id;
            const pending = meta.pending !== undefined;
            return (
              <tr key={meta.id} className={[pending ? "is-pending" : "", conflicts.length > 0 ? "is-conflict" : "", isRecording ? "is-recording" : ""].filter(Boolean).join(" ") || undefined} data-keymap-action={meta.id}>
                <th scope="row">
                  <span>{meta.label}</span>
                  {pending ? <small>{meta.pending}</small> : null}
                </th>
                <td>
                  <span className="settings-keymap-keys">
                    {chords.length === 0 ? <small>未绑定</small> : chords.map((chord) => <Kbd key={chord}>{formatKey(chord)}</Kbd>)}
                  </span>
                  {conflicts.length > 0 ? (
                    <small className="settings-keymap-conflict" role="alert">
                      与「{conflicts.map((other) => KEYMAP_ACTION_BY_ID.get(other)?.label ?? other).join("」「")}」撞键,两边只有一个会响
                    </small>
                  ) : null}
                </td>
                <td>
                  <Button
                    size="sm"
                    variant={isRecording ? "primary" : "ghost"}
                    aria-label={isRecording ? `正在录制「${meta.label}」的新键,按 Esc 取消` : `修改「${meta.label}」`}
                    aria-pressed={isRecording}
                    disabled={pending}
                    title={pending ? meta.pending : `当前预设:${presetLabel}`}
                    onClick={() => onRecord(isRecording ? null : meta.id)}
                    onBlur={() => isRecording && onRecord(null)}
                  >
                    {isRecording ? "按下新键…" : "修改"}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}
