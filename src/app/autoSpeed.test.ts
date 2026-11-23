import { describe, expect, it } from 'vitest';
import { SpatialIndex } from '../spatial/SpatialIndex';
import {
  AUTO_SPEED_DEFAULTS,
  AutoSpeed,
  REFERENCE_MULTIPLIER,
  autoSpeedParams,
  neighborDistance,
  saturationDistance,
  scaleForDistance,
  smoothScale,
  type AutoSpeedParams,
  type NeighborIndex,
} from './autoSpeed';

const MNIST_DENSITY = { k: 8, knnDistP05: 0.008562, knnDistP50: 0.015665, knnDistP95: 0.028776 };
const params = autoSpeedParams(MNIST_DENSITY) as AutoSpeedParams;
const zero = { x: 0, y: 0, z: 0 };

/** 原点のまわりに、間隔 `spacing` の立方格子で n×n×n 点を置く。 */
function grid(n: number, spacing: number, offset = { x: 0, y: 0, z: 0 }): Float32Array {
  const out = new Float32Array(n * n * n * 3);
  const h = ((n - 1) * spacing) / 2;
  let o = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    out[o++] = i * spacing - h + offset.x;
    out[o++] = j * spacing - h + offset.y;
    out[o++] = k * spacing - h + offset.z;
  }
  return out;
}

/** 決まった距離の列を返すだけの索引。 */
const fixedIndex = (distances: number[]): NeighborIndex => ({
  kNearest: (_x, _y, _z, k, maxDistance = Infinity) => ({ distances: Float32Array.from(distances.filter((d) => d <= maxDistance).slice(0, k)) }),
});
const emptyIndex: NeighborIndex = { kNearest: () => ({ distances: new Float32Array(0) }) };

describe('autoSpeedParams', () => {
  it('density の k と knnDistP50 から基準距離を決める', () => {
    expect(params.k).toBe(8);
    expect(params.referenceDistance).toBeCloseTo(REFERENCE_MULTIPLIER * 0.015665, 12);
    expect(params.minScale).toBe(AUTO_SPEED_DEFAULTS.minScale);
    expect(params.maxScale).toBe(AUTO_SPEED_DEFAULTS.maxScale);
  });

  it('density がない・不正なときは null（係数を 1 のままにする）', () => {
    expect(autoSpeedParams(undefined)).toBeNull();
    expect(autoSpeedParams(null)).toBeNull();
    expect(autoSpeedParams({ k: 0, knnDistP50: 0.01 })).toBeNull();
    expect(autoSpeedParams({ k: 8, knnDistP50: 0 })).toBeNull();
    expect(autoSpeedParams({ k: 8, knnDistP50: Number.NaN })).toBeNull();
    expect(autoSpeedParams({ k: 2.5, knnDistP50: 0.01 })).toBeNull();
  });

  it('基準距離はデータセットの尺度に比例する（座標を 10 倍にすると 10 倍）', () => {
    const big = autoSpeedParams({ k: 8, knnDistP50: 0.15665 }) as AutoSpeedParams;
    expect(big.referenceDistance / params.referenceDistance).toBeCloseTo(10, 9);
    expect(saturationDistance(big) / saturationDistance(params)).toBeCloseTo(10, 9);
  });
});

describe('scaleForDistance（距離から係数への写像）', () => {
  it('距離に比例する（基準距離で 1）', () => {
    const r = params.referenceDistance;
    expect(scaleForDistance(r, params)).toBeCloseTo(1, 12);
    expect(scaleForDistance(0.5 * r, params)).toBeCloseTo(0.5, 12);
    expect(scaleForDistance(2 * r, params)).toBeCloseTo(2, 12);
  });

  it('下限と上限で頭打ちになる', () => {
    expect(scaleForDistance(0, params)).toBe(params.minScale);
    expect(scaleForDistance(1e-9, params)).toBe(params.minScale);
    expect(scaleForDistance(saturationDistance(params) * 1.0001, params)).toBe(params.maxScale);
    expect(scaleForDistance(1e9, params)).toBe(params.maxScale);
    expect(scaleForDistance(Infinity, params)).toBe(params.maxScale);
    expect(scaleForDistance(Number.NaN, params)).toBe(params.maxScale);
  });

  it('MNIST の密度で、密な領域では小さく、何もない空間では既定の数倍', () => {
    // 密な領域（8 近傍の平均 ≈ knnDistP05）では、既定の速度 0.45 の実速度が約 0.066 単位/秒
    const dense = scaleForDistance(MNIST_DENSITY.knnDistP05, params);
    expect(dense).toBeGreaterThan(0.08);
    expect(dense).toBeLessThan(0.15);
    expect(scaleForDistance(0.5, params)).toBe(4);
  });
});

