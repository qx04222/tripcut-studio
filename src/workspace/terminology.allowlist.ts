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
];
