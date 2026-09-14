/**
 * R13 §1:键位表。动作 → 键的纯数据 + 纯函数,没有 React、没有 DOM 监听。
 * 三套预设(剪映(默认)/ Premiere Pro / Final Cut Pro)只借剪映配置文件的**结构**
 * (动作名 → 键串数组,一个动作可有多把键)与常用键,不复制它的内容。
 *
 * 键串(chord)格式:`[Mod+][Alt+][Shift+]<key>`,`Mod` = macOS ⌘(也认 Ctrl);
 * key 是小写字母 / 数字 / `space` `enter` `tab` `escape` `arrowleft`… / 标点原字。
 * 字母与数字按**物理键**(`event.code`)取,中文输入法把 `key` 吃成 `Process` 也不影响
 * (沿用 `useRatingHotkeys.physicalKey` 的道理)。
 */

export type KeymapScope = "global" | "monitor" | "pool";

export type KeymapAction =
  | "play-pause" | "mark-in" | "mark-out" | "prev-clip" | "next-clip"
  | "frame-back" | "frame-forward" | "jump-back-5s" | "jump-forward-5s" | "nudge-back-1s" | "nudge-forward-1s"
  | "shuttle-back" | "shuttle-pause" | "shuttle-forward" | "toggle-loop" | "save-range"
  | "favorite" | "reject" | "star-1" | "star-2" | "star-3" | "star-4" | "star-5" | "clear-rating"
  | "adopt-suggestion" | "next-suggestion" | "prev-suggestion"
  | "expand-stack" | "prev-take" | "next-take" | "promote-hero" | "lock-stack" | "reject-stack"
  | "undo" | "redo" | "split-before" | "split-after"
  | "fullscreen" | "export" | "import" | "switch-episode" | "command-palette" | "settings" | "help"
  | "cycle-pane" | "cycle-pane-back" | "toggle-pool" | "toggle-inspector" | "escape";

export type KeymapGroup = "播放" | "打点与片段" | "评级" | "建议与候选" | "编辑" | "工作区";

export interface KeymapActionMeta {
  id: KeymapAction;
  label: string;
  group: KeymapGroup;
  /** 这把键在哪些栏里生效;`global` 挂在 window 上,与所有栏都可能撞键。 */
  scopes: readonly KeymapScope[];
  /** 光标在输入框里也响(⌘, 开设置、Esc、F6);其余裸键在输入框里一律让位。 */
  inTextField?: true;
  /** 只登记键、暂不执行:表里灰显并带一句说明。 */
  pending?: string;
}

const A = (id: KeymapAction, label: string, group: KeymapGroup, scopes: readonly KeymapScope[], extra: Partial<KeymapActionMeta> = {}): KeymapActionMeta =>
  ({ id, label, group, scopes, ...extra });