describe('neighborDistance', () => {
  it('近い順に k 点までの距離の平均', () => {
    expect(neighborDistance(fixedIndex([1, 2, 3, 4, 5]), 0, 0, 0, 4, 100)).toBeCloseTo(2.5, 6);
  });

  it('cap より遠い点と足りない点は cap とみなす', () => {
    expect(neighborDistance(fixedIndex([1, 2]), 0, 0, 0, 4, 3)).toBeCloseTo((1 + 2 + 3 + 3) / 4, 6);
    expect(neighborDistance(fixedIndex([1, 2, 5, 6]), 0, 0, 0, 4, 3)).toBeCloseTo((1 + 2 + 3 + 3) / 4, 6);
  });

  it('空間索引が点を返さないときは cap（係数は上限）', () => {
    expect(neighborDistance(emptyIndex, 0, 0, 0, 8, 0.4)).toBe(0.4);
    const empty = new SpatialIndex(new Float32Array(0));
    expect(neighborDistance(empty, 0, 0, 0, 8, 0.4)).toBe(0.4);
  });

  it('SpatialIndex と組み合わせて、格子の中心で隣の点までの距離に近い値になる', () => {
    const idx = new SpatialIndex(grid(9, 0.01));
    // 格子点の間（立方体の中心）では、8 近傍はすべて √3/2 × 間隔
    const d = neighborDistance(idx, 0.005, 0.005, 0.005, 8, 1);
    expect(d).toBeCloseTo((Math.sqrt(3) / 2) * 0.01, 6);
  });
});

describe('smoothScale（対数の領域での平滑化）', () => {
  it('目標が一定なら目標へ単調に近づき、行き過ぎない', () => {
    let s = 4;
    let prev = s;
    for (let i = 0; i < 200; i++) {
      s = smoothScale(s, 0.1, 1 / 60, params);
      expect(s).toBeLessThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(0.1);
      prev = s;
    }
    expect(s).toBeCloseTo(0.1, 6);
  });

  it('減速は速く、加速はゆっくり（同じ倍率の変化で比べる）', () => {
    const step = (from: number, to: number, seconds: number) => {
      let s: number = from;
      for (let i = 0; i < seconds * 60; i++) s = smoothScale(s, to, 1 / 60, params);
      return s;
    };
    // 0.5 秒後に、対数で残っている差の割合
    const downLeft = Math.log(step(4, 0.1, 0.5) / 0.1) / Math.log(4 / 0.1);
    const upLeft = Math.log(4 / step(0.1, 4, 0.5)) / Math.log(4 / 0.1);
    expect(downLeft).toBeLessThan(0.25);
    expect(upLeft).toBeGreaterThan(0.6);
    // 目標の 1.1 倍以内に入るまでの時間
    const timeTo = (from: number, to: number) => {
      let s = from, t = 0;
      while (Math.abs(Math.log(s / to)) > Math.log(1.1)) { s = smoothScale(s, to, 1 / 120, params); t += 1 / 120; }
      return t;
    };
    expect(timeTo(0.1, 4)).toBeGreaterThan(3 * timeTo(4, 0.1));
  });

  it('対数の変化の速さが上限を超えない', () => {
    for (const [from, to] of [[4, 0.05], [0.05, 4]] as const) {
      const rate = to < from ? params.decel.maxRate : params.accel.maxRate;
      let s: number = from;
      for (let i = 0; i < 400; i++) {
        const next = smoothScale(s, to, 0.01, params);
        expect(Math.abs(Math.log(next / s)) / 0.01).toBeLessThanOrEqual(rate * (1 + 1e-9));
        s = next;
      }
    }
  });

  it('フレームレートに依らない（目標が一定なら、刻み方によらず同じ値）', () => {
    for (const [from, to] of [[4, 0.1], [0.1, 4], [1, 0.9], [1, 1.2]] as const) {
      for (const total of [0.05, 0.3, 1, 2.5]) {
        const run = (fps: number) => {
          let s: number = from;
          const n = Math.max(1, Math.round(total * fps));
          for (let i = 0; i < n; i++) s = smoothScale(s, to, total / n, params);
          return s;
        };
        const ref = run(240);
        expect(run(30)).toBeCloseTo(ref, 9);
        expect(run(7)).toBeCloseTo(ref, 9);
        expect(smoothScale(from, to, total, params)).toBeCloseTo(ref, 9);
      }
    }
  });

  it('dt や値が不正なら変えない', () => {
    expect(smoothScale(2, 1, 0, params)).toBe(2);
    expect(smoothScale(2, 1, -1, params)).toBe(2);
    expect(smoothScale(2, 1, Number.NaN, params)).toBe(2);
    expect(smoothScale(2, 1, Infinity, params)).toBe(2);
    expect(smoothScale(2, Number.NaN, 0.1, params)).toBe(2);
    expect(smoothScale(2, 0, 0.1, params)).toBe(2);
  });
});

