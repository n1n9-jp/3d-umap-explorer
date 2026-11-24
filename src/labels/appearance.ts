/** 距離に応じた目印の見せ方。DOM に依存しない。 */

export interface AppearanceParams {
  /** この距離以下では、最も大きく濃く見せる。 */
  near: number;
  /** この距離以上では、最も小さく薄く見せる。 */
  far: number;
  /** 最も遠いときの大きさの倍率（既定 0.75）。 */
  minScale?: number;
  /** 最も遠いときの不透明度（既定 0.6）。 */
  minOpacity?: number;
}

export interface Appearance {
  /** 0..1。0 が近く、1 が遠い。 */
  t: number;
  scale: number;
  opacity: number;
}

/**
 * `t = clamp((距離 − near) / (far − near), 0, 1)` として、大きさと不透明度を線形に下げる。
 *
 *   scale   = 1 − (1 − minScale)   × t
 *   opacity = 1 − (1 − minOpacity) × t
 *
 * 全体が見える視点（点群の半径 R の約 2〜3 倍離れる）でも読めるよう、最小は 0.75 倍・不透明度 0.6 にとどめる。
 */
export function labelAppearance(distance: number, params: AppearanceParams): Appearance {
  const minScale = params.minScale ?? 0.75;
  const minOpacity = params.minOpacity ?? 0.6;
  const span = params.far - params.near;
  const raw = span > 0 ? (distance - params.near) / span : distance > params.near ? 1 : 0;
  const t = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
  return { t, scale: 1 - (1 - minScale) * t, opacity: 1 - (1 - minOpacity) * t };
}

/** 点群を含む球の半径 R から、近い・遠いの基準距離を決める（0.6 R と 3 R）。 */
export function appearanceParamsForBounds(boundsRadius: number): AppearanceParams {
  return { near: 0.6 * boundsRadius, far: 3 * boundsRadius };
}

/**
 * カメラがいずれかのクラスタの内部にいるときの、ほかのクラスタの目印の見せ方の倍率。
 * 内部で読みたいのは近くの単語や点なので、遠くのクラスタの目印は小さく薄くして、方向の手がかりにとどめる。
 */
export const INSIDE_SCALE = 0.85;
export const INSIDE_OPACITY = 0.6;

/** クラスタの内部にいるときの見せ方（`labelAppearance` の結果に倍率を掛ける）。 */
export function insideAppearance(a: Appearance): Appearance {
  return { t: a.t, scale: a.scale * INSIDE_SCALE, opacity: a.opacity * INSIDE_OPACITY };
}

/**
 * 内部の見せ方の度合い（0: 外、1: 内部）。カメラから最も近いクラスタの中心までの距離 ÷ 半径（`minRatio`）で決め、
 * `enterRatio` 以下で 1、`exitRatio` 以上で 0、その間は線形。内部へ入る・出る判定（location.ts）の幅と同じ範囲で、
 * 目印の大きさと不透明度が連続して変わる（境界をまたぐ瞬間に、出ている目印が一度に小さく薄くなったり戻ったりしない）。
 */
export function insideBlend(minRatio: number, enterRatio: number, exitRatio: number): number {
  if (!(minRatio < exitRatio)) return 0;
  if (!(minRatio > enterRatio)) return 1;
  return (exitRatio - minRatio) / (exitRatio - enterRatio);
}

/** `labelAppearance` の結果に、内部の見せ方を `blend`（0..1）の度合いで掛ける。0 なら `a` のまま、1 なら `insideAppearance(a)`。 */
export function blendInsideAppearance(a: Appearance, blend: number): Appearance {
  const k = Math.min(1, Math.max(0, blend));
  return { t: a.t, scale: a.scale * (1 - k * (1 - INSIDE_SCALE)), opacity: a.opacity * (1 - k * (1 - INSIDE_OPACITY)) };
}
