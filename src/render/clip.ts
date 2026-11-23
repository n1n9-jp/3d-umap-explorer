/**
 * カメラの位置に応じた近接・遠方のクリップ面。
 *
 * 深度バッファの分解能は近接面までの距離にほぼ比例する（透視投影の深度は 1/z に線形）。近接面を固定の小さな値に
 * すると、点群の外から全体を見るときに奥行きの分解能が粗くなる。点はすべて点群を含む球（manifest の bounds）の
 * 中にあるので、カメラから点までの距離は「球の中心までの距離 − 半径」以上、「＋ 半径」以下に収まる。
 *
 * - 近接面：球の手前の表面までの距離の半分（内部や表面の近くでは minNear）。ビルボードはビュー空間で
 *   カメラに正対させるので、四角形の奥行きは点の中心の奥行きと同じで、表面より手前には出ない。
 * - 遠方面：球の奥の表面までの距離に余裕を持たせた値。データの半径によらず全体が描画範囲に入る。
 */
export interface ClipPlanes {
  near: number;
  far: number;
}

/** 点群の内部での近接面。密な領域の最近傍点間距離（0.003〜0.01 程度）より十分小さくする。 */
export const MIN_NEAR = 0.0005;

export function clipPlanesForCamera(distanceToCenter: number, cloudRadius: number, minNear: number = MIN_NEAR): ClipPlanes {
  const d = Number.isFinite(distanceToCenter) ? Math.max(0, distanceToCenter) : 0;
  const r = Number.isFinite(cloudRadius) && cloudRadius > 0 ? cloudRadius : 1;
  const near = Math.max(minNear, 0.5 * (d - r));
  const far = Math.max((d + r) * 1.1, near * 4);
  return { near, far };
}
