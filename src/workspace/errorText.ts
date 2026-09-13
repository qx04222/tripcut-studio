/**
 * R11 简化专项 #5:错误一句话 —— 用户看到的错误文案不带内部代码。
 * 后端(Tauri invoke)抛上来的通常是 `Error: xxx`、有时带 Rust 的 `Os { code: 2, kind: NotFound, … }`、
 * `E_SOMETHING`、`code=…`、堆栈行;这里只留人能读的那一句,再补一句「现在怎么办」。
 */
const INTERNAL_PATTERNS: readonly RegExp[] = [
  /^(Error|TypeError|RangeError|Invoke ?Error)\s*:\s*/i,
  /\bOs \{[^}]*\}/g,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // E_NOT_FOUND / DEST_UNAVAILABLE 这种常量名
  /\b(?:code|kind|status)\s*[=:]\s*[\w-]+/gi,
  /\s+at\s+\S+\s*\(.*\)$/gm, // 堆栈行
  /\((?:0x)?[0-9a-f]{6,}\)/gi, // 十六进制指针 / 哈希
];

/** 把一个错误值变成一句人能读的话;什么都不剩就退成「出了点问题」。 */
export function describeError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error ?? "");
  for (const pattern of INTERNAL_PATTERNS) text = text.replace(pattern, "");
  text = text
    .split("\n")[0]!
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:：,，;；。.]+|[\s:：,，;；。.]+$/g, "")
    .trim();
  return text.length > 0 ? text : "出了点问题";
}

/**
 * 「<动作>没成功:<原因>。<下一步>」—— 每条错误 toast 都说清现在怎么办。
 * `next` 缺省是「再试一次」;调用方有更准的下一步(「先导入素材」「去设置」)就传进来。
 */
export function failureText(action: string, error: unknown, next = "再试一次"): string {
  return `${action}没成功:${describeError(error)}。${next}`;
}
