/**
 * ダブルクリックで点へ飛ぶときに、点の手前で止まる距離を決める。DOM と three.js に依存しない。
 *
 *   d = clamp(spacingFactor × 近傍の平均距離, 最小, 最大)
 *
 * - 近傍の平均距離 m: その点から近い `k` 点（自分を除く）までの距離の平均。点の周りの間隔の目安。
 *   近傍の点が視線から約 atan(1 / spacingFactor) の範囲に入る（既定 2.5 で約 22°。縦の視野の半分 30° より内側）
 *   ので、点とその周りが一緒に見える。密な場所では近く、疎な場所では遠くに止まる。
 * - 最大: 点が画面上で `minPixels`（描画バッファのピクセル）以上に見える距離。
 *   画面上の大きさは pointSize × pxPerUnitAtUnitDepth / d（シェーダと同じ式）なので、d ≤ pointSize × pxPerUnitAtUnitDepth / minPixels。
 * - 最小: 近接フェードが始まる距離（nearFadeFactors[1] × pointSize）の `fadeMargin` 倍。点が薄れずに見える。
 * 最大が最小を下回る（画面が極端に小さい・点が極端に小さい）ときは、消えないことを優先して最小を使う。
 */

export interface StopDistanceInput {
  /** その点から近傍の点までの距離（自分自身は含めない）。 */
  neighborDistances: ArrayLike<number>;
  /** 点の大きさ（ワールド単位、PointCloudParams.pointSize） */
  pointSize: number;
  /** 近接フェードが始まる距離の pointSize に対する倍率（PointCloudParams.nearFadeFactors[1]） */
  nearFadeStartFactor: number;
  /** 奥行き 1 の位置での、ワールド 1 単位あたりの描画バッファのピクセル数（0.5 × 高さ × projectionMatrix[1][1]） */
  pxPerUnitAtUnitDepth: number;
  /** 画面上でこの大きさ以上に見せる（描画バッファのピクセル）。 */
  minPixels: number;
  /** 近傍の平均距離に掛ける倍率。既定 2.5 */
  spacingFactor?: number;
  /** 近接フェードの始まる距離に対する余裕。既定 1.5 */
  fadeMargin?: number;
}

export interface StopDistance {
  distance: number;
  /** 近傍の平均距離（近傍がなければ null） */
  meanNeighborDistance: number | null;
  minDistance: number;
  maxDistance: number;
}

export function computeStopDistance(input: StopDistanceInput): StopDistance {
  const spacing = input.spacingFactor ?? 2.5;
  const margin = input.fadeMargin ?? 1.5;
  const minDistance = margin * input.nearFadeStartFactor * input.pointSize;
  const maxDistance = input.minPixels > 0 ? (input.pointSize * input.pxPerUnitAtUnitDepth) / input.minPixels : Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < input.neighborDistances.length; i++) {
    const d = input.neighborDistances[i]!;
    if (Number.isFinite(d) && d > 0) { sum += d; n++; }
  }
  const mean = n > 0 ? sum / n : null;
  // 近傍がない（点が 1 つだけなど）ときは、見える範囲で最も遠い距離
  const wanted = mean === null ? maxDistance : spacing * mean;
  let distance = Math.min(maxDistance, Math.max(minDistance, wanted));
  if (maxDistance < minDistance) distance = minDistance;
  if (!Number.isFinite(distance)) distance = minDistance;
  return { distance, meanNeighborDistance: mean, minDistance, maxDistance };
}
