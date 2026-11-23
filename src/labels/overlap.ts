/** 画面上で重なる目印を、近いほうを優先して間引く。DOM に依存しない。 */

export interface OverlapItem {
  id: number;
  /** 矩形の中心（CSS ピクセル） */
  x: number;
  y: number;
  /** 矩形の大きさ（拡大縮小を反映した画面上の大きさ） */
  width: number;
  height: number;
  /** カメラからの距離。小さいほど優先 */
  distance: number;
}

/** 2 つの矩形（中心と大きさ）が、間隔 `gap` を含めて重なるか。接するだけなら重ならない。 */
export function rectsOverlap(a: OverlapItem, b: OverlapItem, gap = 0): boolean {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap;
}

/**
 * 近い順（同距離なら id の小さい順）に見て、すでに残った目印と重なるものを隠す。
 * 返すのは残す目印の id の集合。
 */
export function resolveOverlaps(items: readonly OverlapItem[], gap = 4): Set<number> {
  const order = [...items].sort((a, b) => a.distance - b.distance || a.id - b.id);
  const kept: OverlapItem[] = [];
  for (const item of order) {
    if (kept.every((k) => !rectsOverlap(item, k, gap))) kept.push(item);
  }
  return new Set(kept.map((k) => k.id));
}
