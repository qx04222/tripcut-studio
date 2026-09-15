import { useCallback, useState, type JSX } from "react";

import { HelpOverlay } from "../../HelpOverlay";
import { HELP_FAQS, KEYBOARD_SHORTCUT_GROUPS, WORKFLOW_STEPS } from "../../helpContent";
import { GENERATED_LICENSES } from "../../licenses.generated";
import { SETTINGS_ACTIONS } from "../copy";
import { exportDiagnosticsBundle } from "../../api";
import { copyDiagnostics } from "../diagnostics";
import { failureText } from "../errorText";
import { resetOnboarding } from "../onboardingReset";
import { Button, SectionHeader, showToast } from "../ui";
import { AboutUpdate } from "./AboutUpdate";
import { SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";

const KEYBOARD_SHORTCUT_COUNT = KEYBOARD_SHORTCUT_GROUPS.reduce(
  (total, group) => total + group.shortcuts.length,
  0,
);

/** R18 M-04:AX 名冻结。 */
export const EXPORT_DIAGNOSTICS_BUNDLE = "导出诊断包…";

export function AboutSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { appInfo } = form;
  const [bundling, setBundling] = useState(false);
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
          <Button onClick={() => setHelpOpen(true)}>打开中文帮助</Button>
        </SettingsRow>
        {/* R17 车道 B:自动更新开关 + 检查更新(内联结果,与启动自动流程同一份 store)。 */}
        <AboutUpdate version={appInfo?.version} settings={form.settings} save={form.save} />
      </div>

      <div className="settings-sheet-group">
        {/* R13 §3 → R16 P2-11:功能气泡、首页三步卡、四步提示、首启向导一起重置(名副其实)。 */}
        <SettingsRow title="新手引导" help="工作区里那些「知道了」的小气泡、每一步的提示条和首页的上手卡各只出现一次;重置后都会再出现一遍。">
          <Button
            onClick={() => {
              void resetOnboarding()
                .then(() => showToast("新手引导已重置:气泡、四步提示和首启向导下次都会再出现", { tone: "success" }))
                .catch((error) => showToast(failureText(SETTINGS_ACTIONS.resetOnboarding, error), { tone: "danger" }));
            }}
          >
            {SETTINGS_ACTIONS.resetOnboarding}
          </Button>
        </SettingsRow>
        {/* R11 简化专项 #2:「打开日志目录」从隐私与诊断搬到关于 —— 出了问题要日志时不用翻高级。 */}
        <SettingsRow title="诊断日志" help="出问题时先「复制诊断信息」贴给我们(只有版本、工具链、内存档和最近 3 条错误,不含任何路径);要日志再打开目录,日志只保留 7 天;发给我们最省事的是「导出诊断包…」——一个 zip,里面没有原片、转写和 GPS。" className="settings-sheet-row--stack">
          <div className="settings-sheet-actions">
            {/* R16 P2-13:报 bug 时业主要的第一件事。 */}
            <Button
              disabled={form.busy}
              onClick={() => {
                void copyDiagnostics()
                  .then(() => showToast("诊断信息已复制,直接粘贴发给我们", { tone: "success" }))
                  .catch((error) => showToast(failureText(SETTINGS_ACTIONS.copyDiagnostics, error), { tone: "danger" }));
              }}
            >
              {SETTINGS_ACTIONS.copyDiagnostics}
            </Button>
            {/* R18 M-04:求助时给一个 zip 比描述症状有用得多;包里没有原片、转写、GPS,路径已脱敏。 */}
            <Button
              variant="ghost"
              disabled={form.busy || bundling}
              busy={bundling}
              onClick={() => {
                setBundling(true);
                void exportDiagnosticsBundle()
                  .then((bundle) => {
                    if (bundle) showToast(`诊断包已存好:${bundle.log_files} 份日志、${bundle.failed_jobs} 条失败任务;里面没有原片、转写和 GPS`, { tone: "success" });
                  })
                  .catch((error) => showToast(failureText(EXPORT_DIAGNOSTICS_BUNDLE, error), { tone: "danger" }))
                  .finally(() => setBundling(false));
              }}
            >
              {EXPORT_DIAGNOSTICS_BUNDLE}
            </Button>
            <Button variant="ghost" disabled={form.busy} onClick={() => void form.openLogs()}>
              打开日志目录
            </Button>
          </div>
        </SettingsRow>
      </div>
      <SectionHeader title="应用信息" description="本地优先的旅途素材筛选与交付工作台。" className="settings-sheet-section-gap" />
      <dl className="settings-sheet-facts">
        <div><dt>应用版本</dt><dd>{appInfo?.version ?? "—"}</dd></div>
        {/* Y-11:反馈问题时截图用的事实,也用白话 —— 数据版本 / 后台线程 / 能不能改。 */}
        <div><dt>数据版本</dt><dd>V{appInfo?.db_schema_version ?? "—"}</dd></div>
        <div><dt>后台线程</dt><dd>{appInfo?.worker_count ?? "—"}</dd></div>
        <div>
          <dt>这个窗口</dt>
          <dd>{appInfo ? (appInfo.read_only ? "只能看（另一个窗口正在编辑这个素材库）" : "可以编辑") : "—"}</dd>
        </div>
      </dl>
      <div className="settings-sheet-licenses">
        <div className="settings-sheet-ledger-head">
          <div>
            <strong>开源许可清单</strong>
            <small>应用直接用到的开源组件 · {GENERATED_LICENSES.length} 项</small>
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
