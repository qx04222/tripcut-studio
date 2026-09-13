import { useCallback, useEffect, useState } from "react";

import { getSettings, setSetting } from "../api";
import { readUiBool } from "./uiSettings";

/**
 * R11 简化专项 #1:首启三步引导(「1 导入素材 → 2 挑选片段 → 3 导出」)。
 * 新用户打开软件第一眼看到的是这张轻卡片,不再是工具链弹窗;工具链检查搬到
 * 设置 → 工具与模型,只有 ffmpeg / ffprobe 这种**必需**组件缺失才自动弹。
 */
export const STEPS_SEEN_KEY = "onboarding.steps_seen";

export interface OnboardingStep {
  id: "import" | "pick" | "export";
  title: string;
  body: string;
  /** 步骤按钮的可见文案 = AX 名(都是新名,不与顶栏冻结名「导入素材」「生成交付包」相撞)。 */
  action: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { id: "import", title: "导入素材", body: "选一个装着视频的文件夹,原片不会被改动。", action: "选择素材文件夹" },
  { id: "pick", title: "挑选片段", body: "让软件自动挑选,或看到喜欢的按 F 收藏。", action: "自动挑选" },
  { id: "export", title: "导出", body: "把挑好的片段导出到一个文件夹。", action: "导出片段" },
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

/** 三个步骤按钮的去向:导入抽屉 / 镜头带的自动挑选面板 / 交付抽屉。挑选与导出在库空时不可点。 */
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
