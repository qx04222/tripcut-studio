/**
 * 最小模态栈 —— 只回答一个问题:"我是不是最上面那层?"
 *
 * 抽屉和命令面板各自在 document 上挂了 Esc 监听。两条监听挂在**同一个**节点上,
 * `stopPropagation()` 管不到彼此(那要 `stopImmediatePropagation`,而它又依赖
 * 注册顺序——注册顺序恰恰是挂载顺序,不受控)。结果是命令面板压在抽屉上时按一下
 * Esc 两层一起关。改成入栈:每层打开时 push 一个自己的 token,Esc 只有在
 * `isTopModal(token)` 为真时才响应。
 */
const stack: object[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

export function pushModal(token: object): void {
  if (stack.includes(token)) return;
  stack.push(token);
  notify();
}

export function popModal(token: object): void {
  const index = stack.indexOf(token);
  if (index === -1) return;
  stack.splice(index, 1);
  notify();
}

/**
 * 栈每次真的变化(push 新 token / pop 在栈里的 token)后通知一次。监视器用它
 * 决定原生视频视图要不要藏起来:原生 NSView 永远画在 WKWebView 之上,覆盖层
 * (popover / 抽屉 / 命令面板 / 帮助)一开就会被视频盖住(R9 实机 D1)。
 * 监听器在通知时读到的已是变化后的栈。返回退订函数。
 */
export function subscribeModalStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 栈里还有没有模态层。壳的全局 Esc 用它决定「这一下轮不轮得到我」。 */
export function isAnyModalOpen(): boolean {
  return stack.length > 0;
}

export function isTopModal(token: object): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

export function __resetModalStackForTests(): void {
  stack.length = 0;
  listeners.clear();
}
