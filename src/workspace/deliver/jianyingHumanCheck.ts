import { setJianyingHumanCheck, type JianyingAvailability } from "../../api";
import { showToast } from "../ui/Toast";

/**
 * R14 §9 A(车道 A):「可以用」/「打不开」的回流。写完 settings 后把后端回的新可用性广播出去,
 * 谁在展示剪映可用性(交付表单 / 镜头带按钮 / 抽屉 chip)谁就听这条事件换状态 —— 不用各自再拉一次。
 */
export const JIANYING_AVAILABILITY_CHANGED_EVENT = "tripcut:jianying-availability-changed";
export const HUMAN_CHECK_OK_TOAST = "记下了:这个剪映版本可以用,以后默认直接生成草稿";
export const HUMAN_CHECK_FAIL_TOAST = "记下了:这个版本打不开草稿;先用「导出片段」,以后可以再试";

export function notifyJianyingAvailabilityChanged(availability: JianyingAvailability): void {
  window.dispatchEvent(new CustomEvent<JianyingAvailability>(JIANYING_AVAILABILITY_CHANGED_EVENT, { detail: availability }));
}

export function onJianyingAvailabilityChanged(listener: (availability: JianyingAvailability) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<JianyingAvailability>).detail;
    if (detail && typeof detail === "object" && "supported" in detail) listener(detail);
  };
  window.addEventListener(JIANYING_AVAILABILITY_CHANGED_EVENT, handler);
  return () => window.removeEventListener(JIANYING_AVAILABILITY_CHANGED_EVENT, handler);
}

/** 写裁定 → toast → 广播;回 true = 记上了。失败只 toast 并回 false(settings 没写上,下次还能再点)。 */
export async function submitJianyingHumanCheck(version: string, verdict: "ok" | "fail"): Promise<boolean> {
  try {
    const availability = await setJianyingHumanCheck(version, verdict);
    showToast(verdict === "ok" ? HUMAN_CHECK_OK_TOAST : HUMAN_CHECK_FAIL_TOAST, { tone: verdict === "ok" ? "success" : "neutral" });
    notifyJianyingAvailabilityChanged(availability);
    return true;
  } catch (error) {
    showToast(`没记上验证结果:${String(error)}`, { tone: "danger" });
    return false;
  }
}
