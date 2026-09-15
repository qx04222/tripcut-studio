import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const WORKSPACE = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");
// kit.css 只是 @import 桶,一个组件一个文件在 src/styles/kit/ 下;门禁扫全部。
const KIT_DIR = resolve(process.cwd(), "src/styles/kit");
const KIT = [readFileSync(resolve(process.cwd(), "src/styles/kit.css"), "utf8")]
  .concat(readdirSync(KIT_DIR).filter((f) => f.endsWith(".css")).sort().map((f) => readFileSync(resolve(KIT_DIR, f), "utf8")))
  .join("\n");
// R18 车道 V1 · V-01:43 个车道文件(R9→R17 逐轮叠加)此前完全不在门禁里,已经积下
// px 字号 / 圆角字面量 / 非令牌阴影 / 非令牌 transition / 裸 z-index 数字。逐文件读,
// 报错时能指回具体文件+行号,不是囫囵一坨。
const WORKSPACE_LANES_DIR = resolve(process.cwd(), "src/styles/workspace");
const WORKSPACE_LANE_FILES = readdirSync(WORKSPACE_LANES_DIR).filter((f) => f.endsWith(".css")).sort();
function readLane(f: string): string {
  return readFileSync(resolve(WORKSPACE_LANES_DIR, f), "utf8");
}

function declared(css: string): Set<string> {
  const names = new Set<string>();
  postcss.parse(css).walkDecls((decl) => {
    if (decl.prop.startsWith("--")) names.add(decl.prop);
  });
  return names;
}

