/**
 * ピッキングの番号の符号化と、読み出した小領域から点を選ぶ処理（描画に依存しない部分）。
 *
 * 点 index の番号は index + 1 で、RGBA8 の R・G・B に下位から8ビットずつ入れる（A は 255）。
 * 番号 0 は「点なし」。符号化はシェーダ（src/render/shaders.ts の PICKING）と一致させる。
 */

/** 符号化できる点の数の上限（番号は 1..2^24-1）。 */
export const MAX_PICKABLE = 0xffffff;

export function encodePickId(index: number): [number, number, number, number] {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PICKABLE) throw new RangeError(`符号化できない番号です: ${index}`);
  const id = index + 1;
  return [id & 255, (id >> 8) & 255, (id >> 16) & 255, 255];
}

/** RGBA8 の画素から点の番号を返す。点がなければ -1。 */
export function decodePickId(r: number, g: number, b: number): number {
  return (r | (g << 8) | (b << 16)) - 1;
}

/** 小領域の読み出し結果と、その位置。 */
export interface PickRegion {
  /** readPixels の結果（RGBA8、下の行から） */
  pixels: Uint8Array;
  /** 領域の1辺（画素）。カーソルの画素が中央 (radius, radius) に来る */
  size: number;
  /** 領域の左上の画素の、描画バッファ上の位置（上が 0） */
  x0: number;
  y0: number;
  /** 描画バッファの大きさ。範囲外の画素は選ばない */
  bufferWidth: number;
  bufferHeight: number;
}

/**
 * 領域の中央（カーソルの画素）から radius 画素以内で、最も近い点のある画素を選ぶ。
 * 距離が同じ画素が複数あるときは、上の行・左の列を優先する（結果を決定的にするため）。
 */
export function selectNearest(region: PickRegion, radius: number): { index: number; distance: number } | null {
  const { pixels, size, x0, y0, bufferWidth, bufferHeight } = region;
  const c = (size - 1) / 2;
  const r2 = radius * radius;
  let best = -1;
  let bestD2 = Infinity;
  for (let j = 0; j < size; j++) {
    const by = y0 + j;
    if (by < 0 || by >= bufferHeight) continue;
    const row = size - 1 - j; // readPixels は下の行から
    for (let i = 0; i < size; i++) {
      const bx = x0 + i;
      if (bx < 0 || bx >= bufferWidth) continue;
      const d2 = (i - c) * (i - c) + (j - c) * (j - c);
      if (d2 > r2 || d2 >= bestD2) continue;
      const o = 4 * (row * size + i);
      const index = decodePickId(pixels[o]!, pixels[o + 1]!, pixels[o + 2]!);
      if (index < 0) continue;
      best = index;
      bestD2 = d2;
    }
  }
  return best < 0 ? null : { index: best, distance: Math.sqrt(bestD2) };
}
