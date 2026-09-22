export interface BandSelection { keys: readonly string[]; anchor: string | null }
export interface Point { x: number; y: number }
export interface KeyRect { key: string; left: number; top: number; right: number; bottom: number }

export function selectBandKey(
  current: BandSelection, order: readonly string[], key: string,
  modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
): BandSelection {
  if (!order.includes(key)) return { keys: [], anchor: null };
  const additive = modifiers.metaKey || modifiers.ctrlKey;
  if (modifiers.shiftKey && current.anchor && order.includes(current.anchor)) {
    const a = order.indexOf(current.anchor), b = order.indexOf(key);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return { keys: additive ? [...new Set([...current.keys, ...range])] : range, anchor: current.anchor };
  }
  return {
    keys: additive ? current.keys.includes(key) ? current.keys.filter(item => item !== key) : [...current.keys, key] : [key],
    anchor: key,
  };
}

export function keysInBox(a: Point, b: Point, rectangles: readonly KeyRect[]): string[] {
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  return rectangles.filter(rect => rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom).map(rect => rect.key);
}
