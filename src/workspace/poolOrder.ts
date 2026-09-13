/**
 * 媒体池当前可见顺序的一份只读快照(R11 §3「播完自动下一条」)。媒体池每次算完可见
 * 列表就写进来;监视器播到尾时按它找下一条。不进 WorkspaceStore —— 这份列表随筛选 /
 * 搜索 / 虚拟化每次重算,塞进 store 会让所有订阅者跟着重渲染。
 */
let order: readonly number[] = [];

export function setPoolOrder(ids: readonly number[]): void {
  order = ids;
}

export function getPoolOrder(): readonly number[] {
  return order;
}

/** 当前素材在可见顺序里的下一条;末尾或不在列表里 → null(末尾停,规格 §3)。 */
export function nextPoolClipId(currentId: number): number | null {
  const index = order.indexOf(currentId);
  if (index < 0 || index + 1 >= order.length) return null;
  return order[index + 1] ?? null;
}

export function __resetPoolOrderForTests(): void {
  order = [];
}