describe("tokens.css", () => {
  const names = declared(TOKENS);
  it("五级字号与配套行高、六档间距、四级表面、三级阴影、两档圆角都在", () => {
    for (const n of ["11", "12", "13", "15", "20"]) {
      expect(names.has(`--text-${n}`), `--text-${n}`).toBe(true);
      expect(names.has(`--lh-${n}`), `--lh-${n}`).toBe(true);
    }
    for (const n of ["1", "2", "3", "4", "5", "6"]) expect(names.has(`--space-${n}`)).toBe(true);
    for (const s of ["ground", "panel", "card", "raised"]) expect(names.has(`--surface-${s}`)).toBe(true);
    for (const s of ["card", "raised", "inset-well"]) expect(names.has(`--shadow-${s}`)).toBe(true);
    for (const r of ["6", "10"]) expect(names.has(`--radius-${r}`)).toBe(true);
    for (const t of ["ok", "warn", "danger", "info"]) {
      expect(names.has(`--${t}`)).toBe(true);
      expect(names.has(`--${t}-tint`)).toBe(true);
    }
    for (const k of ["--border-hair", "--border-strong", "--ring", "--ring-selected", "--motion-fast", "--control-sm", "--control-md", "--well-bg"]) {
      expect(names.has(k), k).toBe(true);
    }
  });
  it("R18 车道 V1 新增令牌:圆角/字号/层级/慢动效都在,且只声明在 :root(三套主题都靠继承拿到,不会漏)", () => {
    const NEW_TOKENS = [
      "--radius-2", "--radius-4", "--radius-pill",
      "--text-28", "--lh-28", "--text-40", "--lh-40",
      "--z-base", "--z-sticky", "--z-band-playhead", "--z-overlay", "--z-menu", "--z-modal", "--z-toast",
      "--motion-slow",
    ];
    for (const k of NEW_TOKENS) expect(names.has(k), k).toBe(true);
    // 三套主题(浅色 :root、prefers-color-scheme 深色、data-theme=dark、jianying-dark)都不
    // 重新定义这批令牌——只声明一次,靠层叠继承覆盖所有主题,不存在“某套主题漏了新令牌”。
    const root = postcss.parse(TOKENS);
    const themedOverrides = new Set<string>();
    root.walkRules((rule) => {
      if (rule.selector === ":root") return;
      rule.walkDecls((d) => { themedOverrides.add(d.prop); });
    });
    for (const k of NEW_TOKENS) expect(themedOverrides.has(k), `${k} 不应被任何主题块重定义`).toBe(false);
  });
  it("间距六档就是 4/8/12/16/24/32", () => {
    const values: Record<string, string> = {};
    postcss.parse(TOKENS).walkDecls(/^--space-/, (d) => { values[d.prop] = d.value; });
    expect(values).toEqual({ "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px", "--space-5": "24px", "--space-6": "32px" });
  });
  it("表面色引用既有调色板变量,深色主题才会自动跟随", () => {
    const values: Record<string, string> = {};
    postcss.parse(TOKENS).walkDecls(/^--surface-(ground|panel)$/, (d) => { values[d.prop] = d.value; });
    expect(values["--surface-ground"]).toBe("var(--bg)");
    expect(values["--surface-panel"]).toBe("var(--bg-elevated)");
  });
  it("唯一的 transition 时长是 150ms", () => {
    let motion = "";
    postcss.parse(TOKENS).walkDecls("--motion-fast", (d) => { motion = d.value; });
    expect(motion.startsWith("150ms")).toBe(true);
  });
  it("有深色覆盖块", () => {
    expect(TOKENS).toMatch(/prefers-color-scheme:\s*dark/);
    expect(TOKENS).toMatch(/html\[data-theme="dark"\]/);
  });
  it("深色覆盖块把浅色块里每个会变色的令牌都重定义了(卡面/浮层/阴影/井底)", () => {
    const root = postcss.parse(TOKENS);
    const darkBlocks: Set<string>[] = [];
    root.walkRules((rule) => {
      if (!/data-theme="dark"|:not\(\[data-theme="light"\]\)/.test(rule.selector)) return;
      const set = new Set<string>();
      rule.walkDecls((d) => {
        set.add(d.prop);
      });
      darkBlocks.push(set);
    });
    expect(darkBlocks.length).toBe(2);
    for (const set of darkBlocks) {
      for (const k of ["--surface-card", "--surface-raised", "--shadow-card", "--shadow-raised", "--shadow-inset-well", "--well-bg"]) {
        expect(set.has(k), k).toBe(true);
      }
    }
  });
  it("R13 §5「剪映风格深色」:自己的一整套深色值(底 / 面板 / 文字 / 强调 / 播放头),挂在 html[data-theme=\"jianying-dark\"] 上", () => {
    const root = postcss.parse(TOKENS);
    const blocks: Set<string>[] = [];
    root.walkRules((rule) => {
      if (!rule.selector.includes('data-theme="jianying-dark"')) return;
      const set = new Set<string>();
      rule.walkDecls((d) => {
        set.add(d.prop);
      });
      blocks.push(set);
    });
    expect(blocks.length).toBe(1);
    const set = blocks[0]!;
    for (const k of [
      "--bg", "--bg-elevated", "--bg-solid", "--border", "--border-strong", "--text-primary", "--text-secondary", "--text-muted", "--text-faint",
      "--accent", "--accent-contrast", "--accent-tint", "--accent-glow", "--focus-ring", "--warning", "--danger", "--media-well", "--media-overlay",
      "--surface-card", "--surface-raised", "--surface-chrome", "--surface-chrome-2", "--well-bg", "--shadow-card", "--shadow-raised", "--shadow-inset-well", "--playhead",
    ]) {
      expect(set.has(k), k).toBe(true);
    }
  });
  it("V-25:深色下 --ring 内圈改用不透明的 --bg-solid(浅色 --surface-panel 半透明会透出底色 4%,三套深色主题都要盖住)", () => {
    const root = postcss.parse(TOKENS);
    const darkRingSelectors = [
      ':root:not([data-theme="light"])',
      'html[data-theme="dark"]',
      'html[data-theme="jianying-dark"]',
    ];
    const found: Record<string, string> = {};
    root.walkRules((rule) => {
      if (!darkRingSelectors.includes(rule.selector)) return;
      rule.walkDecls("--ring", (d) => { found[rule.selector] = d.value; });
    });
    for (const sel of darkRingSelectors) {
      expect(found[sel], `${sel} 应重定义 --ring`).toBeDefined();
      expect(found[sel]).toContain("var(--bg-solid)");
      expect(found[sel]).not.toContain("var(--surface-panel)");
    }
  });
});

