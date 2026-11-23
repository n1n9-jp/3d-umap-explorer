/**
 * 計算した座標の後処理（正規化と、前の座標への位置合わせ）。DOM と WebGL に依存しない。
 *
 * - 正規化: 事前計算（scripts/precompute/build_dataset.py の normalize）と同じ。バウンディングボックスの中心を原点に移し、
 *   等方スケールで絶対値の最大を 1 にする。計算は倍精度で行い、Float32 で返す。
 * - 位置合わせ（Procrustes）: 新しい座標 X を、表示中の座標 Y に、回転・反転・等方の拡大縮小・平行移動で最もよく
 *   合わせる（Σ‖s R xᵢ + t − yᵢ‖² を最小にする R（直交行列。反転を含む）・s・t）。点の番号は同じなので、対応は既知。
 *   UMAP の結果は、パラメータや乱数の種を変えると、全体の向きが任意に回ったり裏返ったりするので、
 *   これで地図の向きを前の表示にそろえる。合わせたあとに、正規化をかけ直す。
 */

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** 事前計算と同じ正規化。 */
export function normalizePositions(p: ArrayLike<number>): Float32Array {
  const n = Math.floor(p.length / 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = p[3 * i + a] as number;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  const c = [0, 1, 2].map((a) => (min[a]! + max[a]!) / 2);
  let m = 0;
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = Math.abs((p[3 * i + a] as number) - c[a]!);
      if (v > m) m = v;
    }
  }
  const out = new Float32Array(3 * n);
  const d = m > 0 ? m : 1; // すべての点が同じ位置なら、平行移動だけ
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) out[3 * i + a] = ((p[3 * i + a] as number) - c[a]!) / d;
  }
  return out;
}

