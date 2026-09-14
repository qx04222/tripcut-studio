import { useState, type CSSProperties, type JSX } from "react";

import { UPDATER_ASK_BEFORE_DOWNLOAD_KEY, UPDATER_AUTO_UPDATE_KEY, UPDATER_LAST_CHECK_KEY, type SettingsMap } from "../../api";
import { Button, Toggle } from "../ui";
import { UPDATE_TOAST } from "../update/UpdateHost";
import { askBeforeDownload, autoUpdateEnabled, downloadStatusLabel, lastCheckLabel, notesToParagraphs } from "../update/updateModel";
import {
  openDownloadPage,
  runUpdateCheck,
  runUpdateDownload,
  runUpdateRestart,
  useUpdateState,
  type UpdateState,
} from "../update/updateStore";
import { SettingsRow } from "./SettingsControls";

/** R17:设置 › 关于 更新区块的固定文案(AX 名冻结:自动更新 / 有新版本时先问我再下载 / 检查更新 / 查看更新说明)。 */
export const ABOUT_UPDATE = {
  autoUpdate: "自动更新",
  askFirst: "有新版本时先问我再下载",
  check: "检查更新",
  checking: "正在检查更新…",
  idle: "尚未检查更新。",
  upToDate: "已是最新版本。",
  retry: "再试一次",
  showNotes: "查看更新说明",
  hideNotes: "收起更新说明",
} as const;

export interface AboutUpdateProps {
  version: string | null | undefined;
  settings: SettingsMap;
  save(key: string, value: string): Promise<boolean>;
}

/**
 * R17 车道 B:设置 › 关于 的「应用更新」——一个开关(自动更新,默认开)+ 一个次要勾选
 * (有新版本先问我,默认关)+「检查更新」按钮,结果内联在按钮下面,「现在更新」走的是
 * 与启动自动流程同一份 store。
 */
export function AboutUpdate({ version, settings, save }: AboutUpdateProps): JSX.Element {
  const state = useUpdateState();
  const [notesOpen, setNotesOpen] = useState(false);
  const autoOn = autoUpdateEnabled(settings);
  const busy = state.phase === "checking" || state.phase === "downloading";
  const paragraphs = state.phase === "available" || state.phase === "ready" ? notesToParagraphs(state.notes) : [];
  // store 里的时间戳是这次会话查过之后的;没查过就用设置表里存的那份。
  const lastCheck = state.lastCheck ?? settings[UPDATER_LAST_CHECK_KEY] ?? null;

  return (
    <>
      <SettingsRow
        title={ABOUT_UPDATE.autoUpdate}
        help="有新版本会在后台自己下载好,下完再提醒你重启;不打断正在做的事。关掉后只有点「检查更新」才会去查。"
        align="end"
        className="settings-sheet-row--stack"
      >
        <Toggle label={ABOUT_UPDATE.autoUpdate} checked={autoOn} onChange={(next) => void save(UPDATER_AUTO_UPDATE_KEY, String(next))} />
        <label className="update-r17-ask">
          <input
            type="checkbox"
            disabled={!autoOn}
            checked={askBeforeDownload(settings)}
            onChange={(event) => void save(UPDATER_ASK_BEFORE_DOWNLOAD_KEY, String(event.currentTarget.checked))}
          />
          {ABOUT_UPDATE.askFirst}
        </label>
      </SettingsRow>
      <SettingsRow
        title="应用更新"
        help={`当前版本 ${version ?? "—"} · ${lastCheck ? `上次检查 ${lastCheckLabel(lastCheck, Date.now())}` : "还没检查过更新"} · 更新包已校验签名后才会安装`}
        className="settings-sheet-row--stack"
      >
        <div className="settings-sheet-actions">
          <Button data-updater-action="check" disabled={busy} onClick={() => void runUpdateCheck("manual")}>
            {state.phase === "checking" ? ABOUT_UPDATE.checking : ABOUT_UPDATE.check}
          </Button>
          {paragraphs.length > 0 ? (
            <Button variant="ghost" aria-expanded={notesOpen} onClick={() => setNotesOpen((open) => !open)}>
              {notesOpen ? ABOUT_UPDATE.hideNotes : ABOUT_UPDATE.showNotes}
            </Button>
          ) : null}
        </div>
        <p className="settings-sheet-updater update-r17-result" data-testid="updater-status" data-updater-status={state.phase} data-update-phase={state.phase}>
          <UpdateResult state={state} />
        </p>
        {notesOpen && paragraphs.length > 0 ? (
          <div className="update-r17-notes" aria-label="更新说明">
            {paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        ) : null}
      </SettingsRow>
    </>
  );
}

function UpdateResult({ state }: { state: UpdateState }): JSX.Element {
  switch (state.phase) {
    case "checking":
      return <>{ABOUT_UPDATE.checking}</>;
    case "up-to-date":
      return <>{ABOUT_UPDATE.upToDate}</>;
    case "available":
      return (
        <>
          <span>{UPDATE_TOAST.available(state.version ?? "")}</span>
          <Button variant="primary" size="sm" data-updater-action="install" onClick={() => void runUpdateDownload()}>
            {UPDATE_TOAST.updateNow}
          </Button>
        </>
      );
    case "downloading": {
      const percent = state.total !== null && state.total > 0 ? Math.min(100, Math.floor((state.downloaded / state.total) * 100)) : 0;
      return (
        <>
          <span className="update-r17-progress" aria-hidden="true" style={{ "--progress": `${percent}%` } as CSSProperties} />
          <span>{downloadStatusLabel(state.downloaded, state.total)}</span>
        </>
      );
    }
    case "ready":
      return (
        <>
          <span>{`${UPDATE_TOAST.ready(state.version ?? "")},重启后就是新版本。`}</span>
          <Button variant="primary" size="sm" data-updater-action="restart" onClick={() => void runUpdateRestart()}>
            {UPDATE_TOAST.restart}
          </Button>
          {state.failedAt === "restart" && state.failure ? <small>{`重启没成功:${state.failure.reason}(${state.failure.detail})`}</small> : null}
        </>
      );
    case "error": {
      const reason = state.failure?.reason ?? "遇到了意外错误";
      const head = state.failedAt === "download" ? UPDATE_TOAST.failed(reason) : `检查更新没成功:${reason}`;
      return (
        <>
          <span>{head}</span>
          {state.failedAt === "download" ? (
            <Button variant="primary" size="sm" data-updater-action="install" onClick={() => void runUpdateDownload()}>
              {ABOUT_UPDATE.retry}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => void openDownloadPage()}>
            {UPDATE_TOAST.openDownloadPage}
          </Button>
          {state.failure ? <small>{state.failure.detail}</small> : null}
        </>
      );
    }
    default:
      return <>{ABOUT_UPDATE.idle}</>;
  }
}