/** 规格 §1 的三条扫描,套件与主屏样式共用。 */
function tokenOffenders(css: string): { colors: string[]; fontSizes: string[]; spacing: string[] } {
  const root = postcss.parse(css);
  const colors: string[] = [];
  const fontSizes: string[] = [];
  const spacing: string[] = [];
  root.walkDecls((d) => {
    if (d.prop.startsWith("--")) return;
    if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(d.value)) colors.push(`${d.prop}: ${d.value}`);
  });
  root.walkDecls("font-size", (d) => { if (!/var\(--text-\d+\)/.test(d.value)) fontSizes.push(d.value); });
  root.walkDecls(/^(padding|margin|gap|row-gap|column-gap)(-\w+)?$/, (d) => {
    for (const m of d.value.matchAll(/(-?\d+)px/g)) {
      if (!["0", "4", "8", "12", "16", "24", "32", "-1"].includes(m[1]!)) spacing.push(`${d.prop}: ${d.value}`);
    }
  });
  return { colors, fontSizes, spacing };
}

describe("kit.css 只从令牌取值(规格 §1、§2)", () => {
  const offenders = tokenOffenders(KIT);
  it("桶文件把 kit/ 下每个组件样式都 @import 了(漏一个就是整个组件没样式)", () => {
    const barrel = readFileSync(resolve(process.cwd(), "src/styles/kit.css"), "utf8");
    for (const f of readdirSync(KIT_DIR).filter((f) => f.endsWith(".css"))) expect(barrel, f).toContain(`@import "./kit/${f}"`);
  });
  it("没有颜色字面量", () => { expect(offenders.colors).toEqual([]); });
  it("font-size 只用 --text-* 令牌", () => { expect(offenders.fontSizes).toEqual([]); });
  it("padding/margin/gap 不出现六档之外的 px", () => { expect(offenders.spacing).toEqual([]); });
  it("transition 只用 --motion-fast", () => {
    const bad: string[] = [];
    postcss.parse(KIT).walkDecls(/^transition(-duration)?$/, (d) => { if (/\d+m?s/.test(d.value)) bad.push(d.value); });
    expect(bad).toEqual([]);
  });
  it("门禁自身会响:塞一个 hex 进去就红", () => {
    expect(tokenOffenders(".x { color: #fff; font-size: 13px; padding: 10px; }")).toEqual({
      colors: ["color: #fff"], fontSizes: ["13px"], spacing: ["padding: 10px"],
    });
  });
});

// Task 8b 打开:workspace.css 现在满是 13px 与 10px,Task 8b 清完再把 describe.todo 改回 describe。
describe.todo("workspace.css 只从令牌取值(规格 §1)", () => {
  const root = postcss.parse(WORKSPACE);
  it("没有颜色字面量", () => {
    const offenders: string[] = [];
    root.walkDecls((d) => {
      if (d.prop.startsWith("--")) return;
      if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(d.value)) offenders.push(`${d.prop}: ${d.value}`);
    });
    expect(offenders).toEqual([]);
  });
  it("font-size 只用 --text-* 令牌", () => {
    const offenders: string[] = [];
    root.walkDecls("font-size", (d) => { if (!/var\(--text-\d+\)/.test(d.value)) offenders.push(d.value); });
    expect(offenders).toEqual([]);
  });
  it("padding/margin/gap 不出现六档之外的 px", () => {
    const offenders: string[] = [];
    root.walkDecls(/^(padding|margin|gap|row-gap|column-gap)(-\w+)?$/, (d) => {
      for (const m of d.value.matchAll(/(-?\d+)px/g)) {
        if (!["0", "4", "8", "12", "16", "24", "32", "-1"].includes(m[1]!)) offenders.push(`${d.prop}: ${d.value}`);
      }
    });
    expect(offenders).toEqual([]);
  });

});

