import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TERMINOLOGY_EXCEPTIONS } from "./terminology.allowlist";

/**
 * R11 简化专项 #3(术语清扫)的门禁,R12 车道 C 扩到 B-列表全部词(规格 §4):
 * 工作区可见文案里不许再出现内部术语。只扫字符串 / JSX 文本行(以 `"`、`` ` ``、`「`、`>`
 * 起头的片段),注释行跳过;例外逐条写在 `terminology.allowlist.ts` 里并注明理由。
 */
// R13 真机 Y-11:切集弹层的集列表与封存控件来自 src/EpisodePanel.tsx(EpisodeSwitcher 复用),一并扫。
const ROOTS = ["src/workspace", "src/EpisodePanel.tsx", "src/TechCheckPanel.tsx", "src/AnalysisPanel.tsx", "src/helpContent.ts", "src/toolchainSteps.ts"];
const JARGON = new RegExp(
  [
    // R11 那批
    "remux", "H\\.264", "H264", "VFR", "\\bL1\\b", "\\bL3\\b", "sidecar", "Shot Stack", "Stack 首选", "Stack 候选", "\\bStack\\b", "\\bhero\\b",
    "时基", "代理文件", "540p", "worker", "嵌入向量", "向量", "Take \\d", "Take \\$\\{", "FIRST RUN",
    // R12 B-列表(.superpowers/sdd/r11/verify-v1.md)+ 任务书点名的词
    "\\bPTS\\b", "\\bticks?\\b", "索引", "代理", "启发式", "ggml", "minisign", "\\bBOM\\b", "码率", "画布",
    "Whisper 模型", "Chinese-CLIP", "Python", "签名组件包", "帧精确", "重编码", "镜头表 CSV", "\\bCSV\\b", "位深", "bt709", "实际帧率", "设备未提供",
    "解码并发", "被系统换出", "FFmpeg 路径", "FFprobe 路径", "whisper-cli", "模型档位", "SHA-256", "服务脚本", "分析阈值", "astats",
    "订阅大模型", "Cargo\\.toml", "package\\.json", "NAS", "export failed", "八维", "音轨与 LUT", "\\bLUT\\b", "API Key", "白名单",
    // X-05(R12 验收):主路径上残留的内部词
    "生成交付包", "整条收藏", "共用常量", "第\\d+段",
    // Y-11(R13 真机 0.7.0):切集弹层「封存本集 / 交付 1」、关于页「Schema / 当前 worker / 独占写入」
    "封存本集", "封存并开启", "无需封存", "· 交付", "交付 \\d", "Schema", "独占写入", "写锁",
    // Z-09 / Z-10(R13 压测):导出失败的开发者字串
    "os error", "Permission denied", "dest_unavailable", "No space left",
  ].join("|"),
);

function files(root: string): string[] {
  const full = join(process.cwd(), root);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const path = join(full, entry.name);
    if (entry.isDirectory()) return files(join(root, entry.name));
    // settingsModel.ts 的 SETTINGS_TABS 是与旧壳 SettingsPage 逐字对照的表(settingsModel.test 钉住),
    // R11 起左轨不再渲染它的 description,旧壳 R10 删时一起消失 —— 不算工作区可见文案。
    if (entry.name === "settingsModel.ts") return [];
    // 白名单本身写着被禁的词(说明理由),不算文案。
    if (entry.name === "terminology.allowlist.ts") return [];
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
        const relative = file.replace(process.cwd() + "/", "");
        if (TERMINOLOGY_EXCEPTIONS.some((exception) => exception.file === relative && exception.line.test(trimmed))) return;
        if (JARGON.test(visible)) hits.push(`${relative}:${index + 1}: ${trimmed.slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