export const KEYMAP_ACTIONS: readonly KeymapActionMeta[] = [
  A("play-pause", "播放 / 暂停", "播放", ["monitor", "pool"]),
  A("shuttle-back", "倒退播放(J)", "播放", ["monitor"]),
  // K 在媒体池 / 镜头带上也是停 / 播(V-05:焦点在卡片上不必先 F6 到监视器)。
  A("shuttle-pause", "暂停并回到常速(K)", "播放", ["monitor", "pool"]),
  A("shuttle-forward", "常速播放(L)", "播放", ["monitor"]),
  A("frame-back", "上一帧", "播放", ["monitor"]),
  A("frame-forward", "下一帧", "播放", ["monitor"]),
  A("nudge-back-1s", "后退 1 秒", "播放", ["monitor"]),
  A("nudge-forward-1s", "前进 1 秒", "播放", ["monitor"]),
  A("jump-back-5s", "后退 5 秒", "播放", ["monitor"]),
  A("jump-forward-5s", "前进 5 秒", "播放", ["monitor"]),
  A("toggle-loop", "入出点之间循环", "播放", ["monitor"]),
  A("fullscreen", "全屏预览", "播放", ["global"], { inTextField: true }),
  A("mark-in", "设入点", "打点与片段", ["monitor"]),
  A("mark-out", "设出点", "打点与片段", ["monitor"]),
  A("save-range", "保存片段", "打点与片段", ["monitor"]),
  A("split-before", "分割(向前)", "打点与片段", ["monitor"], { pending: "到剪映里做:旅剪只挑不剪" }),
  A("split-after", "分割(向后)", "打点与片段", ["monitor"], { pending: "到剪映里做:旅剪只挑不剪" }),
  A("favorite", "收藏", "评级", ["pool"]),
  A("reject", "拒绝", "评级", ["pool"]),
  A("star-1", "打 1 星", "评级", ["pool"]),
  A("star-2", "打 2 星", "评级", ["pool"]),
  A("star-3", "打 3 星", "评级", ["pool"]),
  A("star-4", "打 4 星", "评级", ["pool"]),
  A("star-5", "打 5 星", "评级", ["pool"]),
  A("clear-rating", "清除评级", "评级", ["pool"]),
  A("prev-clip", "上一条", "评级", ["pool"]),
  A("next-clip", "下一条", "评级", ["pool"]),
  A("adopt-suggestion", "采用建议段", "建议与候选", ["monitor"]),
  A("next-suggestion", "下一个建议", "建议与候选", ["monitor"]),
  A("prev-suggestion", "上一个建议", "建议与候选", ["monitor"]),
  A("expand-stack", "展开 / 收起同镜头候选", "建议与候选", ["pool"]),
  A("prev-take", "上一个候选", "建议与候选", ["pool"]),
  A("next-take", "下一个候选", "建议与候选", ["pool"]),
  A("promote-hero", "定为首选", "建议与候选", ["pool"]),
  A("lock-stack", "锁定候选", "建议与候选", ["pool"]),
  A("reject-stack", "排除候选", "建议与候选", ["pool"]),
  A("undo", "撤销", "编辑", ["global"], { inTextField: true, pending: "拖排与忽略缺口的撤销在提示条上;全局撤销以后再来" }),
  A("redo", "重做", "编辑", ["global"], { inTextField: true, pending: "同上" }),
  A("export", "导出", "编辑", ["global"], { inTextField: true }),
  A("import", "导入素材", "编辑", ["global"]),
  A("switch-episode", "切换集", "工作区", ["global"], { inTextField: true }),
  A("command-palette", "命令面板", "工作区", ["global"], { inTextField: true }),
  A("settings", "打开设置", "工作区", ["global"], { inTextField: true }),
  A("help", "帮助", "工作区", ["global"]),
  A("cycle-pane", "轮转栏焦点", "工作区", ["global"], { inTextField: true }),
  A("cycle-pane-back", "反向轮转栏焦点", "工作区", ["global"], { inTextField: true }),
  A("toggle-pool", "折叠 / 展开媒体池", "工作区", ["global"], { inTextField: true }),
  A("toggle-inspector", "折叠 / 展开检查器", "工作区", ["global"], { inTextField: true }),
  A("escape", "退出当前层", "工作区", ["global"], { inTextField: true }),
];

export const KEYMAP_ACTION_BY_ID: ReadonlyMap<KeymapAction, KeymapActionMeta> = new Map(KEYMAP_ACTIONS.map((meta) => [meta.id, meta]));

export type KeymapPresetId = "jianying" | "premiere" | "fcp" | "custom";
export type KeymapTable = Readonly<Record<KeymapAction, readonly string[]>>;

/** 剪映键位(默认,规格 §1):空格、I/O、← → 逐帧、⇧← → ±5 s、J/K/L、⌘Z/⇧⌘Z、⌘E、F/X、1–5、Enter、N/⇧N、Q/W 留给分割。 */
const JIANYING: KeymapTable = {
  "play-pause": ["space"],
  "shuttle-back": ["j"],
  "shuttle-pause": ["k"],
  "shuttle-forward": ["l"],
  "frame-back": ["arrowleft", ","],
  "frame-forward": ["arrowright", "."],
  "nudge-back-1s": ["Alt+arrowleft"],
  "nudge-forward-1s": ["Alt+arrowright"],
  "jump-back-5s": ["Shift+arrowleft"],
  "jump-forward-5s": ["Shift+arrowright"],
  "toggle-loop": ["Shift+l"],
  fullscreen: ["Mod+enter"],
  "mark-in": ["i"],
  "mark-out": ["o"],
  "save-range": ["s"],
  "split-before": ["q"],
  "split-after": ["w"],
  favorite: ["f"],
  reject: ["x"],
  "star-1": ["1"],
  "star-2": ["2"],
  "star-3": ["3"],
  "star-4": ["4"],
  "star-5": ["5"],
  "clear-rating": ["0"],
  "prev-clip": ["arrowleft"],
  "next-clip": ["arrowright"],
  "adopt-suggestion": ["enter"],
  "next-suggestion": ["n"],
  "prev-suggestion": ["Shift+n"],
  "expand-stack": ["tab"],
  "prev-take": ["arrowup"],
  "next-take": ["arrowdown"],
  "promote-hero": ["enter"],
  "lock-stack": ["l"],
  "reject-stack": ["r"],
  undo: ["Mod+z"],
  redo: ["Mod+Shift+z"],
  export: ["Mod+e"],
  import: ["Mod+i"],
  "switch-episode": ["Mod+Shift+e"],
  "command-palette": ["Mod+k"],
  settings: ["Mod+,"],
  help: ["?"],
  "cycle-pane": ["f6"],
  "cycle-pane-back": ["Shift+f6"],
  "toggle-pool": ["Mod+1"],
  "toggle-inspector": ["Mod+2"],
  escape: ["escape"],
};

