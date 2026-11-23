import { describe, expect, it } from 'vitest';
import {
  alignAndNormalize, applyTransform, meanDisplacement, normalizePositions, procrustes, svd3, symmetricEigen3, type Mat3,
} from './align';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cloud(n: number, seed = 1): Float64Array {
  const r = rng(seed);
  const p = new Float64Array(3 * n);
  // 3 軸で広がりの違う点群（主軸が一意に決まる）
  for (let i = 0; i < n; i++) { p[3 * i] = (r() - 0.5) * 4; p[3 * i + 1] = (r() - 0.5) * 2; p[3 * i + 2] = (r() - 0.5) * 1; }
  return p;
}

/** 軸 u のまわりに角度 a の回転 */
function rotation(u: [number, number, number], a: number): Mat3 {
  const l = Math.hypot(...u);
  const [x, y, z] = u.map((v) => v / l) as [number, number, number];
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

describe('normalizePositions', () => {
  it('バウンディングボックスの中心を原点、絶対値の最大を 1 にする（等方スケール）', () => {
    const p = new Float32Array([1, 2, 3, 5, 4, 3, 3, 3, 7]);
    const q = normalizePositions(p);
    // 中心 (3, 3, 5)、最大の絶対値 2（x と z）
    expect([...q]).toEqual([-1, -0.5, -1, 1, 0.5, -1, 0, 0, 1]);
  });

  it('事前計算の座標（正規化済み）はほぼそのまま', () => {
    const p = cloud(500);
    const q = normalizePositions(normalizePositions(p));
    const once = normalizePositions(p);
    let maxAbs = 0;
    for (let i = 0; i < q.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(q[i]!));
      expect(Math.abs(q[i]! - once[i]!)).toBeLessThan(1e-6);
    }
    expect(maxAbs).toBeCloseTo(1, 6);
  });
});

describe('symmetricEigen3 と svd3', () => {
  it('固有値分解を降順に返し、A v = λ v', () => {
    const A: Mat3 = [4, 1, 0.5, 1, 3, 0.2, 0.5, 0.2, 1];
    const { values, vectors } = symmetricEigen3(A);
    expect(values[0]).toBeGreaterThan(values[1]);
    expect(values[1]).toBeGreaterThan(values[2]);
    for (let k = 0; k < 3; k++) {
      const v = vectors[k];
      for (let i = 0; i < 3; i++) {
        const av = A[3 * i]! * v[0] + A[3 * i + 1]! * v[1] + A[3 * i + 2]! * v[2];
        expect(av).toBeCloseTo(values[k] * v[i], 10);
      }
    }
  });

  it('H = U S Vᵀ を復元する（階数が落ちた行列でも U は直交）', () => {
    for (const H of [[1, 2, 3, 4, 5, 6, 7, 8, 10], [1, 2, 3, 2, 4, 6, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0, 1]] as Mat3[]) {
      const { U, S, V } = svd3(H);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let h = 0;
        for (let k = 0; k < 3; k++) h += U[i]![k]! * S[k]! * V[j]![k]!;
        expect(h).toBeCloseTo(H[3 * i + j]!, 9);
        let uu = 0;
        for (let k = 0; k < 3; k++) uu += U[k]![i]! * U[k]![j]!;
        expect(uu).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    }
  });
});

describe('procrustes', () => {
  it('回転・反転・拡大縮小・平行移動した点群から、元の変換を求める', () => {
    const x = cloud(800, 3);
    for (const reflect of [false, true]) {
      const R = rotation([0.3, -1, 0.5], 2.1);
      if (reflect) for (let i = 0; i < 3; i++) R[3 * i + 1] = -R[3 * i + 1]!; // y を反転してから回す
      const y = applyTransform(x, { R, s: 0.37, t: [1.5, -2, 0.25], reflection: reflect });
      const tr = procrustes(x, y);
      expect(tr.reflection).toBe(reflect);
      expect(tr.s).toBeCloseTo(0.37, 9);
      for (let k = 0; k < 9; k++) expect(tr.R[k]).toBeCloseTo(R[k]!, 9);
      const z = applyTransform(x, tr);
      expect(meanDisplacement(z, y)).toBeLessThan(1e-9);
    }
  });

  it('雑音があっても、位置合わせをすると平均の移動量が小さくなる', () => {
    const x = cloud(1000, 5);
    const r = rng(9);
    const R = rotation([1, 1, 0], 1.2);
    const y = applyTransform(x, { R, s: 1, t: [0, 0, 0], reflection: false });
    for (let i = 0; i < y.length; i++) y[i] = y[i]! + (r() - 0.5) * 0.1;
    const target = normalizePositions(y);
    const raw = normalizePositions(x);
    const aligned = alignAndNormalize(x, target);
    expect(meanDisplacement(aligned, target)).toBeLessThan(0.05);
    expect(meanDisplacement(aligned, target)).toBeLessThan(meanDisplacement(raw, target) / 5);
    // 合わせたあとも正規化されている
    let maxAbs = 0;
    for (const v of aligned) maxAbs = Math.max(maxAbs, Math.abs(v));
    expect(maxAbs).toBeCloseTo(1, 6);
  });
});