/** 対称な 3×3 行列の固有値分解（Jacobi 法）。固有値の降順に、固有値と固有ベクトル（列）を返す。 */
export function symmetricEigen3(a: Mat3): { values: [number, number, number]; vectors: [[number, number, number], [number, number, number], [number, number, number]] } {
  const A = [[a[0], a[1], a[2]], [a[3], a[4], a[5]], [a[6], a[7], a[8]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 64; sweep++) {
    const off = A[0]![1]! ** 2 + A[0]![2]! ** 2 + A[1]![2]! ** 2;
    const scale = A[0]![0]! ** 2 + A[1]![1]! ** 2 + A[2]![2]! ** 2;
    if (off <= 1e-30 * Math.max(scale, 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = A[p]![q]!;
      if (Math.abs(apq) < 1e-300) continue;
      const app = A[p]![p]!, aqq = A[q]![q]!;
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k]![p]!, akq = A[k]![q]!;
        A[k]![p] = c * akp - s * akq;
        A[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p]![k]!, aqk = A[q]![k]!;
        A[p]![k] = c * apk - s * aqk;
        A[q]![k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k]![p]!, vkq = V[k]![q]!;
        V[k]![p] = c * vkp - s * vkq;
        V[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => A[j]![j]! - A[i]![i]!);
  const values = order.map((i) => A[i]![i]!) as [number, number, number];
  const vectors = order.map((i) => [V[0]![i]!, V[1]![i]!, V[2]![i]!]) as [[number, number, number], [number, number, number], [number, number, number]];
  return { values, vectors };
}

const cross = (a: number[], b: number[]): [number, number, number] =>
  [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const norm3 = (a: number[]) => Math.hypot(a[0]!, a[1]!, a[2]!);

/**
 * 3×3 行列 H の特異値分解 H = U diag(S) Vᵀ。S は降順。U と V は直交行列（列が特異ベクトル）。
 * HᵀH の固有値分解から V と S を求め、U の列を H v / s で求める（s が 0 に近い列は、ほかの列との外積で補う）。
 */
export function svd3(h: Mat3): { U: number[][]; S: [number, number, number]; V: number[][] } {
  const H = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];
  const HtH: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += H[k]![i]! * H[k]![j]!;
    HtH[3 * i + j] = s;
  }
  const { values, vectors } = symmetricEigen3(HtH);
  const S = values.map((v) => Math.sqrt(Math.max(0, v))) as [number, number, number];
  const vcols = vectors; // vcols[k] は k 番目の右特異ベクトル
  const ucols: number[][] = [];
  const tol = Math.max(S[0], 1e-300) * 1e-12;
  for (let k = 0; k < 3; k++) {
    const v = vcols[k]!;
    const hv = [0, 1, 2].map((i) => H[i]![0]! * v[0] + H[i]![1]! * v[1] + H[i]![2]! * v[2]);
    const l = norm3(hv);
    if (S[k]! > tol && l > 0) ucols.push(hv.map((x) => x / l));
    else ucols.push([NaN, NaN, NaN]);
  }
  // 特異値が 0 に近い列を補う（直交の基底にする）
  if (Number.isNaN(ucols[0]![0]!)) ucols[0] = [1, 0, 0];
  if (Number.isNaN(ucols[1]![0]!)) {
    const a = ucols[0]!;
    const trial = Math.abs(a[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const c = cross(a, trial);
    const l = norm3(c);
    ucols[1] = c.map((x) => x / l);
  }
  if (Number.isNaN(ucols[2]![0]!)) ucols[2] = cross(ucols[0]!, ucols[1]!);
  const U = [0, 1, 2].map((i) => [ucols[0]![i]!, ucols[1]![i]!, ucols[2]![i]!]);
  const V = [0, 1, 2].map((i) => [vcols[0]![i]!, vcols[1]![i]!, vcols[2]![i]!]);
  return { U, S, V };
}

export interface SimilarityTransform {
  /** 回転・反転（行優先の 3×3。y = s R x + t） */
  R: Mat3;
  s: number;
  t: [number, number, number];
  /** 反転を含むか（det R < 0） */
  reflection: boolean;
}

/**
 * `source` を `target` に最もよく合わせる相似変換（回転・反転・等方の拡大縮小・平行移動）。
 * どちらも長さ 3N で、点 i どうしが対応する。
 */
export function procrustes(source: ArrayLike<number>, target: ArrayLike<number>): SimilarityTransform {
  const n = Math.floor(source.length / 3);
  if (target.length !== source.length) throw new RangeError('source と target の長さが一致しません');
  const mx = [0, 0, 0], my = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
    mx[a]! += source[3 * i + a] as number;
    my[a]! += target[3 * i + a] as number;
  }
  for (let a = 0; a < 3; a++) { mx[a]! /= n; my[a]! /= n; }
  // 相互共分散 C = Σ (y − ȳ)(x − x̄)ᵀ と、x の散らばり Σ ‖x − x̄‖²
  const C: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const x0 = (source[3 * i] as number) - mx[0]!, x1 = (source[3 * i + 1] as number) - mx[1]!, x2 = (source[3 * i + 2] as number) - mx[2]!;
    const y0 = (target[3 * i] as number) - my[0]!, y1 = (target[3 * i + 1] as number) - my[1]!, y2 = (target[3 * i + 2] as number) - my[2]!;
    C[0] += y0 * x0; C[1] += y0 * x1; C[2] += y0 * x2;
    C[3] += y1 * x0; C[4] += y1 * x1; C[5] += y1 * x2;
    C[6] += y2 * x0; C[7] += y2 * x1; C[8] += y2 * x2;
    sxx += x0 * x0 + x1 * x1 + x2 * x2;
  }
  // C = U S Vᵀ のとき、R = U Vᵀ（反転を許す）、s = ΣS / Σ‖x − x̄‖²
  const { U, S, V } = svd3(C);
  const R: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let v = 0;
    for (let k = 0; k < 3; k++) v += U[i]![k]! * V[j]![k]!;
    R[3 * i + j] = v;
  }
  const s = sxx > 0 ? (S[0] + S[1] + S[2]) / sxx : 1;
  const t: [number, number, number] = [0, 1, 2].map((i) =>
    my[i]! - s * (R[3 * i]! * mx[0]! + R[3 * i + 1]! * mx[1]! + R[3 * i + 2]! * mx[2]!)) as [number, number, number];
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  return { R, s, t, reflection: det < 0 };
}

/** 相似変換を座標へかける（倍精度で返す）。 */
export function applyTransform(p: ArrayLike<number>, tr: SimilarityTransform): Float64Array {
  const n = Math.floor(p.length / 3);
  const out = new Float64Array(3 * n);
  const { R, s, t } = tr;
  for (let i = 0; i < n; i++) {
    const x = p[3 * i] as number, y = p[3 * i + 1] as number, z = p[3 * i + 2] as number;
    out[3 * i] = s * (R[0] * x + R[1] * y + R[2] * z) + t[0];
    out[3 * i + 1] = s * (R[3] * x + R[4] * y + R[5] * z) + t[1];
    out[3 * i + 2] = s * (R[6] * x + R[7] * y + R[8] * z) + t[2];
  }
  return out;
}

/** `source` を `target` に位置合わせしてから、正規化をかけ直した座標。 */
export function alignAndNormalize(source: ArrayLike<number>, target: ArrayLike<number>): Float32Array {
  return normalizePositions(applyTransform(source, procrustes(source, target)));
}

/** 点ごとの移動量（ユークリッド距離）の平均。 */
export function meanDisplacement(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.floor(a.length / 3);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.hypot((a[3 * i] as number) - (b[3 * i] as number), (a[3 * i + 1] as number) - (b[3 * i + 1] as number), (a[3 * i + 2] as number) - (b[3 * i + 2] as number));
  }
  return n > 0 ? sum / n : 0;
}
