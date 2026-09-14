import { useCallback, useEffect, useState } from "react";

import { getSettings, setSetting } from "../api";
import { readUiBool } from "./uiSettings";

/**
 * R11 简化专项 #1 → R12 §1:首启四步引导(「① 导入 → ② 挑选 → ③ 排列 → ④ 导出」),与顶栏
 * 流水线导航同一套数据(usePipeline)。新用户打开软件第一眼看到的是这张轻卡片,不再是
 * 工具链弹窗;工具链检查只在 ffmpeg / ffprobe 缺失时以顶栏下的横幅出现(ToolchainBanner)。
 */
export const STEPS_SEEN_KEY = "onboarding.steps_seen";

export interface OnboardingStep {
  id: "import" | "pick" | "arrange" | "export";
  title: string;
  body: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { id: "import", title: "导入", body: "选一个装着视频的文件夹,原片不会被改动。" },
  { id: "pick", title: "挑选", body: "让软件自动挑选,或看到喜欢的按 F 收藏。" },
  { id: "arrange", title: "排列", body: "把挑好的片段按章节排进镜头带,顺序可以拖。" },
  { id: "export", title: "导出", body: "把片段导出到一个文件夹,或整包交付。" },
];

export interface OnboardingInput {
  clipCount: number;
  loading: boolean;
  /** null = 设置还没读回来(不显示,免得闪一下再消失)。 */
  seen: boolean | null;
  dismissed: boolean;
}

/** 卡片只在「库是空的、没看过、没关掉」时出现。 */
export function onboardingVisible(input: OnboardingInput): boolean {
  return !input.loading && input.clipCount === 0 && input.seen === false && !input.dismissed;
}

/** 库里一有素材就把 seen 记成 true —— 下次启动不再出现,哪怕库又被清空。 */
export function shouldMarkStepsSeen(input: Omit<OnboardingInput, "dismissed">): boolean {
  return !input.loading && input.clipCount > 0 && input.seen === false;
}

/** 「自动挑选」的去向:镜头带的自动挑选面板(BandAutoSelect 听这个事件)。 */
export const OPEN_AUTO_SELECT_EVENT = "tripcut:open-auto-select";

export function useOnboarding(clipCount: number, loading: boolean): { visible: boolean; dismiss(): void } {
  const [seen, setSeen] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    getSettings()
      .then((settings) => {
        if (active) setSeen(readUiBool(settings ?? {}, STEPS_SEEN_KEY));
      })
      .catch(() => {
        if (active) setSeen(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!shouldMarkStepsSeen({ clipCount, loading, seen })) return;
    setSeen(true);
    void setSetting(STEPS_SEEN_KEY, "true").catch(() => undefined);
  }, [clipCount, loading, seen]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    void setSetting(STEPS_SEEN_KEY, "true").catch(() => undefined);
  }, []);

  return { visible: onboardingVisible({ clipCount, loading, seen, dismissed }), dismiss };
}
