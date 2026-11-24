/**
 * カメラの自動移動（点・塊へ飛ぶ、ホームへ戻る、ミニマップのクリック）の緩急と所要時間。
 * DOM にも three.js にも依存しない。
 */

/** 向きを合わせ終える進みの割合。着く前に対象を捉え終える。 */
export const FLIGHT_ORIENT_END = 0.7;
/** 「動きを減らす」設定（`prefers-reduced-motion: reduce`）での所要時間の倍率。 */
export const REDUCED_MOTION_DURATION_FACTOR = 0.5;

/** 所要時間の倍率の下限・上限（基準の所要時間に対する比）。 */
export const FLIGHT_DURATION_MIN_FACTOR = 0.8;
export const FLIGHT_DURATION_MAX_FACTOR = 1.8;
/** 倍率が 0.8 + 0.25 を超え始める距離の目安（点群の半径に対する比）。 */
const FLIGHT_DISTANCE_UNIT = 0.25;

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/**
 * 飛行の緩急 `f(t) = 1 − (1−t)³(1+3t)`（0〜1）。f(0)=0、f(1)=1 で、始めと終わりの速さが 0。
 * 速さ `f′(t) = 12·t·(1−t)²` の山は t = 1/3（短く出て、長く減速して止まる）。範囲外は端に丸める。
 */
export function flightEase(t: number): number {
  const x = clamp01(t);
  const u = 1 - x;
  return 1 - u * u * u * (1 + 3 * x);
}

/** `flightEase` の導関数 `12·t·(1−t)²`（範囲外は 0）。 */
export function flightEaseDerivative(t: number): number {
  if (!(t > 0 && t < 1)) return 0;
  const u = 1 - t;
  return 12 * t * u * u;
}

/**
 * 移動の距離 `distance` と点群の半径 `radius` から、基準の所要時間 `base` を伸縮した所要時間（`base` と同じ単位）。
 * `T = clamp(base × (0.8 + 0.25 × log2(1 + d / (0.25 R))), base × 0.8, base × 1.8)`。
 * 近い移動は少し短く、遠い移動は長くなる。`radius` が正の有限値でなければ、伸縮せず `base` のまま。
 */
export function scaledFlightDuration(base: number, distance: number, radius: number | null | undefined): number {
  if (!(base > 0) || !Number.isFinite(base)) return Math.max(0, Number.isFinite(base) ? base : 0);
  if (radius === null || radius === undefined || !(radius > 0) || !Number.isFinite(radius)) return base;
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0;
  const factor = 0.8 + 0.25 * Math.log2(1 + d / (FLIGHT_DISTANCE_UNIT * radius));
  return base * Math.min(FLIGHT_DURATION_MAX_FACTOR, Math.max(FLIGHT_DURATION_MIN_FACTOR, factor));
}

/** 動きを減らす設定のときの所要時間（`reduced` が false ならそのまま）。 */
export function reducedFlightDuration(duration: number, reduced: boolean): number {
  return reduced ? duration * REDUCED_MOTION_DURATION_FACTOR : duration;
}
