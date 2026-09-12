import type { JSX } from "react";

import { Badge, Button, SectionHeader, Select, Toggle } from "../ui";
import { BudgetMeter, Note, SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";
import { MINIMAX_MODEL_RESOLUTIONS, MINIMAX_MONTHLY_BUDGET_MAX, generationLedgerStatusLabel } from "./settingsModel";

export function GenerationSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings, minimaxHasKey, minimaxKeyDraft, minimaxKeyBusy, minimaxKeyNotice, minimaxBudgetClampNote, generationStatus, generationLedger } = form;

  return (
    <>
      <SectionHeader
        title="云端补镜（MiniMax）"
        description="默认关闭。启用后可对故事板检测到的镜头缺口发起 MiniMax 云端生成，按月度预算熔断，绝不自动提交。"
      />
      <div className="settings-sheet-group">
        <SettingsRow title="启用云端补镜" help="关闭时后端在预算检查与调用之前直接拒绝全部生成请求。" align="end">
          <Toggle label="启用云端补镜" checked={settings.minimax_enabled === "true"} onChange={(next) => void form.saveMinimaxEnabled(next)} />
        </SettingsRow>
        <SettingsRow title="MiniMax API Key" help="只写入 macOS 钥匙串，界面上永不回显已保存的值。" htmlFor="settings-minimax-key">
          <div className="settings-sheet-keyrow">
            <Badge tone={minimaxHasKey ? "accent" : "neutral"} icon={minimaxHasKey ? "check" : undefined}>
              {minimaxHasKey ? "已配置" : "未配置"}
            </Badge>
            <input
              id="settings-minimax-key"
              className="settings-sheet-input"
              type="password"
              autoComplete="off"
              placeholder={minimaxHasKey ? "已保存，如需更换请输入新的 Key" : "粘贴 MiniMax API Key"}
              value={minimaxKeyDraft}
              disabled={minimaxKeyBusy}
              onChange={(event) => form.setMinimaxKeyDraft(event.currentTarget.value)}
            />
            <Button size="sm" disabled={minimaxKeyBusy || minimaxKeyDraft.trim().length === 0} onClick={() => void form.saveMinimaxKey()}>
              保存
            </Button>
            <Button size="sm" variant="ghost" disabled={minimaxKeyBusy || !minimaxHasKey} onClick={() => void form.clearMinimaxKey()}>
              清除
            </Button>
          </div>
          {minimaxKeyNotice ? <p className="settings-sheet-inline-notice" role="status">{minimaxKeyNotice}</p> : null}
        </SettingsRow>
        <SettingsRow title="默认模型" help="H3-Max 更便宜，H3 支持首尾帧引导与 2K。" htmlFor="settings-minimax-model">
          <Select id="settings-minimax-model" value={settings.minimax_model} onChange={(event) => void form.saveMinimaxModel(event.currentTarget.value)}>
            <option value="MiniMax-H3-Max">MiniMax-H3-Max</option>
            <option value="MiniMax-H3">MiniMax-H3</option>
          </Select>
        </SettingsRow>
        <SettingsRow title="默认分辨率" help="可选项随所选模型变化，避免选出模型不支持的组合。" htmlFor="settings-minimax-resolution">
          <Select id="settings-minimax-resolution" value={settings.minimax_resolution} onChange={(event) => void form.saveMinimaxResolution(event.currentTarget.value)}>
            {(MINIMAX_MODEL_RESOLUTIONS[settings.minimax_model] ?? ["480P", "768P", "2K"]).map((resolution) => (
              <option key={resolution} value={resolution}>{resolution}</option>
            ))}
          </Select>
        </SettingsRow>
        <SettingsRow
          title="月度预算（USD）"
          help={`0–${MINIMAX_MONTHLY_BUDGET_MAX} 美元；超出会被夹到上限，不会拒绝保存。`}
          htmlFor="settings-minimax-budget"
        >
          <input
            id="settings-minimax-budget"
            className="settings-sheet-input settings-sheet-input--number"
            type="number"
            min="0"
            max={MINIMAX_MONTHLY_BUDGET_MAX}
            step="1"
            value={settings.minimax_monthly_budget_usd}
            onChange={(event) => form.setDraft("minimax_monthly_budget_usd", event.currentTarget.value)}
            onBlur={(event) => void form.saveMinimaxBudget(event.currentTarget.value)}
          />
          {minimaxBudgetClampNote ? <p className="settings-sheet-inline-notice" role="status">{minimaxBudgetClampNote}</p> : null}
        </SettingsRow>
      </div>
      <BudgetMeter
        exhausted={(generationStatus?.budget_remaining_usd ?? 0) <= 0}
        cells={[
          [
            "本月已用",
            `$${(generationLedger?.spent_usd ?? 0).toFixed(2)} / $${(generationLedger?.budget_usd ?? Number(settings.minimax_monthly_budget_usd)).toFixed(2)}`,
          ],
          [
            "状态",
            !generationStatus?.enabled
              ? "已关闭"
              : !generationStatus?.has_key
                ? "未配置 API Key"
                : `剩余 $${generationStatus.budget_remaining_usd.toFixed(2)}`,
          ],
        ]}
      />
      <div className="settings-sheet-ledger">
        <div className="settings-sheet-ledger-head">
          <strong>本月生成账本</strong>
          <Button variant="ghost" size="sm" onClick={() => void form.refreshGeneration().catch(() => undefined)}>
            刷新
          </Button>
        </div>
        {(generationLedger?.entries.length ?? 0) === 0 ? (
          <p>本月尚无生成记录。</p>
        ) : (
          <div className="settings-sheet-ledger-table settings-sheet-ledger-table--generation" role="table" aria-label="最近生成账本">
            <div role="row" className="settings-sheet-ledger-header">
              <span role="columnheader">时间</span>
              <span role="columnheader">章节·slot</span>
              <span role="columnheader">模型</span>
              <span role="columnheader">秒</span>
              <span role="columnheader">预估费用</span>
              <span role="columnheader">状态</span>
            </div>
            {(generationLedger?.entries ?? []).map((entry) => (
              <div role="row" key={`${entry.request_id}-${entry.at}`}>
                <time role="cell">{entry.at.replace("T", " ").slice(0, 19)}</time>
                <span role="cell">{entry.chapter_title}·{entry.slot}</span>
                <span role="cell">{entry.model}（{entry.resolution}）</span>
                <span role="cell">{entry.seconds}s</span>
                <span role="cell">${entry.cost_usd.toFixed(2)}</span>
                <strong role="cell" data-status={entry.status}>{generationLedgerStatusLabel(entry.status)}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
      <Note title="生成物只进素材库的 generated/ 目录">
        生成的片段会存到素材库的 generated/ 目录，原素材目录不会被写入；账本记录的是提交时的预估费用，实际扣费以 MiniMax 平台账单为准。
      </Note>
    </>
  );
}
