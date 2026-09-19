import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { WEIGHT_KEYS } from "../api";
import {
  DEFAULT_WEIGHTS,
  SELECT_PRESETS,
  describeParse,
  mergeLlmParse,
  parseChineseNumber,
  parseDurationSecs,
  parseSelectPrompt,
  parseSelectPromptSmart,
  toAutoSelectParams,
} from "./selectPrompt";

/** R19 P-01 判据 ①:10 条中文句子夹具 → 参数解析(含歧义句的默认值)。 */
const FIXTURES: Array<{ sentence: string; budget: number | null; scope: string | null; pick: "chapters" | "score"; bias: string[]; heavier?: [keyof typeof DEFAULT_WEIGHTS, keyof typeof DEFAULT_WEIGHTS] }> = [
  { sentence: "挑 60 秒,风景为主,少人脸,按时间顺序", budget: 60, scope: null, pick: "chapters", bias: ["少人脸(按少人声算)", "风景"], heavier: ["interest", "sound"] },
  { sentence: "挑 2 分钟,全部素材", budget: 120, scope: "all", pick: "chapters", bias: [] },
  { sentence: "30 秒快节奏,多运动", budget: 30, scope: null, pick: "chapters", bias: ["运动"], heavier: ["motion", "sharp"] },
  { sentence: "只要收藏的,一分半", budget: 90, scope: "favorites", pick: "chapters", bias: [] },
  { sentence: "三星以上按分数挑 45 秒", budget: 45, scope: "rated3", pick: "score", bias: [] },
  { sentence: "安静一点,风景,1 分钟", budget: 60, scope: null, pick: "chapters", bias: ["安静", "风景"], heavier: ["interest", "sound"] },
  { sentence: "有人说话的片段,收藏和打星的都要", budget: null, scope: "favorites_or_rated3", pick: "chapters", bias: ["有声"], heavier: ["sound", "exposure"] },
  { sentence: "挑一些精彩的", budget: null, scope: null, pick: "chapters", bias: [] },
  { sentence: "少运动多稳定,60 秒", budget: 60, scope: null, pick: "chapters", bias: ["稳定"], heavier: ["no_cut", "motion"] },
  { sentence: "挑 90 秒按时间顺序,人物为主", budget: 90, scope: null, pick: "chapters", bias: ["人物"], heavier: ["sound", "no_cut"] },
];

