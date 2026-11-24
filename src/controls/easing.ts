/**
 * カメラの自動移動（点・塊へ飛ぶ、ホームへ戻る、ミニマップのクリック）の緩急と所要時間。
 * DOM にも three.js にも依存しない。
 */

/** 向きを合わせ終える進みの割合。着く前に対象を捉え終える。 */
export const FLIGHT_ORIENT_END = 0.7;
/** 「動きを減らす」設定（`prefers-reduced-motion: reduce`）での所要時間の倍率。 */
export const REDUCED_MOTION_DURATION_FACTOR = 0.5;

/**
 * 引き継ぐ速度の上限（移動の距離 L に対する比）。`T·|v0| ≤ FLIGHT_CARRY_LIMIT·L` までを引き継ぎの項 `T·v0·t(1−t)⁴` で引き継ぐ。
 * 引き継ぎの形 `t(1−t)⁴` と合わせて、進む方向の成分が終点を越えず（5 まで）、終点までの距離が近づき始めたあとに離れない。
 * 後者は、真横に近い v0 で √12 ≈ 3.46 が境目（飛び始めは、緩急で近づく距離 6·L·t² より、横へ進む距離 T·|v0|·t のほうが
 * 終点までの距離を伸ばす: (T·|v0|)² > 12·L² で離れる）なので、少し下の 3.4 とする。この項による横向きの膨らみは
 * `0.08192 × 3.4 ≈ 0.279·L` まで。上限を超えた分の速度は、捨てずに、指数で減らす項（`flightExcess`）で引き継ぐ。
 */
export const FLIGHT_CARRY_LIMIT = 3.4;

/** 引き継ぎの上限を超えた分の速度を減らす、指数の時定数（秒）。移動の距離に対して大きすぎる分は、これより短くする（`flightExcessTimeConstant`）。 */
export const FLIGHT_EXCESS_TIME_CONSTANT = 0.12;

/**
 * 上限を超えた分の速度 w が進める距離の上限（移動の距離 L に対する比）。指数の項の変位は `|w|·τ` を超えないので、
 * `|w|·τ ≤ FLIGHT_EXCESS_LIMIT·k·L` となるように τ を縮める。k は、w が終点へ近づく向き（進む方向となす角 θ が 90° 未満）なら
 * cos θ、そうでなければ 1。0.4 なら、引き継ぎの項（上限 3.4）と合わせても、進む方向の成分が終点を越えず、
 * 近づき始めたら離れない（L 0.02〜3、|v0| 0.1〜2、θ 0°〜180° で確かめた）。近づく向きで cos θ を掛けるのは、
 * 横向きの速さが近づく速さを上回って、近づき始めたあとに離れないようにするため（真横の少し手前では、超えた分はすぐ消える）。
 * 終点から離れる向き（θ ≥ 90°）では、離れている間は近づき始めていないので、そのまま 0.4·L まで許す。
 */
export const FLIGHT_EXCESS_LIMIT = 0.4;

/**
 * 上限を超えた分の速度の大きさ `excessSpeed` を減らす時定数（秒）。`min(0.12, 0.4·k·L / excessSpeed)`（k は
 * `FLIGHT_EXCESS_LIMIT` の説明のとおり。`cosAngle` は w と進む方向のなす角の余弦）。減らす分がない、または L が 0 なら 0
 * （その分は引き継がない）。
 */
export function flightExcessTimeConstant(excessSpeed: number, travel: number, cosAngle: number): number {
  if (!(excessSpeed > 0) || !(travel > 0) || !Number.isFinite(excessSpeed + travel + cosAngle)) return 0;
  const k = cosAngle > 0 ? Math.min(1, cosAngle) : 1;
  return Math.min(FLIGHT_EXCESS_TIME_CONSTANT, (FLIGHT_EXCESS_LIMIT * k * travel) / excessSpeed);
}

/**
 * 上限を超えた分の速度 w の項の形。位置へ `w·h` として足す（秒の単位。`h = τ·(1 − e^(−s/τ))·(1 − f(t))`、
 * s = t·T は経過秒、f は `flightEase`）。h(0) = 0、dh/ds(0) = 1（飛び始めの速度が w のぶん v0 に一致する）、
 * h(1) = 0 と dh/ds(1) = 0（終わりの位置と速度に寄与しない）。0 ≤ h ≤ τ。範囲外と τ ≤ 0 は 0。
 */
export function flightExcess(t: number, durationSeconds: number, tau: number): number {
  if (!(t > 0 && t < 1) || !(tau > 0) || !(durationSeconds > 0)) return 0;
  return tau * -Math.expm1((-t * durationSeconds) / tau) * (1 - flightEase(t));
}

/** `flightExcess` の経過秒 s についての導関数 `e^(−s/τ)·(1 − f(t)) − τ·(1 − e^(−s/τ))·f′(t) / T`（t ≤ 0 は 1、t ≥ 1 は 0）。 */
export function flightExcessDerivative(t: number, durationSeconds: number, tau: number): number {
  if (!(tau > 0) || !(durationSeconds > 0) || !(t < 1)) return 0;
  if (!(t > 0)) return 1;
  const x = (-t * durationSeconds) / tau;
  return Math.exp(x) * (1 - flightEase(t)) + tau * Math.expm1(x) * (flightEaseDerivative(t) / durationSeconds);
}

/**
 * 引き継ぎの形 `g(t) = t(1−t)⁴`。位置へ `T·v0·g(t)` として足す。g(0)=g(1)=0、g′(0)=1（t=0 で速度が v0）、g′(1)=0。
 * 終わりで (1−t)⁴ と、緩急の残り `1−f(t) ≈ 4(1−t)³` より速く 0 に近づく。最大は t=1/5 で 0.08192。範囲外は 0。
 */
export function flightCarry(t: number): number {
  if (!(t > 0 && t < 1)) return 0;
  const u = 1 - t;
  return t * u * u * u * u;
}

/** `flightCarry` の導関数 `(1−t)³(1−5t)`（t ≤ 0 は 1、t ≥ 1 は 0）。 */
export function flightCarryDerivative(t: number): number {
  if (!(t < 1)) return 0;
  if (!(t > 0)) return 1;
  const u = 1 - t;
  return u * u * u * (1 - 5 * t);
}

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
