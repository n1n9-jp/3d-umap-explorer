/**
 * 周囲の点の疎密に応じて、飛行速度に掛ける係数（`FlyCameraControls.speedScale`）を決める。
 * DOM と three.js に依存しない純粋な計算で、カメラ操作への組み込みは `CameraRig` が受け持つ。
 *
 * 1. 距離: カメラの位置から近い順に k 点（k は manifest の `density.k`、MNIST では 8）までの距離の平均。
 *    最近傍 1 点ではなく平均にするのは、孤立した 1 点のそばを通るたびに係数が急変するのを防ぐため。
 *    各点の距離は飽和距離（係数が上限になる距離）で頭打ちにしてから平均する。点が k 個なくても、
 *    索引が点を返さなくても（足りない分を飽和距離とみなす）、位置に対して連続な値になる。
 *    進行方向の先（現在の速度で `lookaheadSeconds` 後の位置）でも同じ距離を求め、小さいほうを採用する。
 *    クラスタへ入る手前から減速できる。
 * 2. 係数: 距離に比例させ、下限と上限で頭打ちにする。`scale = clamp(d / referenceDistance, min, max)`。
 *    `referenceDistance = REFERENCE_MULTIPLIER × density.knnDistP50`。基準をデータセットの密度で決めるので、
 *    座標の尺度や点数が違うデータセットでも同じ式で働く。
 * 3. 平滑化: 係数の対数 L を、目標の対数 T へ `dL/dt = clamp((T − L) / τ, −R, R)` で近づける
 *    （目標から遠いうちは一定の速さ R、近づくと時定数 τ の指数応答）。減速（T < L）は τ・R を速く、
 *    加速は遅くする。目標が一定の間はこの微分方程式を厳密に解くので、フレームレートに依らない。
 */

/** x, y, z を持つもの（three.js の Vector3 もそのまま渡せる）。 */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 近傍検索（`SpatialIndex` がそのまま当てはまる）。 */
export interface NeighborIndex {
  kNearest(x: number, y: number, z: number, k: number, maxDistance?: number): { distances: ArrayLike<number> };
}

/** manifest の `density` のうち使う部分。 */
export interface DensityReference {
  k: number;
  knnDistP50: number;
}

/** 係数の対数の応答（減速・加速で別に持つ）。 */
export interface LogResponse {
  /** 目標の近くでの指数応答の時定数（秒）。 */
  timeConstant: number;
  /** 対数の変化の速さの上限（1 秒あたり、自然対数で）。 */
  maxRate: number;
}

export interface AutoSpeedParams {
  /** 距離の平均に使う近傍の点数。 */
  k: number;
  /** 係数が 1 になる距離（座標の単位）。 */
  referenceDistance: number;
  minScale: number;
  maxScale: number;
  /** 進行方向の先を見る時間（秒）。 */
  lookaheadSeconds: number;
  /** 係数を下げるとき（減速）。 */
  decel: LogResponse;
  /** 係数を上げるとき（加速）。 */
  accel: LogResponse;
}

/**
 * `referenceDistance` を `knnDistP50` の何倍にするか。
 * カメラの位置からの 8 近傍の平均距離は、クラスタの内部で、近くの点どうしの最近傍距離の約 1.2〜2.3 倍
 * （MNIST の実測）。既定の速度 0.15 で、実速度 = 0.15 × d / (6 × 0.0157) ≈ 1.6 × d [単位/秒] となり、
 * 1 秒あたり点の間隔の約 2〜4 倍進む。
 */
export const REFERENCE_MULTIPLIER = 6;

export const AUTO_SPEED_DEFAULTS: Omit<AutoSpeedParams, 'k' | 'referenceDistance'> = {
  // 下限は、点が重なるほど密な場所でも止まってしまわないため。MNIST の最も密な場所（d ≈ 0.006）の係数 ≈ 0.064 より下。
  minScale: 0.05,
  // 上限は、点群の外の何もない空間で既定の速度の 4 倍（0.6 単位/秒。点群の端から端まで約 4 秒）。
  maxScale: 4,
  lookaheadSeconds: 0.3,
  // 減速: 0.1 秒で目標へ寄せ、最大で 1 秒あたり e^6 ≈ 400 倍の割合で下げる（係数 4 → 0.1 に約 0.6 秒）。
  decel: { timeConstant: 0.1, maxRate: 6 },
  // 加速: 0.6 秒で目標へ寄せ、最大で 1 秒あたり e^1.2 ≈ 3.3 倍の割合で上げる（係数 0.1 → 4 に約 3 秒）。
  accel: { timeConstant: 0.6, maxRate: 1.2 },
};

/**
 * manifest の `density` から係数の計算の設定を作る。`density` がない・値が不正なときは null
 * （自動調整を使わず、係数は 1 のまま）。
 */
export function autoSpeedParams(
  density: DensityReference | undefined | null,
  overrides: Partial<Omit<AutoSpeedParams, 'k' | 'referenceDistance'>> = {},
): AutoSpeedParams | null {
  if (!density) return null;
  const { k, knnDistP50 } = density;
  if (!Number.isInteger(k) || k < 1 || !Number.isFinite(knnDistP50) || knnDistP50 <= 0) return null;
  return { ...AUTO_SPEED_DEFAULTS, ...overrides, k, referenceDistance: REFERENCE_MULTIPLIER * knnDistP50 };
}

