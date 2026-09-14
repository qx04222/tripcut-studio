import type { JSX } from "react";

import { DEFAULT_SETTINGS } from "../../appearance";
import { Button, SectionHeader, Select, Toggle } from "../ui";
import { BudgetMeter, SettingsRow, StatusPill, ThresholdRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";
import { llmLedgerPurposeLabel, llmLedgerStatusLabel } from "./settingsModel";

const BEST_TAKE_AXES = [
  ["technical", "Technical", "对焦、曝光与画面技术质量"],
  ["composition", "Composition", "画面识别估算的构图"],
  ["motion", "Motion", "稳定度与首尾抖动分差"],
  ["human", "Human", "画面识别估算的人物自然度"],
  ["audio", "Audio", "音量统计与转写清晰度"],
  ["narrative", "Narrative", "D3 故事位置回填"],
] as const;

export function AnalysisSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings, llmStatus, llmLedger } = form;
  const save = (key: string, value: string) => void form.save(key, value);

  return (
    <>
      <SectionHeader title="分析与 AI" description="分析严格程度与可选的大模型增强集中管理；既有结果不会被静默改写。" />
      <div className="settings-sheet-subhead">
        <strong>分析严格程度</strong>
        <small>新任务执行时读取当前值。</small>
      </div>
      <div className="settings-sheet-group">
        <ThresholdRow
          label="场景切分 T"
          description="越低越容易切出新场景"
          settingKey="analysis.scene_threshold"
          value={settings["analysis.scene_threshold"]}
          defaultValue={DEFAULT_SETTINGS["analysis.scene_threshold"]}
          min="0.10" max="0.80" step="0.01" onChange={save}
        />
        <ThresholdRow
          label="语义相似度"
          description="低于此值的画面搜索结果不展示"
          settingKey="analysis.similarity_threshold"
          value={settings["analysis.similarity_threshold"]}
          defaultValue={DEFAULT_SETTINGS["analysis.similarity_threshold"]}
          min="0.00" max="1.00" step="0.01" onChange={save}
        />
        <ThresholdRow
          label="抖动阈值"
          description="抖动分 = 运镜轨迹高频能量占比（0–1）；高于此值显示“手持抖动”角标"
          settingKey="analysis.jitter_threshold"
          value={settings["analysis.jitter_threshold"]}
          defaultValue={DEFAULT_SETTINGS["analysis.jitter_threshold"]}
          min="0.00" max="1.00" step="0.01" onChange={save}
        />
      </div>

      <div className="settings-sheet-subhead">
        <strong>自动选优的六项权重</strong>
        <small>仅对已有轴归一化；Narrative 在 D3 回填前不会稀释总分。</small>
      </div>
      <div className="settings-sheet-group">
        {BEST_TAKE_AXES.map(([key, label, description]) => {
          const settingKey = `best_take.weight.${key}`;
          return (
            <ThresholdRow
              key={key}
              label={label}
              description={description}
              settingKey={settingKey}
              value={settings[settingKey]}
              defaultValue={DEFAULT_SETTINGS[settingKey]}
              min="0.00" max="1.00" step="0.01"
              onChange={save}
              deferCommit
            />
          );
        })}
      </div>

      <SectionHeader
        title="大模型增强(可选)"
        description="默认关闭且不选择 provider。只在你明确触发 AI 描述、导演问答或叙事编排时启动一次短命 CLI 子进程。"
        className="settings-sheet-section-gap"
      />
      <div className="settings-sheet-group">
        <SettingsRow title="启用增强分析" help="关闭时后端在预算检查和服务商路由之前拒绝全部大模型调用。" align="end">
          <Toggle label="启用增强分析" checked={settings.llm_enabled === "true"} onChange={(next) => void form.setLlmEnabled(next)} />
        </SettingsRow>
        <SettingsRow title="Provider" help="必须明确锁定单一 provider；失败即报错，不向其他服务自动转发。" htmlFor="settings-llm-provider">
          <Select id="settings-llm-provider" value={settings.llm_provider} onChange={(event) => void form.saveLlmProvider(event.currentTarget.value)}>
            <option value="none">未选择 / 禁止调用</option>
            <option value="auto" disabled>旧版 Auto / 已禁用</option>
            <option value="claude">Claude / claude -p</option>
            <option value="codex">Codex / codex exec</option>
            <option value="kimi">Kimi / kimi -p</option>
          </Select>
        </SettingsRow>
        <SettingsRow title="每月调用预算" help="0–10000 次；达到上限后熔断，不启动 CLI。" htmlFor="settings-llm-budget">
          <input
            id="settings-llm-budget"
            className="settings-sheet-input settings-sheet-input--number"
            type="number"
            min="0"
            max="10000"
            step="1"
            value={settings.llm_monthly_budget}
            onChange={(event) => form.setDraft("llm_monthly_budget", event.currentTarget.value)}
            onBlur={(event) => void form.saveLlmBudget(event.currentTarget.value)}
          />
        </SettingsRow>
      </div>
      <BudgetMeter
        exhausted={llmStatus?.budget_exhausted ?? false}
        cells={[
          ["本月调用", `${llmStatus?.calls_this_month ?? 0} / ${llmStatus?.monthly_budget ?? 200}`],
          [
            "状态",
            !llmStatus?.enabled ? "已关闭" : llmStatus?.budget_exhausted ? "预算已熔断" : `剩余 ${llmStatus?.remaining_calls ?? 0} 次`,
          ],
        ]}
      />
      {(llmStatus?.providers ?? []).length > 0 ? (
        <div className="settings-sheet-providers" aria-label="LLM CLI 可用性">
          {(llmStatus?.providers ?? []).map((provider) => (
            <div key={provider.provider}>
              <strong>{provider.provider}</strong>
              <StatusPill available={provider.available}>{provider.available ? "PATH 已找到" : "PATH 未找到"}</StatusPill>
              <code>{provider.executable}</code>
            </div>
          ))}
        </div>
      ) : null}
      <div className="settings-sheet-ledger">
        <div className="settings-sheet-ledger-head">
          <strong>最近 20 条调用账本</strong>
          <Button variant="ghost" size="sm" onClick={() => void form.refreshLlm().catch(() => undefined)}>
            刷新
          </Button>
        </div>
        {llmLedger.length === 0 ? (
          <p>尚无调用记录。provider 缺失或开关关闭不会消耗预算。</p>
        ) : (
          <div className="settings-sheet-ledger-table settings-sheet-ledger-table--llm" role="table" aria-label="最近 LLM 调用账本">
            {llmLedger.map((entry) => (
              <div role="row" key={entry.id} title={entry.error_summary ?? undefined}>
                <time role="cell">{entry.called_at.replace("T", " ").slice(0, 19)}</time>
                <span role="cell">{entry.provider}</span>
                <span role="cell">{llmLedgerPurposeLabel(entry.purpose)}</span>
                <span role="cell">≈{entry.estimated_tokens} tokens</span>
                <strong role="cell" data-status={entry.status}>{llmLedgerStatusLabel(entry.status)}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
