import type { JSX } from "react";

import { formatKey, type KeymapAction } from "./keymap";
import { useKeymap } from "./keymapStore";
import { Kbd } from "./ui";

/**
 * R13 §1:按动作显示键帽 —— 工具条 / 检查器上的 `<Kbd>I</Kbd>` 改成 `<ActionKbd action="mark-in" />`,
 * 键位预设或自定义一变,提示跟着变。动作没绑键时什么都不渲染(按钮照常可点)。
 */
export function ActionKbd({ action }: { action: KeymapAction }): JSX.Element | null {
  const { table } = useKeymap();
  const chord = table[action]?.[0];
  return chord ? <Kbd>{formatKey(chord)}</Kbd> : null;
}

/** 给 `title` / `aria` 这类纯文本位置用:`useActionKey("mark-in")` → "I"。 */
export function useActionKey(action: KeymapAction): string {
  const { table } = useKeymap();
  const chord = table[action]?.[0];
  return chord ? formatKey(chord) : "";
}