/** 係数が上限になる距離。これより遠い点は、この距離にあるものとして扱う。 */
export function saturationDistance(params: AutoSpeedParams): number {
  return params.referenceDistance * params.maxScale;
}

/**
 * (x, y, z) から近い順に k 点までの距離の平均。各距離は `cap` で頭打ちにし、
 * `cap` 以内に k 点ないときは足りない分を `cap` とみなす（点が 1 つもなければ `cap`）。
 */
export function neighborDistance(index: NeighborIndex, x: number, y: number, z: number, k: number, cap: number): number {
  const { distances } = index.kNearest(x, y, z, k, cap);
  const n = Math.min(distances.length, k);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = distances[i] as number;
    sum += d < cap ? d : cap; // NaN も cap 扱い
  }
  return (sum + (k - n) * cap) / k;
}

/** 距離から目標の係数へ。距離に比例し、`minScale`〜`maxScale` で頭打ち。距離が NaN なら上限。 */
export function scaleForDistance(distance: number, params: AutoSpeedParams): number {
  const s = distance / params.referenceDistance;
  if (!(s < params.maxScale)) return params.maxScale;
  return s > params.minScale ? s : params.minScale;
}

/**
 * 係数を、目標へ `dt` 秒ぶん近づける（対数の領域で `dL/dt = clamp((T − L) / τ, −R, R)` を厳密に解く）。
 * `dt` が正の有限値でない、または値が正の有限値でないときは `current` を返す。
 */
export function smoothScale(current: number, target: number, dt: number, params: Pick<AutoSpeedParams, 'decel' | 'accel'>): number {
  if (!(dt > 0) || !Number.isFinite(dt) || !(current > 0) || !Number.isFinite(current) || !(target > 0) || !Number.isFinite(target)) {
    return current;
  }
  const L = Math.log(current);
  const T = Math.log(target);
  const e = T - L;
  if (e === 0) return current;
  const { timeConstant: tau, maxRate: rate } = e < 0 ? params.decel : params.accel;
  const sign = e < 0 ? -1 : 1;
  let gap = Math.abs(e);
  const knee = rate * tau; // これより遠いうちは速さの上限で動く
  const tLinear = gap > knee ? (gap - knee) / rate : 0;
  if (dt <= tLinear) {
    gap -= rate * dt;
  } else {
    gap = Math.min(gap, knee) * Math.exp(-(dt - tLinear) / tau);
  }
  return Math.exp(T - sign * gap);
}

export interface AutoSpeedInput {
  /** カメラの位置。 */
  position: Vec3Like;
  /** カメラの速度（単位/秒）。進行方向の先を見るのに使う。 */
  velocity: Vec3Like;
  /** 前回からの経過時間（秒）。 */
  dt: number;
}

/**
 * 係数の計算の状態（平滑化した係数と、採用した距離）。毎フレーム `update` を呼び、返す係数を
 * `speedScale` へ設定する。
 */
export class AutoSpeed {
  readonly params: AutoSpeedParams;
  private readonly index: NeighborIndex;
  private _scale = 1;
  private _target = 1;
  private _distance: number | null = null;
  /** 次の `update` で、平滑化せずに目標へそろえる。 */
  private snap = true;

  constructor(index: NeighborIndex, params: AutoSpeedParams) {
    this.index = index;
    this.params = params;
  }

  /** 平滑化した係数（正の有限値）。 */
  get scale(): number {
    return this._scale;
  }

  /** 平滑化する前の目標の係数。 */
  get targetScale(): number {
    return this._target;
  }

  /** 最後に採用した距離（現在地と進行方向の先の小さいほう）。まだ求めていなければ null。 */
  get distance(): number | null {
    return this._distance;
  }

  /**
   * 次の `update` で平滑化せずに目標の係数へそろえる。カメラが止まっている瞬間（瞬間移動の直後や
   * モードの切り替え）に使う。
   */
  reset(): void {
    this.snap = true;
  }

  /** 係数を `scale` にして、そこから平滑化を続ける（自動調整を有効に戻したときなど）。 */
  continueFrom(scale: number): void {
    if (Number.isFinite(scale) && scale > 0) this._scale = scale;
    this.snap = false;
  }

  /** 距離を求めて係数を更新し、新しい係数を返す。位置が有限でなければ何も変えない。 */
  update({ position: p, velocity: v, dt }: AutoSpeedInput): number {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return this._scale;
    const { k, lookaheadSeconds } = this.params;
    const cap = saturationDistance(this.params);
    let d = neighborDistance(this.index, p.x, p.y, p.z, k, cap);
    const ax = v.x * lookaheadSeconds, ay = v.y * lookaheadSeconds, az = v.z * lookaheadSeconds;
    if (Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(az) && (ax !== 0 || ay !== 0 || az !== 0)) {
      const ahead = neighborDistance(this.index, p.x + ax, p.y + ay, p.z + az, k, cap);
      if (ahead < d) d = ahead;
    }
    this._distance = d;
    this._target = scaleForDistance(d, this.params);
    if (this.snap) {
      this._scale = this._target;
      this.snap = false;
    } else {
      this._scale = smoothScale(this._scale, this._target, dt, this.params);
    }
    return this._scale;
  }
}
