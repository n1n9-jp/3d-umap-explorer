/**
 * カメラの位置に応じた近接・遠方のクリップ面。
 *
 * 深度バッファの分解能は近接面までの距離にほぼ比例する（透視投影の深度は 1/z に線形）。近接面を固定の小さな値に
 * すると、点群の外から全体を見るときに奥行きの分解能が粗くなる。点はすべて点群を含む球（manifest の bounds）の
 * 中にあるので、カメラから点までの距離は「球の中心までの距離 − 半径」以上、「＋ 半径」以下に収まる。
 *
 * - 近接面：視錐台の内側にある点の奥行き（視線方向の距離）の下限に、余裕（NEAR_MARGIN）を掛けた値。
 *   点の奥行きは「カメラからの距離 × cos(視線からの角度)」で、視線からの角度は画面の隅の方向で最大になる
 *   （縦の視野角と縦横比から決まる）。したがって奥行きは「(中心までの距離 − 半径) × cos(隅の角度)」以上。
 *   縦横比が大きいほど隅の角度が開き、この下限は小さくなる（縦の視野角 60° で縦横比が約 2.8 を超えると隅は 60° を超える）。
 *   内部や表面の近くでは minNear。ビルボードはビュー空間でカメラに正対させるので、四角形の奥行きは点の中心の奥行きと
 *   同じで、表面より手前には出ない。
 * - 遠方面：球の奥の表面までの距離に余裕を持たせた値。データの半径によらず全体が描画範囲に入る。
 */
export interface ClipPlanes {
  near: number;
  far: number;
}

/** 点群の内部での近接面。密な領域の最近傍点間距離（0.003〜0.01 程度）より十分小さくする。 */
export const MIN_NEAR = 0.0005;

/**
 * 近接面に掛ける余裕。視錐台のすぐ外にある点のビルボード（大きさを持つ）が、画面の端で近接面に切られないようにする。
 */
export const NEAR_MARGIN = 0.8;

/** カメラの視野：縦の視野角（度）と縦横比（幅 / 高さ）。 */
export interface ViewShape {
  fovDeg: number;
  aspect: number;
}

/** 画面の隅の方向と視線のなす角の cos（＝隅の方向の単位ベクトルの奥行き成分）。 */
export function cornerCos(view: ViewShape): number {
  const fov = Number.isFinite(view.fovDeg) && view.fovDeg > 0 && view.fovDeg < 180 ? view.fovDeg : 60;
  const aspect = Number.isFinite(view.aspect) && view.aspect > 0 ? view.aspect : 1;
  const tv = Math.tan((fov * Math.PI) / 360);
  const th = tv * aspect;
  return 1 / Math.sqrt(1 + tv * tv + th * th);
}

export function clipPlanesForCamera(distanceToCenter: number, cloudRadius: number, view: ViewShape, minNear: number = MIN_NEAR): ClipPlanes {
  const d = Number.isFinite(distanceToCenter) ? Math.max(0, distanceToCenter) : 0;
  const r = Number.isFinite(cloudRadius) && cloudRadius > 0 ? cloudRadius : 1;
  const near = Math.max(minNear, NEAR_MARGIN * cornerCos(view) * (d - r));
  const far = Math.max((d + r) * 1.1, near * 4);
  return { near, far };
}
