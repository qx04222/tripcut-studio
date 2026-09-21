import { useState, type JSX } from "react";

import { SELECT_PROMPT_PLACEHOLDER } from "../selectPrompt";

/** AX 名(新名)。 */
export const PROMPT_INPUT_NAME = "一句话挑片";

/**
 * R19 P-01:一句话挑片的输入行 —— 自动挑选面板顶部与结果面板顶部共用。Enter 提交,空句不提交;
 * 提交后清空(结果面板那份用来「再挑一次」)。解析在 `selectPrompt.ts`,这里只收句子。
 */
export function PromptInput({ busy = false, onSubmit, placeholder = SELECT_PROMPT_PLACEHOLDER }: {
  busy?: boolean;
  onSubmit(sentence: string): void;
  placeholder?: string;
}): JSX.Element {
  const [value, setValue] = useState("");
  const submit = () => {
    const sentence = value.trim();
    if (sentence.length === 0 || busy) return;
    onSubmit(sentence);
    setValue("");
  };
  return (
    <div className="band-autoselect-prompt">
      <input
        type="text"
        aria-label={PROMPT_INPUT_NAME}
        placeholder={placeholder}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
    </div>
  );
}
