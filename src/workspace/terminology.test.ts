import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * R11 简化专项 #3(术语清扫)的门禁:工作区可见文案里不许再出现内部术语。
 * 只扫字符串 / JSX 文本行(以 `"`、`` ` ``、`「`、`>` 起头的片段),注释行跳过;
 * 冻结的 AX 名(`aria-label={\`Take …\`}`,R10 §8)是唯一豁免,记在 R12 待办。
 */
const ROOTS = ["src/workspace", "src/TechCheckPanel.tsx", "src/AnalysisPanel.tsx", "src/helpContent.ts", "src/toolchainSteps.ts", "src/FirstRunGuide.tsx"];
const JARGON = /remux|H\.264|H264|VFR|\bL1\b|\bL3\b|sidecar|Shot Stack|Stack 首选|Stack 候选|\bhero\b|时基|代理文件|540p 代理|worker 并发|嵌入向量|向量|Take \d|Take \$\{|FIRST RUN/;
const EXEMPT = /aria-label=\{`Take \$\{/;

function files(root: string): string[] {
  const full = join(process.cwd(), root);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const path = join(full, entry.name);
    if (entry.isDirectory()) return files(join(root, entry.name));
    // settingsModel.ts 的 SETTINGS_TABS 是与旧壳 SettingsPage 逐字对照的表(settingsModel.test 钉住),
    // R11 起左轨不再渲染它的 description,旧壳 R10 删时一起消失 —— 不算工作区可见文案。
    if (entry.name === "settingsModel.ts") return [];
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("工作区可见文案不含内部术语", () => {
  it("扫 src/workspace 与工作区用到的旧面板", () => {
    const hits: string[] = [];
    for (const file of ROOTS.flatMap(files)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (/^(\/\/|\*|\/\*)/.test(trimmed)) return;
        if (!/["`「>]/.test(trimmed)) return;
        // 只看引号 / 反引号 / 「」 / JSX 文本里的内容,不看标识符(`clip_sidecar.note` 这种属性访问不算文案)。
        const visible = (trimmed.match(/"[^"]*"|`[^`]*`|「[^」]*」|>[^<{]*</g) ?? [])
          // 模板里的 `${expr}` 是代码不是文案;纯标识符("hero"、"pool-take-hero"、"sidecar-resource")也不是文案。
          .map((piece) => piece.replace(/\$\{[^}]*\}/g, ""))
          .filter((piece) => /[\u4e00-\u9fff]/.test(piece) || /\s/.test(piece.slice(1, -1)))
          .join(" ");
        if (EXEMPT.test(trimmed)) return;
        if (JARGON.test(visible)) hits.push(`${file.replace(process.cwd() + "/", "")}:${index + 1}: ${trimmed.slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
