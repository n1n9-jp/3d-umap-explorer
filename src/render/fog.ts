/**
 * 点群の内部での霧 [始まる距離, 1-1/e になるまでの距離, 上限]。
 *
 * 上限は、霧で背景色へ溶けたあとでも 10 色のラベルを見分けられる値にする（palette.test.ts で、上限まで溶けた色の
 * 全組の ΔE76 が、通常の色覚と1型・2型・3型の模擬のどれでも 12 以上であることを確かめる）。
 * 上限を下げた分、内部では霧の深さを短くして、近くの点と少し奥の点の差（奥行きの手がかり）を残す。
 */
export const INTERIOR_FOG: [number, number, number] = [0.15, 0.6, 0.4];

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
  // 外では霧の深さを点群の大きさに合わせる（手前の表面から奥の表面まで、上限の 0〜85% ほどの差が付く）
  const t = Math.min(1, outside / cloudRadius);
  const outsideRange = cloudRadius;
  return [start + outside, range + (outsideRange - range) * t, max];
}
