/**
 * ワールド座標の点を画面（CSS ピクセル）へ投影する。DOM と three.js に依存しない。
 * `viewProjection` は「射影行列 × カメラのワールド逆行列」の要素（three.js の `Matrix4.elements`、列優先の 16 要素）。
 */

export type Vec3 = [number, number, number];

export interface ScreenPoint {
  /** 画面上の位置（CSS ピクセル、左上が原点）。カメラの後ろ（`inFront` が false）では意味を持たない。 */
  x: number;
  y: number;
  /** カメラの前方への距離（遠近射影のクリップ座標の w）。 */
  depth: number;
  /** カメラの前にあるか（depth > 0）。 */
  inFront: boolean;
}

/** これ以下の奥行きは「カメラの後ろ（または真横）」として扱う。 */
export const MIN_DEPTH = 1e-6;

export function projectPoint(viewProjection: ArrayLike<number>, p: Vec3, width: number, height: number): ScreenPoint {
  const m = viewProjection;
  const x = p[0], y = p[1], z = p[2];
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (!(cw > MIN_DEPTH)) return { x: NaN, y: NaN, depth: cw, inFront: false };
  return {
    x: (cx / cw * 0.5 + 0.5) * width,
    y: (0.5 - cy / cw * 0.5) * height,
    depth: cw,
    inFront: true,
  };
}

export type Visibility = 'ok' | 'behind' | 'offscreen';

/** 投影した点が表示できるか。カメラの後ろは 'behind'、画面の外（`margin` ピクセル内側の矩形の外）は 'offscreen'。 */
export function screenVisibility(pt: ScreenPoint, width: number, height: number, margin = 0): Visibility {
  if (!pt.inFront) return 'behind';
  if (!(pt.x >= margin && pt.x <= width - margin && pt.y >= margin && pt.y <= height - margin)) return 'offscreen';
  return 'ok';
}
