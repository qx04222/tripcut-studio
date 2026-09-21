import { askDirector, getLlmStatus, WEIGHT_KEYS, type AutoSelectParamsInput, type AutoSelectPick, type AutoSelectScope, type LlmStatus, type MomentWeights, type WeightKey } from "../api";

/**
 * R19 P-01「一句话挑片」:把「挑 60 秒,风景为主,少人脸,按时间顺序」这种中文句子解析成
 * `auto_select_episode_with` 的参数 —— 时长 / 范围 / 权重偏置 / 挑法。**本地规则是主路径**
 * (业主每天用,离线要能用);LLM(`llm.rs` 的三家 CLI 路由)可用时只做增强,拿不到就静默回落。
 *
 * 权重偏置的键就是 `moments.rs` 的 `WEIGHT_KEYS`(六项);「人脸」没有信号,用「人声」当代理并在
 * `bias` 里如实写「少人脸(按少人声算)」。
 */

export const SELECT_PROMPT_PLACEHOLDER = "例如:挑 60 秒,风景为主,少人脸,按时间顺序";
export const PHOTO_SELECT_PROMPT_PLACEHOLDER = "例如：挑 20 张，优先清晰、构图完整，按拍摄时间排序";
/** HomeCards / 预设卡 → BandAutoSelect 的事件:detail `{ sentence }`。 */
export const SELECT_PROMPT_EVENT = "tripcut:select-prompt";

/**
 * R19 P-09:首页 / 自动挑选面板的三条预设句(原「模板卡」做实)。每条就是一句 P-01,
 * 目标时长 / 挑法 / 权重偏置各不相同(`selectPrompt.test` 钉住三者解析出的参数两两不同)。
 * 文案是动作句,不出现「模板」一词(首页首轮词表)。
 */
export interface SelectPreset {
  id: "diary" | "cinematic" | "fastcut";
  label: string;
  sentence: string;
}

export const SELECT_PRESETS: readonly SelectPreset[] = [
  { id: "diary", label: "旅行日记", sentence: "挑 90 秒,按时间顺序,有人说话的留着" },
  { id: "cinematic", label: "电影感", sentence: "挑 60 秒,少运动多稳定,风景为主" },
  { id: "fastcut", label: "快节奏", sentence: "挑 30 秒,多运动,按分数" },
];

export interface SelectPromptParse {
  mediaKind: "photo" | "video" | null;
  photoCount: number | null;
  /** 「N 秒 / N 分钟 / 一分半」;没说就是 null(按平台预算)。 */
  budgetSecs: number | null;
  /** 「全部 / 收藏 / 三星以上」;没说就是 null(按库状态推导)。 */
  scope: AutoSelectScope | null;
  /** 权重偏置;句子里没有偏好词就是 null(库里的原分)。 */
  weights: MomentWeights | null;
  pick: AutoSelectPick;
  /** 命中的偏好词(给面板回显「按 风景 · 少人脸 挑」)。 */
  bias: string[];
}

/** 打分缺省权重(与 `MomentWeights::default()` 逐位相同;偏置在它上面乘)。 */
export const DEFAULT_WEIGHTS: MomentWeights = { sharp: 0.24, motion: 0.2, exposure: 0.16, sound: 0.12, no_cut: 0.08, interest: 0.2 };

interface BiasRule {
  pattern: RegExp;
  label: string;
  multipliers: Partial<Record<WeightKey, number>>;
}

/**
 * 偏好词 → 权重乘数。**否定式排在前面**(「少运动」要先于「运动」吃掉那段文字),命中后把原文抹掉再匹配下一条。
 * 「少人脸」没有人脸信号:人声当人像的代理,声音权重减半、画面少见加一点。
 */
export const BIAS_RULES: readonly BiasRule[] = [
  { pattern: /少人脸|不要人脸|没人脸|少人|不要人物|少一点人/, label: "少人脸(按少人声算)", multipliers: { sound: 0.5, interest: 1.25 } },
  { pattern: /少运动|不要运动|少动|稳定|稳一点|慢一点|慢节奏|电影感/, label: "稳定", multipliers: { motion: 0.5, no_cut: 2 } },
  { pattern: /安静|静一点|没声音|不要声音|无声/, label: "安静", multipliers: { sound: 0.25 } },
  { pattern: /有人声|有声|说话|对白|口播|人声/, label: "有声", multipliers: { sound: 2 } },
  { pattern: /风景|景色|景为主|风光|空镜/, label: "风景", multipliers: { motion: 0.5, sound: 0.5, interest: 1.5, exposure: 1.25 } },
  { pattern: /人物|人像|人为主|多一点人/, label: "人物", multipliers: { sound: 2 } },
  { pattern: /运动|动感|动作|快节奏|多动|动起来/, label: "运动", multipliers: { motion: 2 } },
];

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「一百二十」「十五」「3」「60」→ 数;认不出回 null。 */
export function parseChineseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (!/^[零一二两三四五六七八九十百]+$/.test(trimmed)) return null;
  let total = 0;
  let current = 0;
  for (const char of trimmed) {
    if (char === "百") {
      total += (current === 0 ? 1 : current) * 100;
      current = 0;
    } else if (char === "十") {
      total += (current === 0 ? 1 : current) * 10;
      current = 0;
    } else {
      current = CN_DIGITS[char] ?? 0;
    }
  }
  return total + current;
}

