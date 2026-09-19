import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

import { appearanceAttributes, FIXED_THEMES, normalizeThemePref } from "../appearance";

// R19 车道 tokens · Q-4:浅色下监视器井 / 镜头带 / 状态条深底,只经这份新令牌文件覆盖。
const TOKENS_R19 = readFileSync(resolve(process.cwd(), "src/styles/tokens-r19.css"), "utf8");

const TOKENS = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const WORKSPACE = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");
// R19 车道 tokens · V-09:旧字号梯子(styles.css:6-11 定义的 --font-xs/sm/base/lg/xl/display)
// 要在这三个文件里清零,styles.css 本身留作只降不升的基线(它自己还定义着这批变量,给
// 剩下没碰的 ~270 处用)。
const PLAYER_OVERLAY = readFileSync(resolve(process.cwd(), "src/PlayerOverlay.css"), "utf8");
const STYLES = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const OLD_FONT_VAR = /var\(--font-(xs|sm|base|lg|xl|display)\b[^)]*\)/g;
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
    // 两套主题(浅色 :root、深色——prefers-color-scheme 与 data-theme=dark 是同一套值)都不
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
  it("R19 车道 tokens · Q-3:「剪映风格深色」升格为唯一深色——tokens.css 里不再有单独的 html[data-theme=\"jianying-dark\"] 选择器,它的令牌值(井底/阴影/播放头)原样并进两套通用深色块", () => {
    expect(TOKENS).not.toMatch(/data-theme="jianying-dark"/);
    const root = postcss.parse(TOKENS);
    const darkBlocks: Record<string, string>[] = [];
    root.walkRules((rule) => {
      if (!/data-theme="dark"|:not\(\[data-theme="light"\]\)/.test(rule.selector)) return;
      const values: Record<string, string> = {};
      rule.walkDecls((d) => { values[d.prop] = d.value; });
      darkBlocks.push(values);
    });
    expect(darkBlocks.length).toBe(2);
    for (const values of darkBlocks) {
      expect(values["--surface-card"]).toBe("#1b1d20");
      expect(values["--well-bg"]).toBe("#0a0b0d");
      expect(values["--playhead"]).toBe("#ff4d4a");
    }
  });
  it("V-25:深色下 --ring 内圈改用不透明的 --bg-solid(浅色 --surface-panel 半透明会透出底色 4%,两套深色主题都要盖住)", () => {
    const root = postcss.parse(TOKENS);
    const darkRingSelectors = [
      ':root:not([data-theme="light"])',
      'html[data-theme="dark"]',
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

describe("R19 车道 tokens · Q-3:主题收两套(jianying-dark 升格为唯一 dark)", () => {
  it("normalizeThemePref:三选项原样返回,旧 jianying-dark 映射到 dark,未知值落回 system", () => {
    expect(normalizeThemePref("system")).toBe("system");
    expect(normalizeThemePref("light")).toBe("light");
    expect(normalizeThemePref("dark")).toBe("dark");
    expect(normalizeThemePref("jianying-dark")).toBe("dark");
    expect(normalizeThemePref(undefined)).toBe("system");
    expect(normalizeThemePref("some-future-value")).toBe("system");
  });
  it("FIXED_THEMES 只剩 light/dark,appearanceAttributes 对旧 jianying-dark 偏好解出 dark", () => {
    expect(FIXED_THEMES).toEqual(["light", "dark"]);
    expect(appearanceAttributes({ "appearance.theme": "jianying-dark" }).theme).toBe("dark");
    expect(appearanceAttributes({ "appearance.theme": "dark" }).theme).toBe("dark");
    expect(appearanceAttributes({ "appearance.theme": "system" }).theme).toBeNull();
  });
  it("styles.css 里 --accent 等调色板令牌:深色 = jianying 的青绿(浅色仍是原来的橄榄绿强调只在 :root 定义,深色块整段换成青绿系)", () => {
    const root = postcss.parse(STYLES);
    let sawDarkAccent = false;
    root.walkRules((rule) => {
      if (!/data-theme="dark"|:not\(\[data-theme="light"\]\)/.test(rule.selector)) return;
      rule.walkDecls("--accent", (d) => { if (d.value.trim() === "#2fd6c4") sawDarkAccent = true; });
    });
    expect(sawDarkAccent).toBe(true);
    expect(STYLES).not.toMatch(/data-theme="jianying-dark"/);
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
  it("R19 tokens-lite · V-10:!important 只降不升,基线 5 → 1(拆掉 monitor-r10 四条焦点环覆盖与 timeline-r13 那条;留下的唯一一条是全局 prefers-reduced-motion)", () => {
    expect(totals.important).toBeLessThanOrEqual(1);
  });
  it("R19 tokens-lite · V-10:每条 animation 声明的时长都引 --motion-* 令牌(4 个 keyframes 的调用点不再写 220ms / 320ms 字面量)", () => {
    const bad: string[] = [];
    for (const f of WORKSPACE_LANE_FILES) {
      postcss.parse(readLane(f)).walkDecls(/^animation(-duration)?$/, (d) => {
        const v = d.value.trim();
        if (v === "none") return;
        if (!v.includes("var(--motion-")) bad.push(`${f}:${d.source?.start?.line ?? "?"} ${v}`);
      });
    }
    expect(bad).toEqual([]);
  });
  it("R19 tokens-lite · V-10:全局 prefers-reduced-motion 规则存在于 shell-r19.css,且只用一条 !important 把 transition 时长压到 0.01ms", () => {
    const css = readLane("shell-r19.css");
    const root = postcss.parse(css);
    let found = false;
    let importantInside = 0;
    root.walkAtRules("media", (at) => {
      if (!/prefers-reduced-motion:\s*reduce/.test(at.params)) return;
      at.walkRules((rule) => {
        if (!/^\*|,\s*\*|\*::/.test(rule.selector.trim()) && rule.selector.trim() !== "*") return;
        let hasTransition = false;
        rule.walkDecls((d) => {
          if (d.important) importantInside++;
          if (d.prop === "transition-duration" && d.important && d.value.includes("0.01ms")) hasTransition = true;
        });
        if (hasTransition) found = true;
      });
    });
    expect(found, "shell-r19.css 里要有 @media (prefers-reduced-motion: reduce) { * { transition-duration: 0.01ms !important } }").toBe(true);
    expect(importantInside).toBe(1);
  });
});

describe("R19 tokens-lite · V-10 动效令牌", () => {
  const names = declared(TOKENS);
  it("--motion-exit 存在,且比 --motion-slow 短(进比出慢:出场 120ms ease-in)", () => {
    expect(names.has("--motion-exit")).toBe(true);
    const values: Record<string, string> = {};
    postcss.parse(TOKENS).walkDecls(/^--motion-(exit|slow)$/, (d) => { values[d.prop] = d.value; });
    const ms = (v: string) => Number(/^(\d+)ms/.exec(v)?.[1] ?? NaN);
    expect(ms(values["--motion-exit"]!)).toBe(120);
    expect(ms(values["--motion-exit"]!)).toBeLessThan(ms(values["--motion-slow"]!));
  });
  it("R19 V-11:--bp-compact 是 1366px,且与 shellLayout.ts 的 BP_COMPACT 同值(matchMedia 读不到变量,两份必须钉在一起)", () => {
    let value = "";
    postcss.parse(TOKENS).walkDecls("--bp-compact", (d) => { value = d.value; });
    expect(value).toBe("1366px");
    const layout = readFileSync(resolve(process.cwd(), "src/workspace/shellLayout.ts"), "utf8");
    expect(layout).toMatch(/export const BP_COMPACT = 1366;/);
  });
  it("--motion-exit 只声明在 :root(主题块不重定义)", () => {
    const root = postcss.parse(TOKENS);
    root.walkRules((rule) => {
      if (rule.selector === ":root") return;
      rule.walkDecls("--motion-exit", () => { throw new Error(`${rule.selector} 不应重定义 --motion-exit`); });
    });
  });
});

describe("R19 车道 tokens · V-09:旧字号梯子退役", () => {
  it("tokens.css 补了 --text-16/--text-19/--text-display,承接旧 --font-lg/--font-xl/--font-display 的原值(数值不变,只改名)", () => {
    const names = declared(TOKENS);
    for (const k of ["--text-16", "--lh-16", "--text-19", "--lh-19", "--text-display"]) {
      expect(names.has(k), k).toBe(true);
    }
    const values: Record<string, string> = {};
    postcss.parse(TOKENS).walkDecls(/^--(text-16|text-19|text-display)$/, (d) => { values[d.prop] = d.value; });
    expect(values["--text-16"]).toBe("16px");
    expect(values["--text-19"]).toBe("19px");
    expect(values["--text-display"]).toBe("clamp(2.125rem, 5vw, 3.875rem)");
  });
  it("workspace.css / PlayerOverlay.css / 车道文件(reset-r15.css、native-r18.css)里旧 --font-* 命中数为 0", () => {
    expect((WORKSPACE.match(OLD_FONT_VAR) ?? []).length).toBe(0);
    expect((PLAYER_OVERLAY.match(OLD_FONT_VAR) ?? []).length).toBe(0);
    for (const f of ["reset-r15.css", "native-r18.css"]) {
      const css = readLane(f);
      expect((css.match(OLD_FONT_VAR) ?? []).length, f).toBe(0);
    }
  });
  it("styles.css 只降不升基线:本轮把首页/抽屉相关 ~63 处换成 --text-*,旧梯子命中数不得超过当前基线", () => {
    const hits = (STYLES.match(OLD_FONT_VAR) ?? []).length;
    // 基线由本轮实测钉死;下一轮清得更多时把这个数字往下改,不允许涨回去。
    expect(hits).toBeLessThanOrEqual(292);
  });
  it("门禁自身会响:塞一个 var(--font-xs) 进去就能被正则逮到", () => {
    expect(("font-size: var(--font-xs);".match(OLD_FONT_VAR) ?? []).length).toBe(1);
  });
});

describe("R19 车道 tokens · Q-4:浅色下监视器井/镜头带/状态条深底", () => {
  const root = postcss.parse(TOKENS_R19);
  it("workspace.css 头部 @import 了 tokens-r19.css(house 规则:@import 不在头部会被 postcss 静默丢)", () => {
    const workspaceHead = WORKSPACE.split("\n").slice(0, 40).join("\n");
    expect(workspaceHead).toContain('@import "./tokens-r19.css";');
  });
  it("--well-bg 在浅色 :root 下改成深底(不是旧的 --media-well 浅米灰)", () => {
    let value = "";
    root.walkRules(":root", (rule) => { rule.walkDecls("--well-bg", (d) => { value = d.value; }); });
    expect(value).toBe("#1b1d20");
  });
  it("镜头带轨道与状态条的 --surface-panel 被限定在各自选择器上覆盖成深底,不是全局改 :root(不连累池/检查器/设置页等其它读 --surface-panel 的浅色面板)", () => {
    const scoped: Record<string, string> = {};
    root.walkRules((rule) => {
      if (rule.selector === ":root") return;
      rule.walkDecls("--surface-panel", (d) => { scoped[rule.selector] = d.value; });
    });
    expect(scoped[".workspace-shell .shot-band .band-viewport,\n.workspace-shell .workspace-status"]).toBe("#1b1d20");
    // :root 本身(池/检查器/设置页都读它)不在这份文件里被重定义。
    let rootOverridesSurfacePanel = false;
    root.walkRules(":root", (rule) => { rule.walkDecls("--surface-panel", () => { rootOverridesSurfacePanel = true; }); });
    expect(rootOverridesSurfacePanel).toBe(false);
  });
  it("门禁自身会响:tokens-r19.css 缺 --well-bg 覆盖就该失败(正向证明上面两条真的在读这份文件而不是巧合过了)", () => {
    const empty = postcss.parse("/* empty */");
    let found = false;
    empty.walkRules(":root", (rule) => { rule.walkDecls("--well-bg", () => { found = true; }); });
    expect(found).toBe(false);
  });
});

describe("R19 车道 tokens · Q-4:WCAG 对比度(playhead / 选中环在新深底上的实测数字)", () => {
  // 与 tokens-r19.css 的深底、tokens.css 的 --playhead / --accent-glow 数值手动对齐——
  // 改了任何一头这条测试都要跟着重算,不是复制一份魔法数字。
  function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function relLum([r, g, b]: [number, number, number]): number {
    const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const [rr, gg, bb] = [f(r), f(g), f(b)];
    return 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
  }
  function contrast(hex1: string, hex2: string): number {
    const [l1, l2] = [relLum(hexToRgb(hex1)), relLum(hexToRgb(hex2))].sort((a, b) => b - a);
    return (l1 + 0.05) / (l2 + 0.05);
  }
  it("浅色下 --playhead(#e0312b)在新深底(#1b1d20)上的对比度 ≥ 3:1(WCAG 1.4.11 非文字对比),且不比旧浅底(#e8e6dc)差", () => {
    const onNewDark = contrast("#e0312b", "#1b1d20");
    const onOldLight = contrast("#e0312b", "#e8e6dc");
    expect(onNewDark).toBeGreaterThanOrEqual(3);
    expect(onNewDark).toBeGreaterThanOrEqual(onOldLight - 0.05);
  });
  it("选中环 --accent-glow(浅色强调色 30% 透明度)叠在新深底上的对比度是已知弱项(< 3:1),但不比退役前的浅底更差——记录数字,不是本车道修的范围", () => {
    const composite = (fgHex: string, alpha: number, bgHex: string): [number, number, number] => {
      const [fr, fg, fb] = hexToRgb(fgHex);
      const [br, bg, bb] = hexToRgb(bgHex);
      return [fr * alpha + br * (1 - alpha), fg * alpha + bg * (1 - alpha), fb * alpha + bb * (1 - alpha)];
    };
    const contrastRgb = (rgb: [number, number, number], hex2: string) => {
      const [l1, l2] = [relLum(rgb), relLum(hexToRgb(hex2))].sort((a, b) => b - a);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    const onNewDark = contrastRgb(composite("#6d8f00", 0.3, "#1b1d20"), "#1b1d20");
    const onOldLight = contrastRgb(composite("#6d8f00", 0.3, "#e8e6dc"), "#e8e6dc");
    expect(onNewDark).toBeLessThan(3);
    expect(onNewDark).toBeGreaterThan(onOldLight - 0.3);
  });
});
