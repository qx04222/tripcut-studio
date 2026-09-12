import { useState, type JSX } from "react";
import { DeliverContents, DeliverPartsDetails } from "./deliver/DeliverContents";
import { DeliverFooter } from "./deliver/DeliverFooter";
import { DeliverForm } from "./deliver/DeliverForm";
import { DeliverProgressCard } from "./deliver/DeliverProgressCard";
import { DeliverResultCard, JianyingResultCard } from "./deliver/DeliverResultCard";
import { PLATFORM_LABELS, isExportActive } from "./deliver/deliverModel";
import { useDeliverForm } from "./deliver/useDeliverForm";
import { useExportProgress } from "./deliver/useExportProgress";
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
function DeliverDrawerBody(): JSX.Element {
  const progress = useExportProgress();
  const form = useDeliverForm(progress);
  const [useJianyingDraft, setUseJianyingDraft] = useState(false);
  const { status } = progress;
  const active = isExportActive(status);
  const subtitle = [form.episodeTitle || "当前集", `交付给${PLATFORM_LABELS[form.overridePlatform]}`, "保存到你选择的文件夹"].join(" · ");

  return (
    <div className="deliver-drawer">
      <div className="deliver-drawer-scroll">
        <p className="deliver-subtitle">{subtitle}</p>
        <DeliverForm form={form} useJianyingDraft={useJianyingDraft} onUseJianyingDraftChange={setUseJianyingDraft} />
        <DeliverContents
          status={status}
          includeContactSheet={form.includeContactSheet}
          useJianyingDraft={useJianyingDraft && form.jianying.supported}
          targetSeconds={form.targetSeconds}
        />
        {form.nativeResult ? <JianyingResultCard result={form.nativeResult} /> : null}
        {active ? <DeliverProgressCard status={status} /> : <DeliverResultCard status={status} onReveal={() => void form.reveal()} />}
        <DeliverPartsDetails />
      </div>
      <DeliverFooter form={form} status={status} useJianyingDraft={useJianyingDraft && form.jianying.supported} onClose={close} />
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
