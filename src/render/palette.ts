/**
 * 暗い背景の上で区別しやすいラベル10色。
 * 色相を一周させつつ、隣り合う色相（青と紫、橙と黄など）は明度も変えて見分けやすくしている。
 */
export const LABEL_COLORS: readonly string[] = [
  '#ff5a5a', // 0 赤
  '#ff9d2e', // 1 橙
  '#ffe45c', // 2 黄
  '#8fe04a', // 3 黄緑
  '#2fd9b5', // 4 青緑
  '#4fa8ff', // 5 青
  '#a98bff', // 6 紫
  '#ff6fd0', // 7 桃
  '#f0f0f0', // 8 白
  '#c79a6b', // 9 茶
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
