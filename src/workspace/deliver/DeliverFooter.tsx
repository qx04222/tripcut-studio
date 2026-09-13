import type { JSX } from "react";
import type { ExportStatus } from "../../api";
import { Button } from "../ui";
import { STAGE_LABELS, isExportActive } from "./deliverModel";
import type { DeliverForm } from "./useDeliverForm";

export interface DeliverFooterProps {
  form: DeliverForm;
  status: ExportStatus;
  useJianyingDraft: boolean;
  onClose(): void;
}

type Tone = "neutral" | "warn" | "danger";

/** 页脚状态行的文案与语气:错误 > 剪映降级提示 > 忙 > 进行中 > 空 > 就绪。 */
function statusLine(form: DeliverForm, status: ExportStatus, useJianyingDraft: boolean): { text: string; tone: Tone; alert: boolean } {
  if (form.error) return { text: form.error, tone: "danger", alert: true };
  if (form.nativeNotice) return { text: form.nativeNotice, tone: "warn", alert: false };
  if (form.nativeBusy) return { text: "正在生成剪映草稿并回读自检…", tone: "neutral", alert: false };
  if (form.busy) return { text: "正在选择保存位置…", tone: "neutral", alert: false };
  if (isExportActive(status)) {
    const processed = status.completed_items + status.failed_items;
    return { text: `${STAGE_LABELS[status.stage]} · ${processed} / ${status.selected_count}`, tone: "neutral", alert: false };
  }
  if (status.selected_count === 0) {
    return { text: "还没有交付项。先在播放器保存精选片段,或在媒体池按 F 收藏整条素材。", tone: "warn", alert: false };
  }
  if (status.status === "done") return { text: "已生成。可换平台或时长再出一份。", tone: "neutral", alert: false };
  if (useJianyingDraft) return { text: "写入剪映草稿目录;自检不过会先让你选保存位置再降级为稳定包。", tone: "neutral", alert: false };
  return { text: form.destination ? `保存到 ${form.destination}` : "点「开始生成」后选择保存位置。", tone: "neutral", alert: false };
}

/**
 * 页脚:状态行 + 取消 / 开始生成(规格 §4.2 第 3 条)。进行中「取消」停任务,否则关抽屉。
 * 主按钮 AX 名「开始生成」(R10 U-20):顶栏那颗仍叫「生成交付包」,两颗不再同名,
 * 键盘 / 辅助功能用户分得清哪颗是开抽屉、哪颗是真的动手。
 */
export function DeliverFooter({ form, status, useJianyingDraft, onClose }: DeliverFooterProps): JSX.Element {
  const active = isExportActive(status);
  const line = statusLine(form, status, useJianyingDraft);
  const processed = status.completed_items + status.failed_items;
  const percent = status.selected_count === 0 ? 0 : Math.min(100, Math.round((processed / status.selected_count) * 100));
  const canSubmit = useJianyingDraft ? form.canGenerateNative : form.canGenerate;

  return (
    <footer className={`deliver-footer${active ? " deliver-footer--active" : ""}`}>
      {active ? <span className="deliver-footer-progress" style={{ width: `${percent}%` }} aria-hidden="true" /> : null}
      <p className={`deliver-footer-status deliver-footer-status--${line.tone}`} role={line.alert ? "alert" : "status"}>
        {line.text}
      </p>
      <div className="deliver-footer-actions">
        <Button variant="ghost" tone={active ? "danger" : "neutral"} onClick={active ? () => void form.cancel() : onClose}>
          取消
        </Button>
        <Button
          variant="primary"
          icon="deliver"
          busy={form.busy || form.nativeBusy}
          disabled={!canSubmit}
          title={useJianyingDraft ? "生成剪映草稿;自检不过自动降级为稳定包" : undefined}
          onClick={() => void (useJianyingDraft ? form.generateNative() : form.generate())}
        >
          开始生成
        </Button>
      </div>
    </footer>
  );
}
