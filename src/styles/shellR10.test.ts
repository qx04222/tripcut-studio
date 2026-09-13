import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const SHELL = readFileSync(resolve(process.cwd(), "src/styles/workspace/shell-r10.css"), "utf8");
const WORKSPACE = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");

function declsIn(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  postcss.parse(SHELL).walkRules((rule) => {
    if (rule.selector !== selector) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value;
    });
  });
  return out;
}

describe("shell-r10.css(R10 车道 E)", () => {
  it("由 workspace.css 头部一条 @import 挂进来(在第一条规则之前,否则 postcss 会丢掉)", () => {
    const imports = WORKSPACE.match(/^@import "\.\/workspace\/shell-r10\.css";$/gm) ?? [];
    expect(imports).toHaveLength(1);
    const firstRule = WORKSPACE.search(/^[.:#][^\n]*\{$/m);
    expect(WORKSPACE.indexOf('@import "./workspace/shell-r10.css";')).toBeLessThan(firstRule);
  });

  it("U-21:四档缩放各定义 --ui-scale,R9 的字号 / 行高 / 控件高令牌全部乘上它", () => {
    expect(declsIn("html")["--ui-scale"]).toBe("1");
    expect(declsIn('html[data-ui-scale="90"]')["--ui-scale"]).toBe("0.9");
    expect(declsIn('html[data-ui-scale="115"]')["--ui-scale"]).toBe("1.15");
    expect(declsIn('html[data-ui-scale="130"]')["--ui-scale"]).toBe("1.3");
    const root = declsIn(":root");
    for (const n of ["11", "12", "13", "15", "20"]) {
      expect(root[`--text-${n}`], `--text-${n}`).toBe(`calc(${n}px * var(--ui-scale))`);
      expect(root[`--lh-${n}`], `--lh-${n}`).toMatch(/^calc\(\d+px \* var\(--ui-scale\)\)$/);
    }
    for (const k of ["--control-sm", "--control-md", "--control-lg"]) expect(root[k], k).toContain("var(--ui-scale)");
    const shell = declsIn("html .workspace-shell");
    for (const k of ["--workspace-topbar-height", "--workspace-status-height", "--workspace-control-height", "--workspace-pane-head-height", "--workspace-pane-chrome-height"]) {
      expect(shell[k], k).toContain("var(--ui-scale)");
    }
  });

  it("U-21:间距六档不缩(密度是设计决定),且不写颜色字面量", () => {
    expect(declsIn(":root")["--space-1"]).toBeUndefined();
    expect(/#[0-9a-fA-F]{3,8}\b/.test(SHELL)).toBe(false);
  });

  it("真解析器整份能解析,没有嵌套规则,花括号配平", () => {
    const root = postcss.parse(SHELL, { from: "src/styles/workspace/shell-r10.css" });
    const nested: string[] = [];
    root.walkRules((rule) => {
      if (rule.parent?.type === "rule") nested.push(rule.selector);
    });
    expect(nested).toEqual([]);
  });
});