const NUMBER = "(\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百]+)";

/** 「60 秒」「2 分钟」「一分半」「半分钟」「1 分 30 秒」→ 秒;没说时长回 null。 */
export function parseDurationSecs(text: string): number | null {
  const minSec = new RegExp(`${NUMBER}\\s*分(?:钟)?\\s*${NUMBER}\\s*秒`).exec(text);
  if (minSec) {
    const minutes = parseChineseNumber(minSec[1]!);
    const seconds = parseChineseNumber(minSec[2]!);
    if (minutes !== null && seconds !== null) return minutes * 60 + seconds;
  }
  const minHalf = new RegExp(`${NUMBER}\\s*分半`).exec(text);
  if (minHalf) {
    const minutes = parseChineseNumber(minHalf[1]!);
    if (minutes !== null) return minutes * 60 + 30;
  }
  if (/半分钟/.test(text)) return 30;
  const minutes = new RegExp(`${NUMBER}\\s*分(?:钟)?(?![\\d零一二两三四五六七八九十百]*秒)`).exec(text);
  if (minutes) {
    const value = parseChineseNumber(minutes[1]!);
    if (value !== null && value > 0) return Math.round(value * 60);
  }
  const seconds = new RegExp(`${NUMBER}\\s*(?:秒|s\\b|S\\b)`).exec(text);
  if (seconds) {
    const value = parseChineseNumber(seconds[1]!);
    if (value !== null && value > 0) return Math.round(value);
  }
  return null;
}

/** 范围词:全部 > 收藏 + 星 > 只收藏 > 只星级;没说回 null。 */
export function parseScope(text: string): AutoSelectScope | null {
  if (/全部|所有|不限范围/.test(text)) return "all";
  const favorites = /收藏/.test(text);
  const stars = /星/.test(text);
  if (favorites && stars) return "favorites_or_rated3";
  if (favorites) return "favorites";
  if (stars) return "rated3";
  return null;
}

/** 挑法:「按分数 / 最好的 / 高分」→ score;其余(含「按时间顺序」)→ chapters。 */
export function parsePick(text: string): AutoSelectPick {
  return /按分数|分数高|分最高|最好的|高分|只要最|不管顺序/.test(text) ? "score" : "chapters";
}

/** 乘数 → 归一到和为 1 的六项权重(值 0–1、三位小数)。 */
export function applyBias(multipliers: readonly Partial<Record<WeightKey, number>>[]): MomentWeights {
  const raw: Record<WeightKey, number> = { ...DEFAULT_WEIGHTS };
  for (const set of multipliers) {
    for (const key of WEIGHT_KEYS) {
      const factor = set[key];
      if (typeof factor === "number") raw[key] *= factor;
    }
  }
  const total = WEIGHT_KEYS.reduce((sum, key) => sum + raw[key], 0);
  const out = {} as MomentWeights;
  for (const key of WEIGHT_KEYS) out[key] = Math.min(1, Math.round((raw[key] / total) * 1000) / 1000);
  return out;
}

/** 偏好词 → 权重偏置 + 命中的标签;没有偏好词 → weights null。 */
export function parseBias(text: string): { weights: MomentWeights | null; bias: string[] } {
  let rest = text;
  const hits: BiasRule[] = [];
  for (const rule of BIAS_RULES) {
    if (rule.pattern.test(rest)) {
      hits.push(rule);
      rest = rest.replace(new RegExp(rule.pattern.source, "g"), " ");
    }
  }
  if (hits.length === 0) return { weights: null, bias: [] };
  return { weights: applyBias(hits.map((rule) => rule.multipliers)), bias: hits.map((rule) => rule.label) };
}

/** 纯本地规则解析;歧义句一律落缺省(时长 null / 范围 null / 原分 / 按时间顺序)。 */
export function parseSelectPrompt(text: string): SelectPromptParse {
  const normalized = text.replace(/[,，。;;、]/g, " ").trim();
  const { weights, bias } = parseBias(normalized);
  const photo = new RegExp(`${NUMBER}\\s*张\\s*照片|照片\\s*${NUMBER}\\s*张`).exec(normalized);
  const count = photo ? parseChineseNumber(photo[1] ?? photo[2] ?? "") : null;
  const photoCount = count !== null && Number.isInteger(count) && count > 0 ? count : null;
  const mediaKind = /只要视频/.test(normalized) ? "video" : /只要照片/.test(normalized) || photoCount !== null ? "photo" : null;
  return { mediaKind, photoCount, budgetSecs: parseDurationSecs(normalized), scope: parseScope(normalized), weights, pick: parsePick(normalized), bias };
}

