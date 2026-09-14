import type { JSX } from "react";

import { focusPipelineStep } from "./pipelineActions";
import { PIPELINE_STEPS, PIPELINE_STEP_NAMES, pipelineStepCount, type PipelineState, type PipelineStep } from "./pipelineModel";
import { Icon } from "./ui";
import { useWorkspace } from "./WorkspaceStore";

export interface PipelineRailProps {
  state: PipelineState;
}

/**
 * 顶栏中央、集切换器右侧的四步导航(规格 §1 第一条):「① 导入 21 条 → ② 挑选 4 段 →
 * ③ 排列 0/2 章 → ④ 导出」。当前步高亮(`aria-current="step"`)、完成步打勾、未开始步灰;
 * 每步可点 = 把界面焦点带到那一步。1280 宽以下只留数字与勾(CSS)。
 *
 * AX:`nav` 名「流水线」,四个 `button` 名固定为「第 n 步 导入/挑选/排列/导出」——
 * 计数是视觉,不进名字,冒烟脚本按名字找得到、数字变了也不断。
 */
export function PipelineRail({ state }: PipelineRailProps): JSX.Element {
  const openDrawer = useWorkspace((snapshot) => snapshot.openDrawer);
  return (
    <nav className="pipeline-rail" aria-label="流水线">
      <ol className="pipeline-rail-list">
        {PIPELINE_STEPS.map((step, index) => {
          const done = state.done[index];
          const current = state.step === step;
          const count = pipelineStepCount(state, step);
          // 已走过但没打勾(素材还在分析)= 进行中:数字留着,圆圈用强调色虚线。
          const tone = current ? "current" : done ? "done" : step < state.step ? "pending" : "todo";
          const expanded = step === 1 ? openDrawer === "import" : step === 4 ? openDrawer === "deliver" : undefined;
          return (
            <li className={`pipeline-rail-item pipeline-rail-item--${tone}`} key={step}>
              <button
                type="button"
                className="pipeline-rail-step"
                aria-label={`第 ${step} 步 ${PIPELINE_STEP_NAMES[step]}`}
                aria-current={current ? "step" : undefined}
                aria-haspopup={expanded === undefined ? undefined : "dialog"}
                aria-expanded={expanded}
                title={count ? `${PIPELINE_STEP_NAMES[step]} · ${count}` : PIPELINE_STEP_NAMES[step]}
                onClick={() => focusPipelineStep(step)}
              >
                <span className="pipeline-rail-mark" aria-hidden="true">
                  {done && !current ? <Icon name="check" size={12} /> : step}
                </span>
                <span className="pipeline-rail-name" aria-hidden="true">
                  {PIPELINE_STEP_NAMES[step]}
                </span>
                {count ? (
                  <span className="pipeline-rail-count" aria-hidden="true">
                    {count}
                  </span>
                ) : null}
              </button>
              {index < PIPELINE_STEPS.length - 1 ? <span className="pipeline-rail-link" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export type { PipelineStep };
