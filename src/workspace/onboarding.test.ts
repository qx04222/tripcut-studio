import { describe, expect, it } from "vitest";

import { ONBOARDING_STEPS, STEPS_SEEN_KEY, onboardingVisible, shouldMarkStepsSeen } from "./onboarding";
import { UI_SETTING_DEFAULTS } from "./uiSettings";

/** R11 简化专项 #1:首启三步引导只在「素材库为空、没看过、没关掉」时出现;库里一有素材就记 seen。 */
describe("onboarding 四步引导", () => {
  it("键 onboarding.steps_seen 有前端默认值 false", () => {
    expect(STEPS_SEEN_KEY).toBe("onboarding.steps_seen");
    expect(UI_SETTING_DEFAULTS[STEPS_SEEN_KEY]).toBe("false");
  });

  it("R12:四步固定,与流水线导航同名:导入 → 挑选 → 排列 → 导出", () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual(["import", "pick", "arrange", "export"]);
    expect(ONBOARDING_STEPS.map((step) => step.title)).toEqual(["导入", "挑选", "排列", "导出"]);
  });

  it("只在库空、设置已读且没看过、没关掉时可见", () => {
    const base = { clipCount: 0, loading: false, seen: false as boolean | null, dismissed: false };
    expect(onboardingVisible(base)).toBe(true);
    expect(onboardingVisible({ ...base, clipCount: 3 })).toBe(false);
    expect(onboardingVisible({ ...base, loading: true })).toBe(false);
    expect(onboardingVisible({ ...base, seen: true })).toBe(false);
    expect(onboardingVisible({ ...base, seen: null })).toBe(false);
    expect(onboardingVisible({ ...base, dismissed: true })).toBe(false);
  });

  it("库里出现素材且还没记过 seen 时才写一次;加载中、已 seen、库空都不写", () => {
    expect(shouldMarkStepsSeen({ clipCount: 1, loading: false, seen: false })).toBe(true);
    expect(shouldMarkStepsSeen({ clipCount: 1, loading: true, seen: false })).toBe(false);
    expect(shouldMarkStepsSeen({ clipCount: 1, loading: false, seen: true })).toBe(false);
    expect(shouldMarkStepsSeen({ clipCount: 1, loading: false, seen: null })).toBe(false);
    expect(shouldMarkStepsSeen({ clipCount: 0, loading: false, seen: false })).toBe(false);
  });
});
