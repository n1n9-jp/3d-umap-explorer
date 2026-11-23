/**
 * カメラの位置に応じた霧の範囲。
 *
 * 点群の内部にいるときは interior の値をそのまま使う。外にいるときは、点群の手前側の
 * 表面までの距離だけ霧の開始を遠ざけ、俯瞰でも手前のクラスタが霧に埋もれないようにする。
 */
export function fogForCamera(
  distanceToCenter: number,
  cloudRadius: number,
  interior: [number, number, number],
): [number, number, number] {
  const outside = Math.max(0, distanceToCenter - cloudRadius);
  const [start, range, max] = interior;
  // 外では霧の深さも点群の大きさに合わせて伸ばす（奥側の半分が少し沈む程度）
  const t = Math.min(1, outside / cloudRadius);
  const outsideRange = cloudRadius * 1.6;
  return [start + outside, range + (outsideRange - range) * t, max];
}
