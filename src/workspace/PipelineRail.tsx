import { useEffect, useRef, useState, type JSX } from "react";

import { focusPhotoPipelineStep } from "./photoPipelineActions";
import { PHOTO_PIPELINE_STEPS, PHOTO_PIPELINE_STEP_MARKS, PHOTO_PIPELINE_STEP_NAMES, photoPipelineStepCount, type PhotoPipelineState, type PhotoPipelineStep } from "./photoPipelineModel";
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

type Tone = "current" | "done" | "pending" | "todo";

/** 一步在导航条上要画的东西 —— 视频四步与照片三步各自拼一份,视图不认识「段 / 章 / 张」。 */
interface RailItem {
  step: number;
  mark: string;
  name: string;
  /** 「第 n 步 导入」—— AX 名;计数是视觉,不进名字。 */
  ariaLabel: string;
  count: string;
  tone: Tone;
  current: boolean;
  done: boolean;
  /** 这步落在抽屉上时是抽屉的开关(haspopup / expanded);落在栏里就 undefined。 */
  drawerExpanded: boolean | undefined;
  onFocus(): void;
}

interface RailViewProps {
  /** `nav` 的 AX 名:视频「流水线」(冻结)/ 照片「照片流水线」。 */
  label: string;
  items: readonly RailItem[];
}

/**
 * 顶栏中央、集切换器右侧的分步导航(规格 §1 第一条):视频「① 导入 21 条 → ② 挑选 4 段 →
 * ③ 排列 0/2 章 → ④ 导出」。当前步高亮(`aria-current="step"`)、完成步打勾、未开始步灰;
 * 每步可点 = 把界面焦点带到那一步。
 *
 * R18 V-07:紧凑档(<--bp-compact)整条折叠成一颗「第 ④ 步 · 导出 ⌄」胶囊,点开是同样几步的菜单。
 * 此前窄屏是四个没有文字的裸圈:占着 100px 却不给信息(08-narrow-1280.png)。
 *
 * AX:视频 `nav` 名「流水线」,四个 `button` 名固定为「第 n 步 导入/挑选/排列/导出」——
 * 计数是视觉,不进名字,冒烟脚本按名字找得到、数字变了也不断。折叠态的四项是同名
 * `menuitem`(名字一字不差),胶囊自己的新名是「流水线当前步」。
 */
function RailView({ label, items }: RailViewProps): JSX.Element {
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

  if (!wide) {
    const current = items.find((item) => item.current) ?? items[items.length - 1]!;
    return (
      <nav className="pipeline-rail pipeline-rail--collapsed" aria-label={label} ref={rootRef}>
        <button
          type="button"
          className={`pipeline-rail-step pipeline-rail-trigger pipeline-rail-item--${current.tone}`}
          aria-label="流水线当前步"
          aria-haspopup="menu"
          aria-expanded={open}
          title={current.count ? `${current.name} · ${current.count}` : current.name}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="pipeline-rail-name">{`第 ${current.mark} 步 · ${current.name}`}</span>
          <Icon name="chevron-down" size={12} />
        </button>
        {open ? (
          <div className="pipeline-rail-menu" role="menu" aria-label={label}>
            {items.map((item) => (
              <button
                type="button"
                role="menuitem"
                key={item.step}
                className={`pipeline-rail-menuitem pipeline-rail-item--${item.tone}`}
                aria-label={item.ariaLabel}
                aria-current={item.current ? "step" : undefined}
                onClick={() => {
                  setOpen(false);
                  item.onFocus();
                }}
              >
                <span className="pipeline-rail-mark" aria-hidden="true">
                  {item.done && !item.current ? <Icon name="check" size={12} /> : item.step}
                </span>
                <span className="pipeline-rail-name" aria-hidden="true">
                  {item.name}
                </span>
                {item.count ? (
                  <span className="pipeline-rail-count" aria-hidden="true">
                    {item.count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </nav>
    );
  }

  return (
    <nav className="pipeline-rail" aria-label={label} ref={rootRef}>
      <ol className="pipeline-rail-list">
        {items.map((item, index) => (
          <li className={`pipeline-rail-item pipeline-rail-item--${item.tone}`} key={item.step}>
            <button
              type="button"
              className="pipeline-rail-step"
              aria-label={item.ariaLabel}
              aria-current={item.current ? "step" : undefined}
              aria-haspopup={item.drawerExpanded === undefined ? undefined : "dialog"}
              aria-expanded={item.drawerExpanded}
              title={item.count ? `${item.name} · ${item.count}` : item.name}
              onClick={item.onFocus}
            >
              <span className="pipeline-rail-mark" aria-hidden="true">
                {item.done && !item.current ? <Icon name="check" size={12} /> : item.step}
              </span>
              <span className="pipeline-rail-name" aria-hidden="true">
                {item.name}
              </span>
              {item.count ? (
                <span className="pipeline-rail-count" aria-hidden="true">
                  {item.count}
                </span>
              ) : null}
            </button>
            {index < items.length - 1 ? <span className="pipeline-rail-link" aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function toneOf(current: boolean, done: boolean, before: boolean): Tone {
  if (current) return "current";
  if (done) return "done";
  return before ? "pending" : "todo";
}

/** 视频工作台的四步 rail(0.11.0 原样;AX 名冻结)。 */
export function PipelineRail({ state }: PipelineRailProps): JSX.Element {
  const openDrawer = useWorkspace((snapshot) => snapshot.openDrawer);
  const items: RailItem[] = PIPELINE_STEPS.map((step, index) => ({
    step,
    mark: PIPELINE_STEP_MARKS[step],
    name: PIPELINE_STEP_NAMES[step],
    ariaLabel: `第 ${step} 步 ${PIPELINE_STEP_NAMES[step]}`,
    count: pipelineStepCount(state, step),
    tone: toneOf(state.step === step, state.done[index], step < state.step),
    current: state.step === step,
    done: state.done[index],
    drawerExpanded: step === 1 ? openDrawer === "import" : step === 4 ? openDrawer === "deliver" : undefined,
    onFocus: () => focusPipelineStep(step),
  }));
  return <RailView label="流水线" items={items} />;
}

export interface PhotoPipelineRailProps {
  state: PhotoPipelineState;
}

/**
 * R21 W3 P1-1:照片工作台的三步 rail「① 导入 60 张 → ② 挑选 10 张已选 → ③ 导出精选照片」。
 * `nav` 名「照片流水线」,三个 `button` 名「第 n 步 导入 / 挑选 / 导出精选照片」;没有段、章、镜头带。
 */
export function PhotoPipelineRail({ state }: PhotoPipelineRailProps): JSX.Element {
  const openDrawer = useWorkspace((snapshot) => snapshot.openDrawer);
  const items: RailItem[] = PHOTO_PIPELINE_STEPS.map((step, index) => ({
    step,
    mark: PHOTO_PIPELINE_STEP_MARKS[step],
    name: PHOTO_PIPELINE_STEP_NAMES[step],
    ariaLabel: `第 ${step} 步 ${PHOTO_PIPELINE_STEP_NAMES[step]}`,
    count: photoPipelineStepCount(state, step),
    tone: toneOf(state.step === step, state.done[index], step < state.step),
    current: state.step === step,
    done: state.done[index],
    drawerExpanded: step === 1 ? openDrawer === "import" : step === 3 ? openDrawer === "deliver" : undefined,
    onFocus: () => focusPhotoPipelineStep(step),
  }));
  return <RailView label="照片流水线" items={items} />;
}

export type { PipelineStep, PhotoPipelineStep };