describe("R19 P-01 一句话挑片:本地规则解析", () => {
  it("WEIGHT_KEYS 与 moments.rs 的 WEIGHT_KEYS 逐字一致(权重偏置的键只能是后端认识的六个)", () => {
    const source = readFileSync(resolve(process.cwd(), "src-tauri/src/core/moments.rs"), "utf8");
    const match = /pub const WEIGHT_KEYS: \[&str; (\d+)\] = \[([^\]]+)\];/.exec(source);
    expect(match).toBeTruthy();
    const keys = match![2]!.split(",").map((item) => item.trim().replace(/"/g, "")).filter(Boolean);
    expect([...WEIGHT_KEYS]).toEqual(keys);
    expect(Object.keys(DEFAULT_WEIGHTS).sort()).toEqual([...keys].sort());
  });

  it.each(FIXTURES)("「$sentence」→ 时长 $budget · 范围 $scope · 挑法 $pick · 偏好 $bias", ({ sentence, budget, scope, pick, bias, heavier }) => {
    const parsed = parseSelectPrompt(sentence);
    expect(parsed.budgetSecs).toBe(budget);
    expect(parsed.scope).toBe(scope);
    expect(parsed.pick).toBe(pick);
    expect(parsed.bias).toEqual(bias);
    if (bias.length === 0) {
      expect(parsed.weights).toBeNull();
    } else {
      const weights = parsed.weights!;
      // 键只能是 WEIGHT_KEYS、值 0–1、和为 1(后端 MomentWeights::parse 的要求)。
      expect(Object.keys(weights).sort()).toEqual([...WEIGHT_KEYS].sort());
      for (const key of WEIGHT_KEYS) expect(weights[key]).toBeGreaterThanOrEqual(0);
      for (const key of WEIGHT_KEYS) expect(weights[key]).toBeLessThanOrEqual(1);
      expect(Math.abs(WEIGHT_KEYS.reduce((sum, key) => sum + weights[key], 0) - 1)).toBeLessThan(0.01);
      if (heavier) {
        const [up, down] = heavier;
        expect(weights[up] / DEFAULT_WEIGHTS[up]).toBeGreaterThan(weights[down] / DEFAULT_WEIGHTS[down]);
      }
    }
  });

  it("数字:阿拉伯数字与中文数字都认;时长各种写法", () => {
    expect(parseChineseNumber("十五")).toBe(15);
    expect(parseChineseNumber("一百二十")).toBe(120);
    expect(parseChineseNumber("两")).toBe(2);
    expect(parseChineseNumber("60")).toBe(60);
    expect(parseChineseNumber("abc")).toBeNull();
    expect(parseDurationSecs("一分半")).toBe(90);
    expect(parseDurationSecs("半分钟")).toBe(30);
    expect(parseDurationSecs("1 分 30 秒")).toBe(90);
    expect(parseDurationSecs("两分钟")).toBe(120);
    expect(parseDurationSecs("十五秒")).toBe(15);
    expect(parseDurationSecs("随便挑")).toBeNull();
  });

  it("解析结果 → 后端参数:范围没说用兜底、原句原样记录;回显文案是人话", () => {
    const parsed = parseSelectPrompt("挑 60 秒,风景为主,少人脸,按时间顺序");
    const params = toAutoSelectParams(parsed, "挑 60 秒,风景为主,少人脸,按时间顺序", "all");
    expect(params).toMatchObject({ budgetSecs: 60, scope: "all", pick: "chapters", prompt: "挑 60 秒,风景为主,少人脸,按时间顺序" });
    expect(params.weights).not.toBeNull();
    expect(toAutoSelectParams(parseSelectPrompt("只要收藏的"), "只要收藏的", "all").scope).toBe("favorites");
    expect(describeParse(parsed)).toBe("60 秒 · 范围按库 · 少人脸(按少人声算) · 风景 · 按时间顺序");
    expect(describeParse(parseSelectPrompt("挑一些精彩的"))).toBe("时长按平台 · 范围按库 · 按时间顺序");
  });
});

describe("R19 P-01:LLM 增强只补规则没看出的项,不可用不报错", () => {
  it("开关关 / 额度用完 / 抛错 / 答非所问 → 全部静默回落到规则", async () => {
    const off = await parseSelectPromptSmart("挑 60 秒", { status: async () => ({ enabled: false, provider: "none", monthly_budget: 0, calls_this_month: 0, remaining_calls: 0, budget_exhausted: false, providers: [] }) });
    expect(off.source).toBe("rules");
    expect(off.parsed.budgetSecs).toBe(60);
    const on = { enabled: true, provider: "auto" as const, monthly_budget: 200, calls_this_month: 1, remaining_calls: 199, budget_exhausted: false, providers: [] };
    const thrown = await parseSelectPromptSmart("挑 60 秒", { status: async () => on, ask: async () => Promise.reject(new Error("cli missing")) });
    expect(thrown).toEqual({ parsed: parseSelectPrompt("挑 60 秒"), source: "rules" });
    const garbage = await parseSelectPromptSmart("挑 60 秒", { status: async () => on, ask: async () => "我不知道" });
    expect(garbage.source).toBe("rules");
    const exhausted = await parseSelectPromptSmart("挑 60 秒", { status: async () => ({ ...on, budget_exhausted: true }), ask: async () => Promise.reject(new Error("should not be asked")) });
    expect(exhausted.source).toBe("rules");
  });

  it("LLM 给的 JSON 只按白名单合并:规则已命中的项以规则为准,没看出的项才补;不认识的值丢弃", async () => {
    const on = { enabled: true, provider: "auto" as const, monthly_budget: 200, calls_this_month: 1, remaining_calls: 199, budget_exhausted: false, providers: [] };
    const merged = await parseSelectPromptSmart("来点海边的镜头,一分钟", {
      status: async () => on,
      ask: async () => '好的:{"budget_secs": 30, "scope": "favorites", "pick": "score", "bias": ["风景", "外星人"]}',
    });
    expect(merged.source).toBe("llm");
    expect(merged.parsed.budgetSecs).toBe(60);
    expect(merged.parsed.scope).toBe("favorites");
    expect(merged.parsed.pick).toBe("score");
    expect(merged.parsed.bias).toEqual(["风景"]);
    expect(merged.parsed.weights?.interest).toBeGreaterThan(DEFAULT_WEIGHTS.interest);
    expect(mergeLlmParse(parseSelectPrompt("挑 60 秒"), '{"scope": "hero", "pick": "random"}')).toMatchObject({ budgetSecs: 60, scope: null, pick: "chapters" });
    expect(mergeLlmParse(parseSelectPrompt("挑 60 秒"), "{not json")).toBeNull();
  });
});

describe("R19 P-09:三条预设句 = 三组不同参数", () => {
  it("旅行日记 / 电影感 / 快节奏:时长 90 / 60 / 30,挑法 章节 / 章节 / 分数,偏置 有声 / 稳定+风景 / 运动;两两不同", () => {
    expect(SELECT_PRESETS.map((preset) => preset.label)).toEqual(["旅行日记", "电影感", "快节奏"]);
    const [diary, cinematic, fastcut] = SELECT_PRESETS.map((preset) => parseSelectPrompt(preset.sentence));
    expect(diary!.budgetSecs).toBe(90);
    expect(diary!.pick).toBe("chapters");
    expect(diary!.bias).toEqual(["有声"]);
    expect(diary!.weights!.sound).toBeGreaterThan(DEFAULT_WEIGHTS.sound);

    expect(cinematic!.budgetSecs).toBe(60);
    expect(cinematic!.pick).toBe("chapters");
    expect(cinematic!.bias).toEqual(["稳定", "风景"]);
    expect(cinematic!.weights!.motion).toBeLessThan(DEFAULT_WEIGHTS.motion);
    expect(cinematic!.weights!.no_cut).toBeGreaterThan(DEFAULT_WEIGHTS.no_cut);

    expect(fastcut!.budgetSecs).toBe(30);
    expect(fastcut!.pick).toBe("score");
    expect(fastcut!.bias).toEqual(["运动"]);
    expect(fastcut!.weights!.motion).toBeGreaterThan(DEFAULT_WEIGHTS.motion);

    const params = SELECT_PRESETS.map((preset) => JSON.stringify(toAutoSelectParams(parseSelectPrompt(preset.sentence), preset.sentence, "all")));
    expect(new Set(params).size).toBe(3);
    // 零术语:预设句与标签里不出现首页首轮词表。
    for (const preset of SELECT_PRESETS) expect(`${preset.label}${preset.sentence}`).not.toMatch(/镜头带|章节|精选段|交付|模板|旅程/);
  });
});
