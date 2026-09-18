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
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+\s*:\s*/, // Z-09:后端的小写错误代码前缀「dest_unavailable:」
  /\s*\(os error \d+\)/gi, // Z-09:Rust io::Error 的括号尾巴
];

/** Z-09 / Z-10:系统层的英文原因 → 一句中文;整段替换,前后的「 : 」也顺手收成中文冒号。 */
const OS_REASONS: ReadonlyArray<[RegExp, string]> = [
  [/\s*:?\s*Permission denied\b/i, ":没有写入权限"],
  [/\s*:?\s*No space left on device\b/i, ":磁盘已满"],
  [/\s*:?\s*Read-only file system\b/i, ":这个磁盘是只读的"],
  [/\s*:?\s*No such file or directory\b/i, ":文件或文件夹不存在"],
  [/\s*:?\s*(?:Operation not permitted|Access is denied)\b/i, ":系统不允许这个操作"],
];

/** 把一个错误值变成一句人能读的话;什么都不剩就退成「出了点问题」。 */
export function describeError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error ?? "");
  // 前缀会套娃(「Error: rating failed: …」),剥到不再变化为止。
  for (let previous = ""; previous !== text; ) {
    previous = text;
    for (const pattern of INTERNAL_PATTERNS) text = text.replace(pattern, "");
    for (const [pattern, chinese] of OS_REASONS) text = text.replace(pattern, chinese);
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

/**
 * R19 U-08:失败文案不说「第 n 步」—— 那是我们的编号,不是剪映的,用户不该先学编号才能读懂错误。
 * 先按已知句式换成动作词(「在第 2 步手动挑几条」→「去媒体池手动挑几条」),再把剩下的「(在)第 n 步」整个去掉。
 */
const STEP_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/在第\s*[2②]\s*步手动挑/g, "去媒体池手动挑"],
  [/回到第\s*[\d①②③④]\s*步/g, "回去"],
  [/[在到]?第\s*[\d①②③④]\s*步[:：]?\s*/g, ""],
];

export function stripStepNumbers(text: string): string {
  let out = text;
  for (const [pattern, replacement] of STEP_PHRASES) out = out.replace(pattern, replacement);
  return out;
}

export function failureText(action: string, error: unknown, next = "再试一次"): string {
  const reason = stripStepNumbers(describeError(error));
  if (hasNextStep(reason)) return `${action}没成功:${reason}`;
  return `${action}没成功:${reason}。${stripStepNumbers(next)}`;
}