/** R18 车道 V1 · 门禁扩围到 43 个车道文件(brainstorm-visual.md §3 车道 V1)。
 *  六条规则,逐条给出违规清单(文件:行号 值),而不是只报数字。 */
function laneOffenders(css: string, file: string) {
  const root = postcss.parse(css);
  const fontSize: string[] = [];
  const radius: string[] = [];
  const shadow: string[] = [];
  const transition: string[] = [];
  const zIndex: string[] = [];
  let important = 0;
  const radiusOk = (tok: string) => /^var\(--radius-[\w-]+\)$/.test(tok) || tok === "50%" || tok === "0" || tok === "inherit";
  root.walkDecls((d) => {
    if (d.important) important++;
    const at = `${file}:${d.source?.start?.line ?? "?"}`;
    if (d.prop === "font-size" && /^\d+(\.\d+)?px$/.test(d.value.trim())) fontSize.push(`${at} ${d.value}`);
    if (d.prop === "border-radius") {
      const parts = d.value.trim().split(/\s+/);
      if (!parts.every(radiusOk)) radius.push(`${at} ${d.value}`);
    }
    if (d.prop === "box-shadow") {
      const v = d.value.trim();
      if (!(v === "none" || v.includes("var(--shadow-") || v.includes("var(--ring"))) shadow.push(`${at} ${d.value}`);
    }
    if (d.prop === "transition" && !d.value.includes("var(--motion-")) transition.push(`${at} ${d.value.replace(/\s+/g, " ")}`);
    if (d.prop === "z-index") {
      const v = d.value.trim();
      if (!(v === "auto" || /^var\(--z-[\w-]+\)$/.test(v))) zIndex.push(`${at} ${d.value}`);
    }
  });
  return { fontSize, radius, shadow, transition, zIndex, important };
}

describe("workspace/*.css(43 个车道文件)门禁扩围(V-01)", () => {
  const perFile = WORKSPACE_LANE_FILES.map((f) => laneOffenders(readLane(f), f));
  const totals = {
    fontSize: perFile.flatMap((r) => r.fontSize),
    radius: perFile.flatMap((r) => r.radius),
    shadow: perFile.flatMap((r) => r.shadow),
    transition: perFile.flatMap((r) => r.transition),
    zIndex: perFile.flatMap((r) => r.zIndex),
    important: perFile.reduce((n, r) => n + r.important, 0),
  };
  it("门禁自身会响:塞一个字面量圆角/裸 z-index 进去就红", () => {
    const r = laneOffenders(".x { border-radius: 4px; z-index: 3; }", "self-test.css");
    expect(r.radius).toEqual(["self-test.css:1 4px"]);
    expect(r.zIndex).toEqual(["self-test.css:1 3"]);
  });
  it("没有 font-size: <数字>px 字面量", () => { expect(totals.fontSize).toEqual([]); });
  it("border-radius 只允许 var(--radius-*) / 50% / 0 / inherit", () => { expect(totals.radius).toEqual([]); });
  it("box-shadow 必须含 var(--shadow-*) 或 var(--ring*)(none 允许——它是「不要阴影」不是字面量)", () => {
    expect(totals.shadow).toEqual([]);
  });
  it("transition 必须含 var(--motion-*)", () => { expect(totals.transition).toEqual([]); });
  it("z-index 必须是 var(--z-*)(auto 允许——它是复位不是分配层级)", () => { expect(totals.zIndex).toEqual([]); });
  it("!important 计数只降不升:钉在 5(R18 前的基线;下轮才拆 monitor-r10 那两条焦点环覆盖)", () => {
    expect(totals.important).toBeLessThanOrEqual(5);
  });
});
