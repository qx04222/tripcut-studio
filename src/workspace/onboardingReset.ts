import { setFirstRunDone, setSetting } from "../api";
import { resetGuides } from "./guides";
import { hintSeenKey } from "./pipelineHints";
import { STEPS_SEEN_KEY } from "./onboarding";

/** 「重置新手引导」要一起清掉的布尔键(Rust ONBOARDING_FLAG_KEYS 白名单里的那几个)。 */
export const ONBOARDING_RESET_KEYS = [STEPS_SEEN_KEY, hintSeenKey(1), hintSeenKey(2), hintSeenKey(3), hintSeenKey(4)] as const;

/**
 * R16 P2-11:「重置新手引导」名副其实 —— 功能气泡(guide.*.viewed)、首页三步卡(onboarding.steps_seen)、
 * 四步提示(pipeline.hint_seen.*)、首启向导(onboarding.first_run_done)一起写回 false。
 * 任何一条写失败都抛出去(设置页 toast 说清),不吞。
 */
export async function resetOnboarding(): Promise<void> {
  await resetGuides();
  for (const key of ONBOARDING_RESET_KEYS) await setSetting(key, "false");
  await setFirstRunDone(false);
}
