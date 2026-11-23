/** クラスタの目印をクリックして飛ぶときの、クラスタの中心からの距離。DOM に依存しない。 */

/** クラスタの球が視野に収まる距離に掛ける余裕 */
export const FLY_MARGIN = 1.15;

/**
 * クラスタを半径 `radius` の球とみなし、その球が画面（縦の視野角 `verticalFovDeg`、縦横比 `aspect`）に収まる距離。
 *
 *   D = margin × radius / sin(min(縦の半視野角, 横の半視野角))
 *
 * 球を見込む半角 asin(radius / D) が視野の半角と一致する距離が `radius / sin(半視野角)` で、
 * 縦と横のうち狭いほうに合わせる（縦長の画面でも収まる）。`radius` は manifest ではクラスタの点の 90 パーセンタイルの距離なので、
 * 点の大半が収まる。
 */
export function clusterViewDistance(radius: number, verticalFovDeg: number, aspect: number, margin = FLY_MARGIN): number {
  const v = (verticalFovDeg * Math.PI) / 360;
  const h = Math.atan(Math.tan(v) * (aspect > 0 ? aspect : 1));
  const half = Math.min(v, h);
  return (margin * radius) / Math.sin(half);
}