/** 解析结果 → 后端参数(范围没说时用调用方给的兜底,通常是按库状态推导的那个)。 */
export function toAutoSelectParams(parsed: SelectPromptParse, sentence: string, fallbackScope: AutoSelectScope): AutoSelectParamsInput & Pick<SelectPromptParse, "mediaKind" | "photoCount"> {
  return {
    mediaKind: parsed.mediaKind,
    photoCount: parsed.photoCount,
    budgetSecs: parsed.budgetSecs ?? undefined,
    scope: parsed.scope ?? fallbackScope,
    weights: parsed.weights,
    pick: parsed.pick,
    prompt: sentence.trim(),
  };
}

/** 面板回显:「60 秒 · 全部素材 · 风景 · 少人脸(按少人声算)· 按时间顺序」。 */
export function describeParse(parsed: SelectPromptParse): string {
  const parts: string[] = [];
  if (parsed.mediaKind) parts.push(parsed.mediaKind === "photo" ? "只要照片" : "只要视频");
  if (parsed.photoCount !== null) parts.push(`${parsed.photoCount} 张`);
  parts.push(parsed.budgetSecs === null ? "时长按平台" : `${parsed.budgetSecs} 秒`);
  parts.push(parsed.scope === "all" ? "全部素材" : parsed.scope === "favorites" ? "只看收藏" : parsed.scope === "rated3" ? "3 星以上" : parsed.scope === "favorites_or_rated3" ? "收藏 + 3 星以上" : "范围按库");
  parts.push(...parsed.bias);
  parts.push(parsed.pick === "score" ? "按分数" : "按时间顺序");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// LLM 增强:可用时让它把句子改写成结构化 JSON(只许用我们认识的词),拿不到 / 解析不出就用规则。
// ---------------------------------------------------------------------------

interface LlmParse {
  budget_secs?: unknown;
  scope?: unknown;
  pick?: unknown;
  bias?: unknown;
}

const SCOPES: readonly AutoSelectScope[] = ["favorites_or_rated3", "favorites", "rated3", "all"];

/** 从回答里抠出第一个 JSON 对象并按白名单校验;任何一步不对就回 null。 */
export function mergeLlmParse(rules: SelectPromptParse, answer: string): SelectPromptParse | null {
  const match = /\{[\s\S]*\}/.exec(answer);
  if (!match) return null;
  let parsed: LlmParse;
  try {
    parsed = JSON.parse(match[0]) as LlmParse;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const budget = typeof parsed.budget_secs === "number" && Number.isFinite(parsed.budget_secs) && parsed.budget_secs > 0 ? Math.round(parsed.budget_secs) : null;
  const scope = typeof parsed.scope === "string" && (SCOPES as readonly string[]).includes(parsed.scope) ? (parsed.scope as AutoSelectScope) : null;
  const pick: AutoSelectPick | null = parsed.pick === "score" || parsed.pick === "chapters" ? parsed.pick : null;
  const labels = Array.isArray(parsed.bias) ? parsed.bias.filter((item): item is string => typeof item === "string") : [];
  const hits = BIAS_RULES.filter((rule) => labels.some((label) => rule.label.startsWith(label) || rule.pattern.test(label)));
  // 规则命中的优先;LLM 只补规则没看出来的那几项。
  return {
    mediaKind: rules.mediaKind,
    photoCount: rules.photoCount,
    budgetSecs: rules.budgetSecs ?? budget,
    scope: rules.scope ?? scope,
    weights: rules.weights ?? (hits.length > 0 ? applyBias(hits.map((rule) => rule.multipliers)) : null),
    pick: rules.pick === "score" ? "score" : (pick ?? rules.pick),
    bias: rules.bias.length > 0 ? rules.bias : hits.map((rule) => rule.label),
  };
}

export function llmPromptFor(sentence: string): string {
  return [
    "把下面这句挑片要求改写成一个 JSON 对象放在 answer 里,不要别的字:",
    '{"budget_secs": 数字或 null, "scope": "all"|"favorites"|"rated3"|"favorites_or_rated3"|null, "pick": "chapters"|"score", "bias": [从「风景 人物 运动 安静 有声 少人脸 稳定」里挑的词]}',
    `要求:${sentence.trim()}`,
  ].join("\n");
}

/**
 * LLM 可用(开关开、额度没用完)就问一次并与规则合并;不可用 / 出错 / 答非所问都**静默**回落到规则。
 * `deps` 给测试替身用。
 */
export async function parseSelectPromptSmart(
  sentence: string,
  deps: { status?: () => Promise<LlmStatus>; ask?: (question: string) => Promise<string> } = {},
): Promise<{ parsed: SelectPromptParse; source: "rules" | "llm" }> {
  const rules = parseSelectPrompt(sentence);
  try {
    const status = await (deps.status ?? getLlmStatus)();
    if (!status.enabled || status.budget_exhausted) return { parsed: rules, source: "rules" };
    const ask =
      deps.ask ??
      (async (question: string) =>
        (await askDirector(question, { current_filter: "", total_clips: 0, visible_clips: 0, favorites: 0, rejected: 0, unrated: 0, selected_summary: [] })).answer);
    const merged = mergeLlmParse(rules, await ask(llmPromptFor(sentence)));
    return merged ? { parsed: merged, source: "llm" } : { parsed: rules, source: "rules" };
  } catch {
    return { parsed: rules, source: "rules" };
  }
}