describe('AutoSpeed', () => {
  // 原点のまわりに間隔 0.005 の密な塊を置き、+x 方向の遠くから近づく
  const cluster = new SpatialIndex(grid(11, 0.005));

  it('最初の update は目標へそろえ、以降は平滑化する', () => {
    const a = new AutoSpeed(cluster, params);
    expect(a.distance).toBeNull();
    expect(a.update({ position: { x: 2, y: 0, z: 0 }, velocity: zero, dt: 0.016 })).toBe(params.maxScale);
    const s = a.update({ position: { x: 0, y: 0, z: 0 }, velocity: zero, dt: 0.016 });
    expect(s).toBeLessThan(params.maxScale);
    expect(s).toBeGreaterThan(a.targetScale);
    a.reset();
    expect(a.update({ position: { x: 0, y: 0, z: 0 }, velocity: zero, dt: 0.016 })).toBe(a.targetScale);
  });

  it('進行方向の先が密なら、先の距離を採用する（クラスタの手前から減速する）', () => {
    const pos = { x: 0.2, y: 0, z: 0 };
    const still = new AutoSpeed(cluster, params);
    still.update({ position: pos, velocity: zero, dt: 0.016 });
    const toward = new AutoSpeed(cluster, params);
    toward.update({ position: pos, velocity: { x: -0.5, y: 0, z: 0 }, dt: 0.016 }); // 0.3 秒後に x = 0.05
    const away = new AutoSpeed(cluster, params);
    away.update({ position: pos, velocity: { x: 0.5, y: 0, z: 0 }, dt: 0.016 });
    expect(toward.distance as number).toBeLessThan((still.distance as number) * 0.5);
    expect(away.distance).toBeCloseTo(still.distance as number, 9);
    expect(toward.targetScale).toBeLessThan(still.targetScale);
  });

  it('先読みの距離は実測の速度に比例する（速度が 3 倍なら、3 倍遠くまで見る）', () => {
    const pos = { x: 0.4, y: 0, z: 0 };
    const dist = (velocity: { x: number; y: number; z: number }, at = pos) => {
      const a = new AutoSpeed(cluster, params);
      a.update({ position: at, velocity, dt: 0.016 });
      return a.distance as number;
    };
    const v = { x: -0.3, y: 0, z: 0 }; // 0.3 秒で 0.09 進む。先は x = 0.31 で、まだ塊の外
    const v3 = { x: -0.9, y: 0, z: 0 }; // 3 倍の速度なら 0.27 進む。先は x = 0.13
    expect(dist(v)).toBeCloseTo(dist(zero, { x: 0.4 - 0.3 * params.lookaheadSeconds, y: 0, z: 0 }), 9);
    expect(dist(v3)).toBeCloseTo(dist(zero, { x: 0.4 - 0.9 * params.lookaheadSeconds, y: 0, z: 0 }), 9);
    expect(dist(v3)).toBeLessThan(dist(v));
  });

  it('空間索引が点を返さないときは上限、density がないときは使わない', () => {
    const a = new AutoSpeed(emptyIndex, params);
    expect(a.update({ position: zero, velocity: zero, dt: 0.016 })).toBe(params.maxScale);
    expect(a.distance).toBe(saturationDistance(params));
    expect(autoSpeedParams(undefined)).toBeNull();
  });

  it('位置が有限でないときは何も変えない', () => {
    const a = new AutoSpeed(cluster, params);
    a.update({ position: { x: 2, y: 0, z: 0 }, velocity: zero, dt: 0.016 });
    expect(a.update({ position: { x: Number.NaN, y: 0, z: 0 }, velocity: zero, dt: 0.016 })).toBe(params.maxScale);
  });

  it('continueFrom で、その係数から平滑化を続ける', () => {
    const a = new AutoSpeed(cluster, params);
    a.continueFrom(1);
    const s = a.update({ position: { x: 2, y: 0, z: 0 }, velocity: zero, dt: 0.1 });
    expect(s).toBeGreaterThan(1);
    expect(s).toBeLessThan(1.2); // 加速は 1 秒あたり e^1.2 倍まで
  });

  it('近づく飛行のシミュレーションで、外では上限、塊の中では小さく、変化は上限の速さ以内', () => {
    const a = new AutoSpeed(cluster, params);
    const speed = 0.45;
    let x = 1.5, v = 0, prev = NaN;
    for (let i = 0; i < 6000 && x > 0; i++) {
      const dt = 1 / 60;
      const s = a.update({ position: { x, y: 0.0025, z: 0.0025 }, velocity: { x: -v, y: 0, z: 0 }, dt });
      if (i === 0) expect(s).toBe(params.maxScale);
      if (i > 0) expect(Math.abs(Math.log(s / prev)) / dt).toBeLessThanOrEqual(params.decel.maxRate * (1 + 1e-9));
      prev = s;
      // FlyMotion と同じ時定数 0.12 秒で速度が追従する
      v += (speed * s - v) * (1 - Math.exp(-dt / 0.12));
      x -= v * dt;
    }
    expect(x).toBeLessThanOrEqual(0); // 塊の中心まで進む
    expect(a.scale).toBeLessThan(0.2);
  });
});