/** Premiere Pro:导出 ⌘M、全屏 `(反引号);其余与剪映一致(剪映自己的 Pr 预设也是这样借的)。 */
const PREMIERE: KeymapTable = { ...JIANYING, export: ["Mod+m"], fullscreen: ["`"] };

/** Final Cut Pro:导出 ⌘E、全屏 ⇧⌘F、F 收藏(FCP 原生就是 F);其余与剪映一致。 */
const FCP: KeymapTable = { ...JIANYING, export: ["Mod+e"], fullscreen: ["Mod+Shift+f"] };

export const KEYMAP_PRESETS: readonly { id: Exclude<KeymapPresetId, "custom">; label: string; table: KeymapTable }[] = [
  { id: "jianying", label: "剪映(默认)", table: JIANYING },
  { id: "premiere", label: "Premiere Pro", table: PREMIERE },
  { id: "fcp", label: "Final Cut Pro", table: FCP },
];

export const DEFAULT_KEYMAP_PRESET: KeymapPresetId = "jianying";
export const KEYMAP_PRESET_KEY = "keymap.preset";
export const KEYMAP_CUSTOM_KEY = "keymap.custom";

/** `keymap.custom` 的 JSON:以哪套预设为底,哪些动作被改过。 */
export interface KeymapCustom {
  base: Exclude<KeymapPresetId, "custom">;
  overrides: Partial<Record<KeymapAction, readonly string[]>>;
}

export function isPresetId(value: string): value is KeymapPresetId {
  return value === "jianying" || value === "premiere" || value === "fcp" || value === "custom";
}

/** 容错解析:不是合法 JSON / 结构不对 / 未知动作,一律丢掉那一部分,绝不让键位表崩。 */
export function parseKeymapCustom(raw: string | undefined): KeymapCustom {
  const fallback: KeymapCustom = { base: "jianying", overrides: {} };
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const record = parsed as { base?: unknown; overrides?: unknown };
    const base = typeof record.base === "string" && isPresetId(record.base) && record.base !== "custom" ? record.base : "jianying";
    const overrides: KeymapCustom["overrides"] = {};
    if (record.overrides && typeof record.overrides === "object") {
      for (const [action, keys] of Object.entries(record.overrides as Record<string, unknown>)) {
        if (!KEYMAP_ACTION_BY_ID.has(action as KeymapAction) || !Array.isArray(keys)) continue;
        const clean = keys.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 40);
        overrides[action as KeymapAction] = clean;
      }
    }
    return { base, overrides };
  } catch {
    return fallback;
  }
}

export function presetTable(preset: Exclude<KeymapPresetId, "custom">): KeymapTable {
  return KEYMAP_PRESETS.find((candidate) => candidate.id === preset)?.table ?? JIANYING;
}

/** 预设 + 自定义覆盖 → 完整的动作 → 键表。非 custom 预设不看覆盖。 */
export function resolveKeymap(preset: string | undefined, custom: string | KeymapCustom | undefined): KeymapTable {
  const id: KeymapPresetId = preset && isPresetId(preset) ? preset : DEFAULT_KEYMAP_PRESET;
  if (id !== "custom") return presetTable(id);
  const parsed = typeof custom === "string" || custom === undefined ? parseKeymapCustom(custom) : custom;
  return { ...presetTable(parsed.base), ...parsed.overrides };
}

export interface KeymapConflict {
  chord: string;
  actions: readonly KeymapAction[];
}

function scopesOverlap(a: readonly KeymapScope[], b: readonly KeymapScope[]): boolean {
  if (a.includes("global") || b.includes("global")) return true;
  return a.some((scope) => b.includes(scope));
}

/** 同一把键落在会同时生效的两个动作上就是冲突;监视器的 L 与媒体池的 L 不算(不同栏)。 */
export function findConflicts(table: KeymapTable): KeymapConflict[] {
  const byChord = new Map<string, KeymapAction[]>();
  for (const meta of KEYMAP_ACTIONS) {
    for (const chord of table[meta.id] ?? []) {
      const list = byChord.get(chord) ?? [];
      list.push(meta.id);
      byChord.set(chord, list);
    }
  }
  const conflicts: KeymapConflict[] = [];
  for (const [chord, actions] of byChord) {
    const clashing = actions.filter((action, index) =>
      actions.some((other, otherIndex) => otherIndex !== index && scopesOverlap(KEYMAP_ACTION_BY_ID.get(action)!.scopes, KEYMAP_ACTION_BY_ID.get(other)!.scopes)),
    );
    if (clashing.length > 1) conflicts.push({ chord, actions: clashing });
  }
  return conflicts;
}

