import { useCallback, useState, type JSX } from "react";

import { HelpOverlay } from "../../HelpOverlay";
import { HELP_FAQS, KEYBOARD_SHORTCUT_GROUPS, WORKFLOW_STEPS } from "../../helpContent";
import { GENERATED_LICENSES } from "../../licenses.generated";
import { Button, SectionHeader } from "../ui";
import { SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";

const KEYBOARD_SHORTCUT_COUNT = KEYBOARD_SHORTCUT_GROUPS.reduce(
  (total, group) => total + group.shortcuts.length,
  0,
);

export function AboutSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { appInfo, updater, updatePending } = form;
  const [helpOpen, setHelpOpen] = useState(false);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const [licensesOpen, setLicensesOpen] = useState(false);

  return (
    <>
      <SectionHeader title="帮助与关于" description="中文工作指南、应用状态与第三方许可集中在一个低频分区。" />
      <div className="settings-sheet-group">
        <SettingsRow
          title="中文工作指南"
          help={`${KEYBOARD_SHORTCUT_COUNT} 项快捷键 · ${String(WORKFLOW_STEPS.length).padStart(2, "0")} 步工作流 · ${String(HELP_FAQS.length).padStart(2, "0")} 类常见问题`}
        >
          <Button onClick={() => window.dispatchEvent(new CustomEvent("tripcut:open-wizard"))}>打开安装向导</Button>
          <Button onClick={() => setHelpOpen(true)}>打开中文帮助</Button>
        </SettingsRow>
        <SettingsRow
          title="应用更新"
          help={`当前版本 ${appInfo?.version ?? "—"} · 更新包经 minisign 签名校验后才会安装`}
          className="settings-sheet-row--stack"
        >
          <div className="settings-sheet-actions">
            <Button
              data-updater-action="check"
              disabled={updater.phase === "checking" || updater.phase === "downloading"}
              onClick={() => void form.runUpdateCheck()}
            >
              {updater.phase === "checking" ? "正在检查更新…" : "检查更新"}
            </Button>
            {(updater.phase === "available" || updater.phase === "downloading" || updater.phase === "error") && updatePending ? (
              <Button
                variant="primary"
                data-updater-action="install"
                disabled={updater.phase === "downloading"}
                onClick={() => void form.runUpdateInstall()}
              >
                {updater.phase === "downloading" ? "正在下载并安装…" : "下载并安装"}
              </Button>
            ) : null}
            {updater.phase === "ready" ? (
              <Button variant="primary" data-updater-action="restart" onClick={() => void form.runRestart()}>
                立即重启
              </Button>
            ) : null}
          </div>
          <p className="settings-sheet-updater" data-testid="updater-status" data-updater-status={updater.phase}>
            {updater.message}
          </p>
        </SettingsRow>
      </div>

      <SectionHeader title="应用信息" description="本地优先的旅途素材筛选与交付工作台。" className="settings-sheet-section-gap" />
      <dl className="settings-sheet-facts">
        <div><dt>应用版本</dt><dd>{appInfo?.version ?? "—"}</dd></div>
        <div><dt>Schema</dt><dd>V{appInfo?.db_schema_version ?? "—"}</dd></div>
        <div><dt>当前 worker</dt><dd>{appInfo?.worker_count ?? "—"}</dd></div>
        <div>
          <dt>项目模式</dt>
          <dd>{appInfo ? (appInfo.read_only ? "只读（另一实例持有写锁）" : "独占写入") : "—"}</dd>
        </div>
      </dl>
      <div className="settings-sheet-licenses">
        <div className="settings-sheet-ledger-head">
          <div>
            <strong>开源许可清单</strong>
            <small>由 Cargo.toml 与 package.json 的直接依赖生成 · {GENERATED_LICENSES.length} 项</small>
          </div>
          <Button variant="ghost" size="sm" aria-expanded={licensesOpen} onClick={() => setLicensesOpen((open) => !open)}>
            {licensesOpen ? "收起清单" : "展开清单"}
          </Button>
        </div>
        {licensesOpen ? (
          <div className="settings-sheet-ledger-table settings-sheet-ledger-table--licenses" role="table" aria-label="开源直接依赖许可">
            {GENERATED_LICENSES.map((entry) => (
              <div role="row" key={`${entry.ecosystem}-${entry.name}`}>
                <span role="cell">
                  <strong>{entry.name}</strong>
                  <small>{entry.ecosystem} · {entry.scope}</small>
                </span>
                <code role="cell">{entry.version.replace(/^=/, "")}</code>
                <span role="cell">{entry.license}</span>
              </div>
            ))}
          </div>
        ) : null}
        <p>这里只列直接依赖；最终发布包仍应保留各依赖的完整许可文本与第三方通知。</p>
      </div>
      <HelpOverlay open={helpOpen} onClose={closeHelp} />
    </>
  );
}
