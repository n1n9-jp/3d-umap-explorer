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

/** 重なりの解決に、前のフレームの結果を持ち込むための設定。切り替えに幅を持たせて、ちらつきを防ぐ。 */
export interface OverlapMemory {
  /** 前のフレームで出ていた目印の id */
  shown: ReadonlySet<number>;
  /**
   * 前のフレームでどちらも出ていた 2 つの目印が、出し続けるために保つ最小の間隔。
   * 新しく出すときの間隔（`resolveOverlaps` の `gap`）より小さくして、間隔が閾値の付近で揺れても切り替わらないようにする。
   */
  stayGap: number;
  /** 出ていた目印を、近さの比較で優遇する割合（0.1 なら、距離が 10% 以内の差の相手には譲らない）。既定 0.1 */
  stickiness?: number;
  /** 必ず残す目印の id（キーボードのフォーカスがあるもの） */
  pinned?: number | null;
}

/**
 * 近い順（同距離なら id の小さい順）に見て、すでに残った目印と重なるものを隠す。
 * 返すのは残す目印の id の集合。
 *
 * `memory` を渡すと、前のフレームの結果から切り替わりにくくなる。
 * - 優先は、`pinned` が最初、次に「距離 × (出ていたなら 1 − stickiness、出ていなかったなら 1)」の小さい順。
 *   距離の順位が入れ替わる瞬間にも、出ていたほうが残る（出ていなかったほうが `stickiness` を超えて近くなれば入れ替わる）。
 * - 2 つの目印の間隔は、どちらも前に出ていたなら `stayGap`、そうでなければ `gap` 以上を求める。
 */
export function resolveOverlaps(items: readonly OverlapItem[], gap = 4, memory?: OverlapMemory): Set<number> {
  const sticky = memory?.stickiness ?? 0.1;
  const shown = memory?.shown;
  const rank = (it: OverlapItem): number => {
    if (memory?.pinned === it.id) return -Infinity;
    return shown?.has(it.id) ? it.distance * (1 - sticky) : it.distance;
  };
  const order = [...items].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return (ra === rb ? 0 : ra < rb ? -1 : 1) || a.id - b.id;
  });
  const kept: OverlapItem[] = [];
  for (const item of order) {
    const itemShown = shown?.has(item.id) ?? false;
    const clear = kept.every((k) => {
      const g = memory && itemShown && shown!.has(k.id) ? memory.stayGap : gap;
      return !rectsOverlap(item, k, g);
    });
    if (clear) kept.push(item);
  }
  return new Set(kept.map((k) => k.id));
}
