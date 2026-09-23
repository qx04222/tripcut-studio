/**
 * terminology.test 的白名单(R12 车道 C)。每条例外都要写清「为什么这个词必须留」;
 * 只按文件 + 正则匹配一行,不给整文件豁免。新增例外先想能不能改文案,想不出再加。
 */
export interface TerminologyException {
  /** 相对仓库根的文件路径。 */
  file: string;
  /** 命中这一行才豁免(对整行 trim 后匹配)。 */
  line: RegExp;
  reason: string;
}

export const TERMINOLOGY_EXCEPTIONS: readonly TerminologyException[] = [
  {
    file: "src/workspace/MusicRuler.tsx",
    line: /const within = \(tick: number\)/,
    reason: "是箭头函数不是文案:扫描器把 `>= 0 && (totalTicks <` 当成了 JSX 文本。",
  },
  {
    file: "src/workspace/settings/WhisperModelCard.tsx",
    line: /SHA-256/,
    reason: "模型文件的校验码是用户要在下载页对照的实物名,换成「校验码」就对不上下载页;这一卡只在模型缺失时展开。",
  },
  {
    file: "src/workspace/settings/ToolsSection.tsx",
    line: /large-v3-turbo|<option value="small">/,
    reason: "Whisper 模型档位的选项值是文件名的一部分(ggml-large-v3-turbo.bin),用户要按它去下载页找文件。",
  },
  {
    file: "src/workspace/settings/AnalysisSection.tsx",
    line: /LLM CLI 可用性|最近 LLM 调用账本|tokens/,
    reason: "订阅大模型的调用账本给排障用(provider / tokens 是账单上的原词),在「高级」节里,不是主路径文案。",
  },
  {
    file: "src/workspace/previewSource.ts",
    line: /const prefix = status\.source_kind === "original" \? "原片" : "代理"/,
    reason: "R25 TC-0115-003:业主验收原话要求监视器写明「原片」还是「代理」及分辨率(例「代理 540p」),换成「预览小文件」会和验收条目对不上。",
  },
  {
    file: "src/workspace/previewSource.ts",
    line: /原片掉帧,改播代理/,
    reason: "R28 TC-0115-003 复报:自动档原片掉帧自动退代理时,角标要如实说清现在看的是代理、为什么;与角标「代理 / 原片」同一套说法。",
  },
  {
    file: "src/workspace/PreviewSourceBadge.tsx",
    line: /改用代理播放/,
    reason: "R25 TC-0115-003:掉帧提示的退路按钮,与角标「代理 / 原片」同一套说法;验收条目原话是「允许退回代理」。",
  },
  {
    file: "src/workspace/settings/PerformanceSection.tsx",
    line: /改播代理|1080p 代理|540p 代理/,
    reason: "R25 TC-0115-003:「预览画质」四档要与监视器角标(「代理 540p」「原片 2160p」)用同一套词,业主报告的四档原话就是「代理 / 原片 / 1920×1080 / 960×540」。",
  },
];
