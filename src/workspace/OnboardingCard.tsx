import type { JSX } from "react";

import { ONBOARDING_STEPS, OPEN_AUTO_SELECT_EVENT, useOnboarding } from "./onboarding";
import { Placeholder } from "./MonitorParts";
import { Button, Icon } from "./ui";
import { dispatchWorkspace } from "./WorkspaceStore";

export interface OnboardingCardProps {
  clipCount: number;
  loading: boolean;
  /** 仅测试用:库空时也让第 2 / 3 步可点,验证按钮去向。 */
  forceEnabled?: boolean;
}

/**
 * 首启三步引导(R11 简化专项 #1):放在空工作区的预览区里,一张轻卡片,不是模态、
 * 不抢焦点;「×」关掉或库里出现素材后就不再出现(`onboarding.steps_seen`)。
 * 只有第一步是 primary —— 每屏一个主动作;第 2 / 3 步在库空时先禁用。
 */
export function OnboardingCard({ clipCount, loading, forceEnabled = false }: OnboardingCardProps): JSX.Element | null {
  const onboarding = useOnboarding(clipCount, loading);
  if (!onboarding.visible) return null;
  return <OnboardingCardView laterEnabled={forceEnabled || clipCount > 0} onDismiss={onboarding.dismiss} />;
}

/** 纯展示层:谁持有 `useOnboarding` 谁传 `onDismiss`(MonitorIdle 持有,免得父子各订阅一份、关掉后父层还以为可见)。 */
export function OnboardingCardView({ laterEnabled, onDismiss }: { laterEnabled: boolean; onDismiss(): void }): JSX.Element {
  const run = (id: (typeof ONBOARDING_STEPS)[number]["id"]) => {
    if (id === "import") dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
    else if (id === "pick") window.dispatchEvent(new CustomEvent(OPEN_AUTO_SELECT_EVENT));
    else dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
  };
  return (
    <div className="monitor-stage onboarding-stage">
      <div className="onboarding-card" role="group" aria-label="三步上手">
        <div className="onboarding-head">
          <span className="onboarding-kicker">开包即用 · 三步</span>
          <Button variant="icon" icon="x" size="sm" aria-label="关闭引导" title="关闭引导" onClick={onDismiss} />
        </div>
        <ol className="onboarding-steps">
          {ONBOARDING_STEPS.map((step, index) => (
            <li className="onboarding-step" key={step.id}>
              <span className="onboarding-index" aria-hidden="true">{index + 1}</span>
              <div className="onboarding-copy">
                <strong className="onboarding-title">{step.title}</strong>
                <span className="onboarding-body">{step.body}</span>
              </div>
              <Button
                variant={index === 0 ? "primary" : "secondary"}
                icon={index === 0 ? "import" : index === 1 ? "star" : "deliver"}
                disabled={index > 0 && !laterEnabled}
                title={index > 0 && !laterEnabled ? "先导入素材" : undefined}
                onClick={() => run(step.id)}
              >
                {step.action}
              </Button>
              {index < ONBOARDING_STEPS.length - 1 ? (
                <Icon name="chevron-right" size={16} className="onboarding-arrow" />
              ) : null}
            </li>
          ))}
        </ol>
        <p className="onboarding-foot">随时按 <kbd>?</kbd> 看快捷键;所有分析都在本机完成,原片不会被改动。</p>
      </div>
    </div>
  );
}

/** 监视器「未选择」态:先给三步引导;它不可见(看过 / 库里有东西 / 关掉了)就落回原来的占位句。 */
export function MonitorIdle({ clipCount, loading }: { clipCount: number; loading: boolean }): JSX.Element {
  const onboarding = useOnboarding(clipCount, loading);
  if (onboarding.visible) return <OnboardingCardView laterEnabled={clipCount > 0} onDismiss={onboarding.dismiss} />;
  return <Placeholder title="从左侧媒体池选一条素材" reason="选中后在这里预览,I / O 打点。" />;
}
