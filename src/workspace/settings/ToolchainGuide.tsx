import type { JSX } from "react";

import type { SettingsStatus } from "../../api";
import { onboardingSteps } from "../../toolchainSteps";
import { Badge, Card, Icon } from "../ui";

/**
 * R11 简化专项 #1:原首启「工具链」弹窗的内容搬到这里(设置 → 工具与模型)。
 * 全部就绪就一行绿字;有缺就逐条列出「缺什么 / 怎么办」。必需组件缺失另有首启弹窗兜底。
 */
export function ToolchainGuide({ status }: { status: SettingsStatus | null }): JSX.Element {
  const steps = status ? onboardingSteps(status) : [];
  return (
    <Card padding={3} className="settings-toolchain-guide" data-state={!status ? "checking" : steps.length === 0 ? "ok" : "todo"}>
      <div className="settings-toolchain-guide-head">
        <Icon name={steps.length === 0 ? "check" : "warning"} size={16} />
        <strong>安装检查</strong>
        {!status ? (
          <Badge tone="neutral">正在检测…</Badge>
        ) : steps.length === 0 ? (
          <Badge tone="accent" icon="check">全部就绪</Badge>
        ) : (
          <Badge tone={steps.some((step) => step.required) ? "danger" : "warn"} icon="warning">
            {steps.some((step) => step.required) ? "缺少必需组件" : `${steps.length} 项可选组件未就绪`}
          </Badge>
        )}
      </div>
      {steps.length > 0 ? (
        <ol className="settings-toolchain-guide-steps">
          {steps.map((step) => (
            <li key={step.id} className={step.required ? "is-required" : undefined}>
              <strong>{step.title}</strong>
              <span>{step.description}</span>
            </li>
          ))}
        </ol>
      ) : status ? (
        <p className="settings-toolchain-guide-note">导入、挑选、播放、转写与导出所需的组件都已找到。</p>
      ) : null}
    </Card>
  );
}
