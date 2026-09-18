import { useEffect, type JSX } from "react";

import { reportTeachingWant, useTeaching } from "./guides";
import { ONBOARDING_STEPS, useOnboarding } from "./onboarding";
import { Placeholder } from "./MonitorParts";
import { runPipelineNext } from "./pipelineActions";
import { Button, Icon } from "./ui";
import { usePipeline } from "./usePipeline";

export interface OnboardingCardProps {
  clipCount: number;
  loading: boolean;
}

/**
 * 首启四步引导(R11 简化专项 #1 → R12 §1):放在空工作区的预览区里,一张轻卡片,不是模态、
 * 不抢焦点;「×」关掉或库里出现素材后就不再出现(`onboarding.steps_seen`)。
 * 四步与顶栏导航条同一套数据(usePipeline);只有一个主动作「开始使用」= 流水线的下一步。
 */
export function OnboardingCard({ clipCount, loading }: OnboardingCardProps): JSX.Element | null {
  const onboarding = useOnboarding(clipCount, loading);
  const slot = useTeachingSlot("onboarding", onboarding.visible);
  if (!slot) return null;
  return <OnboardingCardView onDismiss={onboarding.dismiss} />;
}

/** R19 U-02:向仲裁器报「想出」,只在拿到槽时渲染;卸载时把 want 撤回。 */
function useTeachingSlot(channel: "onboarding", wants: boolean): boolean {
  useEffect(() => {
    reportTeachingWant(channel, wants);
    return () => reportTeachingWant(channel, false);
  }, [channel, wants]);
  return useTeaching(channel) && wants;
}

/** 纯展示层:谁持有 `useOnboarding` 谁传 `onDismiss`(MonitorIdle 持有,免得父子各订阅一份、关掉后父层还以为可见)。 */
export function OnboardingCardView({ onDismiss }: { onDismiss(): void }): JSX.Element {
  const pipeline = usePipeline();
  return (
    <div className="monitor-stage onboarding-stage" data-teach="onboarding">
      <div className="onboarding-card" role="group" aria-label="四步上手">
        <div className="onboarding-head">
          <span className="onboarding-kicker">开包即用 · 一条流水线四步</span>
          <Button variant="icon" icon="x" size="sm" aria-label="关闭引导" title="关闭引导" onClick={onDismiss} />
        </div>
        <ol className="onboarding-steps onboarding-steps--four">
          {ONBOARDING_STEPS.map((step, index) => {
            const done = pipeline.done[index];
            const current = pipeline.step === index + 1;
            const tone = current ? "current" : done ? "done" : "todo";
            return (
              <li className={`onboarding-step onboarding-step--${tone}`} key={step.id} aria-current={current ? "step" : undefined}>
                <span className="onboarding-index" aria-hidden="true">
                  {done ? <Icon name="check" size={12} /> : index + 1}
                </span>
                <div className="onboarding-copy">
                  <strong className="onboarding-title">{step.title}</strong>
                  <span className="onboarding-body">{step.body}</span>
                </div>
                {index < ONBOARDING_STEPS.length - 1 ? (
                  <Icon name="chevron-right" size={16} className="onboarding-arrow" />
                ) : null}
              </li>
            );
          })}
        </ol>
        <div className="onboarding-actions">
          <Button variant="primary" icon="import" aria-label="开始使用" onClick={() => runPipelineNext(pipeline)}>
            开始使用
          </Button>
          {/* R19 Q-5 业主拍板:「集」保留,首启卡说一次「一集 = 一个草稿」。 */}
          <p className="onboarding-foot">
            一集 = 剪映里的一个草稿。先选文件夹;之后顶栏右上角永远有「下一步」。随时按 <kbd>?</kbd> 看流水线手册;所有分析都在本机完成,原片不会被改动。
          </p>
        </div>
      </div>
    </div>
  );
}

/** 监视器「未选择」态:先给四步引导;它不可见(看过 / 库里有东西 / 关掉了)就落回原来的占位句。 */
export function MonitorIdle({ clipCount, loading }: { clipCount: number; loading: boolean }): JSX.Element {
  const onboarding = useOnboarding(clipCount, loading);
  const slot = useTeachingSlot("onboarding", onboarding.visible);
  if (slot) return <OnboardingCardView onDismiss={onboarding.dismiss} />;
  return <Placeholder title="从左侧媒体池选一条素材" reason="选中后在这里预览,I / O 打点。" />;
}
