/**
 * R11 简化专项 #5:错误一句话 —— 用户看到的错误文案不带内部代码。
 * 后端(Tauri invoke)抛上来的通常是 `Error: xxx`、有时带 Rust 的 `Os { code: 2, kind: NotFound, … }`、
 * `E_SOMETHING`、`code=…`、堆栈行;这里只留人能读的那一句,再补一句「现在怎么办」。
 */
const INTERNAL_PATTERNS: readonly RegExp[] = [
  /^(Error|TypeError|RangeError|Invoke ?Error)\s*:\s*/i,
  /^[a-z][a-z0-9 _-]*\s(?:failed|error)\s*:\s*/i, // R12 术语 v2 / X-02:后端 CoreError 的英文前缀「rating failed:」「media source verification failed:」
  /\bOs \{[^}]*\}/g,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // E_NOT_FOUND / DEST_UNAVAILABLE 这种常量名
  /\b(?:code|kind|status)\s*[=:]\s*[\w-]+/gi,
  /\s+at\s+\S+\s*\(.*\)$/gm, // 堆栈行
  /\((?:0x)?[0-9a-f]{6,}\)/gi, // 十六进制指针 / 哈希
];

/** 把一个错误值变成一句人能读的话;什么都不剩就退成「出了点问题」。 */
export function describeError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error ?? "");
  // 前缀会套娃(「Error: rating failed: …」),剥到不再变化为止。
  for (let previous = ""; previous !== text; ) {
    previous = text;
    for (const pattern of INTERNAL_PATTERNS) text = text.replace(pattern, "");
  }
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
/**
 * X-02:后端文案常常已经是「原因:下一步」——冒号/分号后面跟「先…」「请…」「或…」「再试」。
 * 这时再追加兜底的「再试一次」就是两句互相打架的建议。
 */
const NEXT_STEP_TAIL = /[:：;；,，]\s*(?:先|请|或|再|去|换|改|把|确认|可以)[^:：;；]*$|再试(?:一次)?$/;

export function hasNextStep(reason: string): boolean {
  return NEXT_STEP_TAIL.test(reason);
}

export function failureText(action: string, error: unknown, next = "再试一次"): string {
  const reason = describeError(error);
  if (hasNextStep(reason)) return `${action}没成功:${reason}`;
  return `${action}没成功:${reason}。${next}`;
}
