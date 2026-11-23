/**
 * 暗い背景の上で区別しやすいラベル10色。色覚の多様性（1型・2型・3型色覚）に配慮している。
 *
 * - 通常の色覚と、1型・2型・3型の模擬（Machado ら 2009、重度 1.0）のどれでも、
 *   どの2色の CIELAB 色差 ΔE76 も 20 以上（テストで 12 以上を保証）。
 * - 背景（BACKGROUND_COLOR）とのコントラスト比（WCAG）はすべて 6 以上（テストで 4.5 以上を保証）。
 * - 通常の色覚で、赤・橙・黄・黄緑・緑・水色・青・紫・桃・白と名前で呼び分けられるよう、色相を散らしている。
 *
 * 選び方：Okabe-Ito の配色（橙・黄・青緑・空色・青・赤紫）の考え方を参考に、色相を9個の帯に割り当て、
 * 暗い背景で見える明度（L* 60 以上）と彩度の下限を課したうえで、4種の見え方すべてでの最小の ΔE が
 * 最大になるよう焼きなまし法で探索した（Okabe-Ito や Paul Tol の色そのものではない）。9色が有彩色、1色（白）が無彩色。
 */
export const LABEL_COLORS: readonly string[] = [
  '#ff565b', // 0 赤
  '#f38320', // 1 橙
  '#fcdd22', // 2 黄
  '#a5e692', // 3 黄緑
  '#1bbf87', // 4 緑
  '#02eaff', // 5 水色
  '#3c91fc', // 6 青
  '#b67acb', // 7 紫
  '#fa90c8', // 8 桃
  '#fafef8', // 9 白
];

export const BACKGROUND_COLOR = '#07080c';

/** '#rrggbb' を 0..1 の sRGB 値にする。 */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) throw new Error(`色の形式が不正です: ${hex}`);
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** n 個のラベル色を返す（10色を超える分は繰り返す）。 */
export function labelColors(n: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) out.push(hexToRgb(LABEL_COLORS[i % LABEL_COLORS.length] as string));
  return out;
}
