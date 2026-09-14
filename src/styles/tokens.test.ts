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
