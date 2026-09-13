import { useState, type JSX } from "react";
import { DeliverContents, DeliverPartsDetails } from "./deliver/DeliverContents";
import { DeliverFooter } from "./deliver/DeliverFooter";
import { DeliverForm } from "./deliver/DeliverForm";
import { DeliverProgressCard } from "./deliver/DeliverProgressCard";
import { DeliverResultCard, JianyingResultCard } from "./deliver/DeliverResultCard";
import { PLATFORM_LABELS, canvasLabel, isExportActive, readCanvas } from "./deliver/deliverModel";
import { QuickExportFooter, QuickExportPanel } from "./deliver/QuickExportPanel";
import { DEFAULT_EXPORT_MODE, EXPORT_MODE_LABELS, type ExportMode } from "./deliver/quickExportModel";
import { useDeliverForm } from "./deliver/useDeliverForm";
import { CANVAS_SOURCE_LABELS } from "./deliver/useExportCanvas";
import { useExportProgress, type ExportProgress } from "./deliver/useExportProgress";
import { useQuickExport } from "./deliver/useQuickExport";
import { Chip } from "./ui/Chip";
import { Drawer } from "./ui/Drawer";
import { dispatchWorkspace, useWorkspace, type WorkspaceState } from "./WorkspaceStore";

function close(): void {
  dispatchWorkspace({ type: "close-drawer" });
}

/**
 * 交付抽屉本体(规格 §4.2):副标题 → 交付目标 / 输出格式 / 内容 三节 → 进度卡或结果卡 →
 * 「交付包里有什么」折叠段;页脚 取消 / 生成交付包。逻辑全在两个 hook 里,这里只是皮。
 * 只在抽屉打开时挂载:轮询与 deliver-availability 广播随抽屉起落。
 */
function FullDeliverBody({ progress }: { progress: ExportProgress }): JSX.Element {
  const form = useDeliverForm(progress);
  const { useJianyingDraft, setUseJianyingDraft } = form;
  const { status } = progress;
  const active = isExportActive(status);
  // 画布(U-05 / U-20):优先后端现算的 previewExportCanvas(带来源);读不到再回落导出状态 / 预设上的可选 canvas 字段。
  const canvasSize = form.canvas ?? readCanvas(status, form.preset);
  const canvas = form.canvas
    ? `${canvasLabel(form.canvas)} · ${CANVAS_SOURCE_LABELS[form.canvas.orientation_source]}`
    : canvasLabel(canvasSize);
  const subtitle = [form.episodeTitle || "当前集", `交付给${PLATFORM_LABELS[form.overridePlatform]}`, canvas, "保存到你选择的文件夹"]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <>
      <div className="deliver-drawer-scroll">
        <p className="deliver-subtitle">{subtitle}</p>
        <DeliverForm form={form} useJianyingDraft={useJianyingDraft} onUseJianyingDraftChange={setUseJianyingDraft} />
        <DeliverContents
          status={status}
          includeContactSheet={form.includeContactSheet}
          useJianyingDraft={useJianyingDraft && form.jianying.supported}
          targetSeconds={form.targetSeconds}
          canvas={canvasSize}
        />
        {form.nativeResult ? <JianyingResultCard result={form.nativeResult} /> : null}
        {active ? <DeliverProgressCard status={status} /> : <DeliverResultCard status={status} onReveal={() => void form.reveal()} />}
        <DeliverPartsDetails canvas={canvasSize} />
      </div>
      <DeliverFooter form={form} status={status} useJianyingDraft={useJianyingDraft && form.jianying.supported} onClose={close} />
    </>
  );
}

/** R11 车道 E:快速导出正文——清单 + 「导出」,没有平台 / 粗剪 / 联系表 / 剪映。 */
function QuickExportBody({ progress }: { progress: ExportProgress }): JSX.Element {
  const quick = useQuickExport(progress);
  return (
    <>
      <div className="deliver-drawer-scroll">
        <QuickExportPanel quick={quick} status={progress.status} />
      </div>
      <QuickExportFooter quick={quick} status={progress.status} onClose={close} />
    </>
  );
}

const MODES: ExportMode[] = ["quick", "full"];

/**
 * 抽屉本体:顶部两枚模式 chip「快速导出」(默认)/「完整交付包」(R11 §2),轮询共用一份
 * (换模式不丢进行中的任务;任务进行中 chip 禁用)。
 */
function DeliverDrawerBody(): JSX.Element {
  const progress = useExportProgress();
  const [mode, setMode] = useState<ExportMode>(DEFAULT_EXPORT_MODE);
  const active = isExportActive(progress.status);
  return (
    <div className="deliver-drawer">
      <div className="deliver-mode" role="group" aria-label="导出方式">
        {MODES.map((candidate) => (
          <Chip key={candidate} selected={mode === candidate} disabled={active} onClick={() => setMode(candidate)}>
            {EXPORT_MODE_LABELS[candidate]}
          </Chip>
        ))}
        <span className="deliver-mode-hint">{mode === "quick" ? "只导片段和收藏的视频文件" : "视频 + 参考粗剪 + 镜头表 + 说明"}</span>
      </div>
      {mode === "quick" ? <QuickExportBody progress={progress} /> : <FullDeliverBody progress={progress} />}
    </div>
  );
}

/** 交付抽屉:从右侧滑入,宽 min(720, 60vw)(规格 §1、§4.2)。 */
export function DeliverDrawer(): JSX.Element | null {
  const open = useWorkspace((state: WorkspaceState) => state.openDrawer === "deliver");

  return (
    <Drawer open={open} title="生成交付包" side="right" width="min(720px, 60vw)" onClose={close}>
      {open ? <DeliverDrawerBody /> : null}
    </Drawer>
  );
}