/** 某个动作当前撞了谁(设置表每行的冲突提示)。 */
export function conflictsFor(table: KeymapTable, action: KeymapAction): KeymapAction[] {
  const others = new Set<KeymapAction>();
  for (const conflict of findConflicts(table)) {
    if (!conflict.actions.includes(action)) continue;
    for (const other of conflict.actions) if (other !== action) others.add(other);
  }
  return [...others];
}

export type ChordEvent = Pick<KeyboardEvent, "key" | "code"> & Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">>;

const MODIFIER_KEYS = new Set(["meta", "control", "shift", "alt", "os"]);

function eventKeyName(event: ChordEvent): string | null {
  const code = event.code ?? "";
  if (code.startsWith("Key") && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  const key = event.key;
  if (!key) return null;
  if (key === " " || key === "Spacebar") return "space";
  if (key.length === 1) return /[a-z0-9]/i.test(key) ? key.toLowerCase() : key;
  const lower = key.toLowerCase();
  return MODIFIER_KEYS.has(lower) ? null : lower;
}

/** 一次 keydown → 键串;只按了修饰键(录制时常见)返回 null。 */
export function chordFromEvent(event: ChordEvent): string | null {
  const name = eventKeyName(event);
  if (name === null) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  // 标点是按住 ⇧ 才打出来的(? 就是 ⇧/),键串里记 ? 本身,不再记 Shift。
  const shiftedPunctuation = name.length === 1 && !/[a-z0-9]/.test(name);
  if (event.shiftKey && !shiftedPunctuation) parts.push("Shift");
  parts.push(name);
  return parts.join("+");
}

/** 栏 → 键串 → 动作 的反查表;`useKeymap` 缓存一份,hook 每次 keydown 只做一次 Map 查询。 */
export type KeymapIndex = ReadonlyMap<KeymapScope, ReadonlyMap<string, KeymapAction>>;

export function indexKeymap(table: KeymapTable): KeymapIndex {
  const index = new Map<KeymapScope, Map<string, KeymapAction>>();
  for (const meta of KEYMAP_ACTIONS) {
    for (const scope of meta.scopes) {
      const byChord = index.get(scope) ?? new Map<string, KeymapAction>();
      for (const chord of table[meta.id] ?? []) if (!byChord.has(chord)) byChord.set(chord, meta.id);
      index.set(scope, byChord);
    }
  }
  return index;
}

export function lookupAction(index: KeymapIndex, scope: KeymapScope, event: ChordEvent): KeymapAction | null {
  const chord = chordFromEvent(event);
  if (chord === null) return null;
  return index.get(scope)?.get(chord) ?? null;
}

const KEY_GLYPHS: Readonly<Record<string, string>> = {
  space: "Space",
  enter: "⏎",
  tab: "Tab",
  escape: "Esc",
  backspace: "⌫",
  delete: "⌦",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  home: "Home",
  end: "End",
};

/** 键串 → 键帽文字(⌥⇧⌘ 顺序按 macOS 惯例),给 `Kbd` 显示用:`Mod+Shift+arrowleft` → `⇧⌘←`。 */
export function formatKey(chord: string): string {
  const parts = chord.split("+");
  const name = parts.pop() ?? "";
  const mods = new Set(parts);
  const glyph = KEY_GLYPHS[name] ?? (name.length === 1 ? name.toUpperCase() : name.toUpperCase());
  return `${mods.has("Alt") ? "⌥" : ""}${mods.has("Shift") ? "⇧" : ""}${mods.has("Mod") ? "⌘" : ""}${glyph}`;
}

/** 一个动作的全部键帽文字(多把键用 ` / ` 连)。 */
export function formatAction(table: KeymapTable, action: KeymapAction): string {
  return (table[action] ?? []).map(formatKey).join(" / ");
}

/** 把一次录制写进自定义覆盖;返回新的 `keymap.custom` JSON(调用方负责把 preset 切到 custom)。 */
export function withOverride(preset: string | undefined, custom: string | undefined, action: KeymapAction, keys: readonly string[]): string {
  const parsed = parseKeymapCustom(custom);
  const base: KeymapCustom["base"] = preset && isPresetId(preset) && preset !== "custom" ? preset : parsed.base;
  const overrides = preset === "custom" ? parsed.overrides : {};
  return JSON.stringify({ base, overrides: { ...overrides, [action]: keys } } satisfies KeymapCustom);
}
