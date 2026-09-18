import type { JSX } from "react";
import { returnToActiveEpisode } from "../historyView";
import { EpisodeSwitcher } from "./EpisodeSwitcher";
import { pinHome, useHomeOpen } from "./homeStore";
import { PipelineRail } from "./PipelineRail";
import { focusPipelineStep, runPipelineNext } from "./pipelineActions";
import { pipelineGapLabel, pipelineNextDisabled, pipelineNextLabel } from "./pipelineModel";
import { PIPELINE_HINTS } from "./pipelineHints";
import { useAnalysisEta } from "./analysisEta";
import { ActionKbd } from "./KeymapKbd";
import { Button, Icon } from "./ui";
import { usePipeline } from "./usePipeline";
import { UpdateTopChip } from "./update/UpdateTopChip";
import { useUpdateState } from "./update/updateStore";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";

/**
 * 顶栏(高 44px,规格 §3.1)。左起品牌记号 + 字标 + 「导入素材」,居中「切换集」胶囊 +
 * 四步流水线导航(R12 §1),右侧「命令面板 ⌘K」提示、「下一步:…」(唯一的强调色主按钮)
 * 与齿轮「设置」。
 *
 * R12:原「生成交付包」主按钮并入导出抽屉的「完整交付包」模式;顶栏这颗的 AX 名固定为
 * 「流水线下一步」,可见文案随流水线走(下一步:导入素材 / 自动挑选 / 排到镜头带 / 导出;
 * 四步全完成 → 再导出一次)。**没有英文 kicker** —— 冒烟脚本按这个断言。
 * 冻结的 AX 名:导入素材 / 切换集 / 流水线下一步 / 设置;键帽提示(⌘I / ⌘K)是
 * `aria-hidden` 的视觉引导,不进 AX 名。
 */
/** Z-14:只读查看已封存集时顶栏主按钮的文案 —— 导出只能对当前集做,按钮变成回到当前集。 */
export const RETURN_TO_EXPORT_LABEL = "回到当前集再导出";

export function TopBar(): JSX.Element {
  const openDrawer = useWorkspace((state) => state.openDrawer);
  const viewingEpisode = useWorkspace((state) => state.viewingEpisode);
  const pipeline = usePipeline();
  const homeOpen = useHomeOpen();
  // V-08:更新就绪时那颗按钮降成 ghost(唯一的实心主按钮留给「下一步」),
  // 「还有更新等着」改由齿轮右上角一枚小圆点说 —— 降级不等于藏起来。
  const updatePhase = useUpdateState().phase;
  // R19 U-01(flow 车道):一条都没分析完时主按钮禁用,文案带进度 + 预计时间;有已分析的就「先挑已分析的 x/N 条」。
  const nextDisabled = !viewingEpisode && pipelineNextDisabled(pipeline);
  const analysisEta = useAnalysisEta(nextDisabled);
  const nextLabel = viewingEpisode ? RETURN_TO_EXPORT_LABEL : pipelineNextLabel(pipeline, analysisEta);
  // Z-03:段都排进去了但还有章没镜 → 主按钮已是「导出」,旁边给一颗 ghost「补缺口 n 章」(聚焦镜头带)。
  const gapLabel = viewingEpisode ? null : pipelineGapLabel(pipeline);
  const nextIcon = pipeline.complete || pipeline.step === 4 ? "deliver" : pipeline.step === 1 ? "import" : pipeline.step === 2 ? "star" : "grip";
  // 下一步落在抽屉上(① / ④)时按钮是抽屉的开关,带 haspopup / expanded;②③ 落在栏里,不带。
  const opensDrawer = !viewingEpisode && (pipeline.complete || pipeline.step === 1 || pipeline.step === 4);
  const nextDrawer = pipeline.complete || pipeline.step === 4 ? "deliver" : "import";
  // R19 V-02:原「第 n 步提示」那一行删了,这句怎么做进按钮 tooltip(首页四步卡另有一份)。
  const nextTitle = viewingEpisode ? nextLabel : `${nextLabel} —— ${PIPELINE_HINTS[pipeline.step]}`;

  return (
    <header className="workspace-topbar">
      <div className="workspace-topbar-left">
        {/* R13 §3:logo 是首页的开关(剪映的心智:点左上角回首页);有素材时首页只从这里进。 */}
        <button
          type="button"
          className="workspace-brand workspace-brand-button"
          aria-label="首页"
          aria-pressed={homeOpen}
          title={homeOpen ? "回到工作区" : "首页"}
          onClick={() => pinHome(!homeOpen)}
        >
          <span className="workspace-brand-mark" aria-hidden="true">
            <Icon name="play" size={12} />
          </span>
          <span className="workspace-wordmark">旅剪工作台</span>
        </button>
        <Button
          variant="secondary"
          icon="import"
          aria-haspopup="dialog"
          aria-expanded={openDrawer === "import"}
          aria-label="导入素材"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" })}
        >
          导入素材
          <ActionKbd action="import" />
        </Button>
      </div>

      <div className="workspace-topbar-center">
        <EpisodeSwitcher />
        <PipelineRail state={pipeline} />
      </div>

      <div className="workspace-topbar-right" data-update-dot={updatePhase === "ready" ? "true" : undefined}>
        <span className="workspace-topbar-hint" aria-hidden="true">
          命令面板
          <ActionKbd action="command-palette" />
        </span>
        {gapLabel ? (
          <Button variant="ghost" icon="grip" className="pipeline-gap" aria-label="补缺口" title="镜头带里还有章没镜:补一条,或点「这章够了」" onClick={() => focusPipelineStep(3)}>
            {gapLabel}
          </Button>
        ) : null}
        <Button
          // R19 V-01:全应用唯一的实心主按钮。首页盖着三栏时,首页自己的「开始一个新旅程」是那一颗,这里让位。
          variant={homeOpen ? "secondary" : "primary"}
          icon={nextIcon}
          className="pipeline-next"
          aria-haspopup={opensDrawer ? "dialog" : undefined}
          aria-expanded={opensDrawer ? openDrawer === nextDrawer : undefined}
          aria-label="流水线下一步"
          title={nextTitle}
          data-step={pipeline.step}
          disabled={nextDisabled}
          onClick={() => (viewingEpisode ? returnToActiveEpisode() : runPipelineNext(pipeline))}
        >
          {nextLabel}
        </Button>
        <UpdateTopChip />
        <Button
          variant="icon"
          icon="settings"
          aria-haspopup="dialog"
          aria-expanded={openDrawer === "settings"}
          aria-label="设置"
          title="设置 ⌘,"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "settings" })}
        />
      </div>
    </header>
  );
}
