import { useEffect, useRef, useState, type JSX } from "react";

import { focusPipelineStep } from "./pipelineActions";
import { PIPELINE_STEPS, PIPELINE_STEP_MARKS, PIPELINE_STEP_NAMES, pipelineStepCount, type PipelineState, type PipelineStep } from "./pipelineModel";
import { COMPACT_WIDE_QUERY } from "./shellLayout";
import { Icon } from "./ui";
import { useWorkspace } from "./WorkspaceStore";

export interface PipelineRailProps {
  state: PipelineState;
}

/** R18 V-07:标准档才排得下四步的文字,紧凑档折叠成一颗胶囊(不是四个没有文字的裸圈)。R19 V-11:阈值读壳的唯一断点。 */
const WIDE_QUERY = COMPACT_WIDE_QUERY;

/** 没有 matchMedia 的环境(单测 / SSR)当作宽屏 —— 展开态是既有行为,冻结的 AX 名都在那一支上。 */
function useWideTopBar(): boolean {
  const [wide, setWide] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia(WIDE_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/**
 * 顶栏中央、集切换器右侧的四步导航(规格 §1 第一条):「① 导入 21 条 → ② 挑选 4 段 →
 * ③ 排列 0/2 章 → ④ 导出」。当前步高亮(`aria-current="step"`)、完成步打勾、未开始步灰;
 * 每步可点 = 把界面焦点带到那一步。
 *
 * R18 V-07:紧凑档(<--bp-compact)整条折叠成一颗「第 ④ 步 · 导出 ⌄」胶囊,点开是同样四步的菜单。
 * 此前窄屏是四个没有文字的裸圈:占着 100px 却不给信息(08-narrow-1280.png)。
 *
 * AX:`nav` 名「流水线」,四个 `button` 名固定为「第 n 步 导入/挑选/排列/导出」——
 * 计数是视觉,不进名字,冒烟脚本按名字找得到、数字变了也不断。折叠态的四项是同名
 * `menuitem`(名字一字不差),胶囊自己的新名是「流水线当前步」。
 */
export function PipelineRail({ state }: PipelineRailProps): JSX.Element {
  const openDrawer = useWorkspace((snapshot) => snapshot.openDrawer);
  const wide = useWideTopBar();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);

  // 宽屏没有菜单这回事;从窄切宽时把它关掉,免得留一个孤儿浮层。
  useEffect(() => {
    if (wide) setOpen(false);
  }, [wide]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const stepAria = (step: PipelineStep): string => `第 ${step} 步 ${PIPELINE_STEP_NAMES[step]}`;
  const tone = (step: PipelineStep): string => {
    const index = PIPELINE_STEPS.indexOf(step);
    if (state.step === step) return "current";
    if (state.done[index]) return "done";
    return step < state.step ? "pending" : "todo";
  };
  const drawerExpanded = (step: PipelineStep): boolean | undefined =>
    step === 1 ? openDrawer === "import" : step === 4 ? openDrawer === "deliver" : undefined;

  if (!wide) {
    const current = state.step;
    const count = pipelineStepCount(state, current);
    return (
      <nav className="pipeline-rail pipeline-rail--collapsed" aria-label="流水线" ref={rootRef}>
        <button
          type="button"
          className={`pipeline-rail-step pipeline-rail-trigger pipeline-rail-item--${tone(current)}`}
          aria-label="流水线当前步"
          aria-haspopup="menu"
          aria-expanded={open}
          title={count ? `${PIPELINE_STEP_NAMES[current]} · ${count}` : PIPELINE_STEP_NAMES[current]}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="pipeline-rail-name">
            {`第 ${PIPELINE_STEP_MARKS[current]} 步 · ${PIPELINE_STEP_NAMES[current]}`}
          </span>
          <Icon name="chevron-down" size={12} />
        </button>
        {open ? (
          <div className="pipeline-rail-menu" role="menu" aria-label="流水线">
            {PIPELINE_STEPS.map((step) => {
              const stepCount = pipelineStepCount(state, step);
              return (
                <button
                  type="button"
                  role="menuitem"
                  key={step}
                  className={`pipeline-rail-menuitem pipeline-rail-item--${tone(step)}`}
                  aria-label={stepAria(step)}
                  aria-current={state.step === step ? "step" : undefined}
                  onClick={() => {
                    setOpen(false);
                    focusPipelineStep(step);
                  }}
                >
                  <span className="pipeline-rail-mark" aria-hidden="true">
                    {state.done[PIPELINE_STEPS.indexOf(step)] && state.step !== step ? <Icon name="check" size={12} /> : step}
                  </span>
                  <span className="pipeline-rail-name" aria-hidden="true">
                    {PIPELINE_STEP_NAMES[step]}
                  </span>
                  {stepCount ? (
                    <span className="pipeline-rail-count" aria-hidden="true">
                      {stepCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </nav>
    );
  }

  return (
    <nav className="pipeline-rail" aria-label="流水线" ref={rootRef}>
      <ol className="pipeline-rail-list">
        {PIPELINE_STEPS.map((step, index) => {
          const done = state.done[index];
          const current = state.step === step;
          const count = pipelineStepCount(state, step);
          return (
            <li className={`pipeline-rail-item pipeline-rail-item--${tone(step)}`} key={step}>
              <button
                type="button"
                className="pipeline-rail-step"
                aria-label={stepAria(step)}
                aria-current={current ? "step" : undefined}
                aria-haspopup={drawerExpanded(step) === undefined ? undefined : "dialog"}
                aria-expanded={drawerExpanded(step)}
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
