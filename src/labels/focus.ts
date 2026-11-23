/** キーボードのフォーカスがある目印が出なくなるときの、フォーカスの移し先。DOM に依存しない。 */

/**
 * `order`（Tab の順）で、フォーカス中の目印の次にある、出ている目印の id。末尾からは先頭へ戻る。
 * 出ている目印がほかになければ null（フォーカスは外す）。
 */
export function focusFallback(order: readonly number[], visible: ReadonlySet<number>, focusedId: number): number | null {
  const start = order.indexOf(focusedId);
  if (start < 0) return null;
  for (let k = 1; k < order.length; k++) {
    const id = order[(start + k) % order.length]!;
    if (id !== focusedId && visible.has(id)) return id;
  }
  return null;
}
