import { describe, expect, it } from 'vitest';
import { SpatialIndex } from './SpatialIndex';

// ---------------------------------------------------------------- テスト用の道具

/** 乱数の種を固定できる乱数生成器（mulberry32）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGaussian(rand: () => number): () => number {
  return () => {
    const u = 1 - rand(); // (0, 1]
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

interface Blob {
  center: [number, number, number];
  sigma: number;
  count: number;
}

interface Dataset {
  positions: Float32Array;
  blobs: Blob[];
}

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

/** 偏りのある合成データ: 大きさの違うガウス塊（非常に密なものを含む）と、まばらな一様ノイズ。 */
function makeClustered(seed: number, n: number): Dataset {
  const rand = mulberry32(seed);
  const gauss = makeGaussian(rand);
  const blobs: Blob[] = [
    { center: [-0.7, -0.6, 0.5], sigma: 0.004, count: Math.floor(n * 0.25) }, // 非常に密
    { center: [0.6, 0.5, -0.6], sigma: 0.02, count: Math.floor(n * 0.3) },
    { center: [0.1, -0.5, -0.7], sigma: 0.05, count: Math.floor(n * 0.2) },
    { center: [-0.4, 0.7, 0.2], sigma: 0.12, count: Math.floor(n * 0.15) },
  ];
  const positions = new Float32Array(3 * n);
  let i = 0;
  for (const b of blobs) {
    for (let c = 0; c < b.count; c++, i++) {
      positions[3 * i] = clamp1(b.center[0] + b.sigma * gauss());
      positions[3 * i + 1] = clamp1(b.center[1] + b.sigma * gauss());
      positions[3 * i + 2] = clamp1(b.center[2] + b.sigma * gauss());
    }
  }
  for (; i < n; i++) {
    positions[3 * i] = rand() * 2 - 1;
    positions[3 * i + 1] = rand() * 2 - 1;
    positions[3 * i + 2] = rand() * 2 - 1;
  }
  return { positions, blobs };
}

// ---------------------------------------------------------------- 総当たりの基準

/** 索引と同じ式の二乗距離（Float32 の値を倍精度で計算）。 */
function dist2(p: Float32Array, i: number, x: number, y: number, z: number): number {
  const dx = x - p[3 * i];
  const dy = y - p[3 * i + 1];
  const dz = z - p[3 * i + 2];
  return dx * dx + dy * dy + dz * dz;
}

interface Hit {
  index: number;
  d2: number;
}

/**
 * 全点のうち、（二乗距離, 添字）の昇順で上位 k 個。
 * k が小さいときは、長さ k の整列済みバッファへの挿入で求める（全点の整列は問い合わせ数が多いと遅いため）。
 * 添字の昇順に走査し、同距離なら後から来た点を後ろに置くので、同距離は添字の小さい順になる。
 */
function bruteTopK(p: Float32Array, x: number, y: number, z: number, k: number): Hit[] {
  const n = p.length / 3;
  const want = Math.min(Math.max(0, Math.floor(k)), n);
  if (want * 16 >= n) {
    const all: Hit[] = [];
    for (let i = 0; i < n; i++) all.push({ index: i, d2: dist2(p, i, x, y, z) });
    all.sort((a, b) => a.d2 - b.d2 || a.index - b.index);
    return all.slice(0, want);
  }
  const buf: Hit[] = [];
  for (let i = 0; i < n; i++) {
    const d2 = dist2(p, i, x, y, z);
    if (buf.length === want && d2 >= buf[want - 1].d2) continue;
    let j = buf.length === want ? want - 1 : buf.length;
    while (j > 0 && buf[j - 1].d2 > d2) {
      buf[j] = buf[j - 1];
      j--;
    }
    buf[j] = { index: i, d2 };
  }
  return buf;
}

function bruteNearest(p: Float32Array, x: number, y: number, z: number, maxDistance = Infinity) {
  const limit = maxDistance * maxDistance;
  const first = bruteTopK(p, x, y, z, 1)[0];
  if (!first || first.d2 > limit) return null;
  return { index: first.index, distance: Math.sqrt(first.d2) };
}

function bruteK(p: Float32Array, x: number, y: number, z: number, k: number, maxDistance = Infinity) {
  const limit = maxDistance * maxDistance;
  const hits = bruteTopK(p, x, y, z, k).filter((h) => h.d2 <= limit);
  return {
    indices: hits.map((h) => h.index),
    distances: hits.map((h) => Math.fround(Math.sqrt(h.d2))),
  };
}

function bruteWithin(p: Float32Array, x: number, y: number, z: number, radius: number): number[] {
  const limit = radius * radius;
  const ids: number[] = [];
  for (let i = 0; i < p.length / 3; i++) if (dist2(p, i, x, y, z) <= limit) ids.push(i);
  return ids;
}

/** 3 つのメソッドを、総当たりの結果と照合する。 */
function expectMatchesBrute(
  index: SpatialIndex,
  p: Float32Array,
  q: [number, number, number],
  k: number,
  maxDistance: number,
  radius: number,
): void {
  const [x, y, z] = q;
  const label = `query=(${x}, ${y}, ${z}) k=${k} maxDistance=${maxDistance} radius=${radius}`;

  expect(index.nearest(x, y, z), `nearest ${label}`).toEqual(bruteNearest(p, x, y, z));
  expect(index.nearest(x, y, z, maxDistance), `nearest(max) ${label}`).toEqual(
    bruteNearest(p, x, y, z, maxDistance),
  );

  for (const md of [undefined, maxDistance]) {
    const got = index.kNearest(x, y, z, k, md);
    const want = bruteK(p, x, y, z, k, md);
    expect(Array.from(got.indices), `kNearest indices ${label} md=${md}`).toEqual(want.indices);
    expect(Array.from(got.distances), `kNearest distances ${label} md=${md}`).toEqual(want.distances);
  }

  expect(Array.from(index.within(x, y, z, radius)), `within ${label}`).toEqual(
    bruteWithin(p, x, y, z, radius),
  );
}

// ---------------------------------------------------------------- 偏りのあるデータ

describe('SpatialIndex（偏りのある合成データ）', () => {
  const N = 4000;
  const { positions, blobs } = makeClustered(12345, N);
  const index = new SpatialIndex(positions);

  it('count が点数と一致する', () => {
    expect(index.count).toBe(N);
  });

  it('無作為の問い合わせ 1000 件で、nearest / kNearest / within が総当たりと一致する', () => {
    const rand = mulberry32(777);
    const gauss = makeGaussian(rand);
    const queries: [number, number, number][] = [];

    // (1) データ点そのものの位置 250 件（距離 0 になる）
    for (let i = 0; i < 250; i++) {
      const id = Math.floor(rand() * N);
      queries.push([positions[3 * id], positions[3 * id + 1], positions[3 * id + 2]]);
    }
    // (2) 密な塊の内部 250 件
    for (let i = 0; i < 250; i++) {
      const b = blobs[Math.floor(rand() * blobs.length)];
      queries.push([
        b.center[0] + b.sigma * gauss(),
        b.center[1] + b.sigma * gauss(),
        b.center[2] + b.sigma * gauss(),
      ]);
    }
    // (3) 塊と塊の間の空白 250 件（どの点からも 0.1 以上離れた位置だけを採る）
    while (queries.length < 750) {
      const q: [number, number, number] = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
      const nn = bruteNearest(positions, q[0], q[1], q[2])!;
      if (nn.distance >= 0.1) queries.push(q);
    }
    // (4) 立方体の外側 250 件（最大で 5 の距離まで）
    while (queries.length < 1000) {
      const q: [number, number, number] = [rand() * 10 - 5, rand() * 10 - 5, rand() * 10 - 5];
      if (Math.max(Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2])) > 1) queries.push(q);
    }

    const ks = [1, 2, 5, 16, 64];
    const radii = [0.004, 0.02, 0.1, 0.5, 3];
    const maxDistances = [0.003, 0.03, 0.2, 1, 8];
    queries.forEach((q, i) => {
      expectMatchesBrute(
        index,
        positions,
        q,
        ks[i % ks.length],
        maxDistances[(i >> 1) % maxDistances.length],
        radii[(i >> 2) % radii.length],
      );
    });
  });

  it('空白（どの点からも遠い位置）で、maxDistance が届かなければ null を返す', () => {
    // 立方体の遠い外側
    expect(index.nearest(10, 10, 10, 1)).toBeNull();
    expect(index.nearest(10, 10, 10)).not.toBeNull();
    expect(index.kNearest(10, 10, 10, 5, 1).indices.length).toBe(0);
    expect(index.within(10, 10, 10, 1).length).toBe(0);
  });

  it('maxDistance・radius の境界（ちょうどその距離の点）を含む', () => {
    const p = new Float32Array([0, 0, 0, 3, 4, 0]);
    const small = new SpatialIndex(p);
    expect(small.nearest(0, 0, 0, 0)).toEqual({ index: 0, distance: 0 });
    expect(small.nearest(3, 4, 5, 5)).toEqual({ index: 1, distance: 5 });
    expect(Array.from(small.within(0, 0, 0, 5))).toEqual([0, 1]);
    expect(Array.from(small.within(0, 0, 0, 4.999))).toEqual([0]);
    expect(Array.from(small.kNearest(0, 0, 0, 5, 5).indices)).toEqual([0, 1]);
  });

  it('kNearest の結果は近い順で、同距離は添字の小さい順', () => {
    const r = index.kNearest(0.6, 0.5, -0.6, 50);
    expect(r.indices.length).toBe(50);
    for (let i = 1; i < r.distances.length; i++) {
      expect(r.distances[i]).toBeGreaterThanOrEqual(r.distances[i - 1]);
    }
  });

  it('within の結果は添字の昇順', () => {
    const ids = Array.from(index.within(0.6, 0.5, -0.6, 0.1));
    expect(ids.length).toBeGreaterThan(10);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('k が点数を超える場合は全点を近い順に返す', () => {
    const q: [number, number, number] = [0.3, -0.2, 0.1];
    const got = index.kNearest(q[0], q[1], q[2], N + 500);
    const want = bruteK(positions, q[0], q[1], q[2], N + 500);
    expect(got.indices.length).toBe(N);
    expect(Array.from(got.indices)).toEqual(want.indices);
    expect(Array.from(got.distances)).toEqual(want.distances);
    // 巨大な k でも内部で巨大な領域を確保しない
    expect(index.kNearest(q[0], q[1], q[2], 2 ** 31).indices.length).toBe(N);
    expect(index.kNearest(q[0], q[1], q[2], Infinity).indices.length).toBe(N);
  });

  it('不正な引数: k<=0・半径が負・NaN は空（または null）を返す', () => {
    expect(index.kNearest(0, 0, 0, 0).indices.length).toBe(0);
    expect(index.kNearest(0, 0, 0, -3).indices.length).toBe(0);
    expect(index.kNearest(0, 0, 0, NaN).indices.length).toBe(0);
    expect(index.within(0, 0, 0, -1).length).toBe(0);
    expect(index.within(0, 0, 0, NaN).length).toBe(0);
    expect(index.nearest(0, 0, 0, -1)).toBeNull();
    expect(index.nearest(NaN, 0, 0)).toBeNull();
    expect(index.kNearest(0, NaN, 0, 3).indices.length).toBe(0);
    expect(index.within(0, 0, NaN, 3).length).toBe(0);
  });

  it('同じインスタンスで繰り返し問い合わせても結果が変わらない（作業領域の再利用）', () => {
    const a = index.kNearest(0.1, 0.1, 0.1, 64);
    index.kNearest(-0.7, -0.6, 0.5, 3);
    index.within(0, 0, 0, 3); // バッファを大きく使う
    const b = index.kNearest(0.1, 0.1, 0.1, 64);
    expect(Array.from(b.indices)).toEqual(Array.from(a.indices));
    expect(Array.from(b.distances)).toEqual(Array.from(a.distances));
  });

  it('構築後に元の配列を書き換えても結果は変わらない', () => {
    const copy = new Float32Array(positions);
    const idx = new SpatialIndex(copy);
    const before = idx.nearest(0.6, 0.5, -0.6);
    copy.fill(100);
    expect(idx.nearest(0.6, 0.5, -0.6)).toEqual(before);
  });
});

// ---------------------------------------------------------------- 縮退したデータ

describe('SpatialIndex（縮退したデータ）', () => {
  it('点数 0: すべて空・null', () => {
    const idx = new SpatialIndex(new Float32Array(0));
    expect(idx.count).toBe(0);
    expect(idx.nearest(0, 0, 0)).toBeNull();
    expect(idx.nearest(0, 0, 0, 10)).toBeNull();
    expect(idx.kNearest(0, 0, 0, 5).indices.length).toBe(0);
    expect(idx.kNearest(0, 0, 0, 5).distances.length).toBe(0);
    expect(idx.within(0, 0, 0, 10).length).toBe(0);
  });

  it('点数 1', () => {
    const p = new Float32Array([0.25, -0.5, 0.75]);
    const idx = new SpatialIndex(p);
    expect(idx.count).toBe(1);
    expectMatchesBrute(idx, p, [0.25, -0.5, 0.75], 3, 1, 1); // 点そのもの
    expectMatchesBrute(idx, p, [-2, 2, 3], 3, 10, 10); // 遠く
    expect(idx.nearest(0.25, -0.5, 0.75)).toEqual({ index: 0, distance: 0 });
    expect(idx.nearest(5, 5, 5, 1)).toBeNull();
    expect(Array.from(idx.kNearest(0, 0, 0, 10).indices)).toEqual([0]);
    expect(Array.from(idx.within(0.25, -0.5, 0.75, 0))).toEqual([0]);
  });

  it('点数が葉の大きさ前後（木が葉 1 枚になる境界）', () => {
    const rand = mulberry32(99);
    for (const n of [2, 3, 7, 8, 9, 10, 16, 17, 18, 33]) {
      const p = new Float32Array(3 * n);
      for (let i = 0; i < p.length; i++) p[i] = rand() * 2 - 1;
      const idx = new SpatialIndex(p);
      for (let t = 0; t < 20; t++) {
        const q: [number, number, number] = [rand() * 3 - 1.5, rand() * 3 - 1.5, rand() * 3 - 1.5];
        expectMatchesBrute(idx, p, q, 1 + (t % 12), 0.3 + t * 0.1, 0.2 + t * 0.1);
      }
    }
  });

  it('同じ座標の点が複数ある（同距離は添字の小さい順）', () => {
    // 座標 A に 5 点、座標 B に 40 点、その他に散らばった点
    const rand = mulberry32(2024);
    const pts: number[] = [];
    const A = [0.1, 0.2, 0.3];
    const B = [-0.5, 0.5, -0.5];
    for (let i = 0; i < 100; i++) {
      if (i % 20 === 3) pts.push(...A);
      else if (i % 5 === 0) pts.push(...B);
      else pts.push(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
    }
    for (let i = 0; i < 30; i++) pts.push(...B);
    const p = new Float32Array(pts);
    const idx = new SpatialIndex(p);

    const queries: [number, number, number][] = [
      [A[0], A[1], A[2]],
      [B[0], B[1], B[2]],
      [0, 0, 0],
      [-3, 3, -3],
      [0.1 + 1e-3, 0.2, 0.3],
    ];
    for (const q of queries) {
      for (const k of [1, 3, 7, 50, 500]) {
        expectMatchesBrute(idx, p, q, k, 0.5, 0.5);
      }
    }
    // 重複する点の同距離は、添字の小さい方が先
    const dup = idx.kNearest(B[0], B[1], B[2], 5);
    expect(Array.from(dup.distances)).toEqual([0, 0, 0, 0, 0]);
    expect(Array.from(dup.indices)).toEqual([...dup.indices].sort((a, b) => a - b));
    expect(idx.nearest(B[0], B[1], B[2])!.index).toBe(Math.min(...bruteWithin(p, B[0], B[1], B[2], 0)));
  });

  it('全点が同じ座標（構築が偏らず、問い合わせも正しい）', () => {
    const n = 5000;
    const p = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      p[3 * i] = 0.5;
      p[3 * i + 1] = -0.25;
      p[3 * i + 2] = 0.125;
    }
    const t0 = Date.now();
    const idx = new SpatialIndex(p);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(idx.nearest(0.5, -0.25, 0.125)).toEqual({ index: 0, distance: 0 });
    expect(Array.from(idx.kNearest(0.5, -0.25, 0.125, 4).indices)).toEqual([0, 1, 2, 3]);
    expect(idx.within(0.5, -0.25, 0.125, 0).length).toBe(n);
    expect(idx.within(0.5, 0.25, 0.125, 0.4).length).toBe(0);
    expect(idx.within(0.5, 0.25, 0.125, 0.5).length).toBe(n);
  });

  it('1 つの軸にだけ点が並ぶ・一部の軸が同値の分布', () => {
    const n = 600;
    const p = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      p[3 * i] = (i / n) * 2 - 1;
      p[3 * i + 1] = 0.3;
      p[3 * i + 2] = i % 2 ? 0.1 : -0.1;
    }
    const idx = new SpatialIndex(p);
    const rand = mulberry32(5);
    for (let t = 0; t < 60; t++) {
      const q: [number, number, number] = [rand() * 3 - 1.5, rand() * 2 - 0.5, rand() * 2 - 1];
      expectMatchesBrute(idx, p, q, 1 + (t % 20), 0.05 + 0.02 * t, 0.02 * t);
    }
  });

  it('positions の長さが 3 の倍数でなければ例外', () => {
    expect(() => new SpatialIndex(new Float32Array(4))).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------- 別の分布・規模

describe('SpatialIndex（規模の大きいデータ）', () => {
  it('2 万点のクラスタ分布で、データ点・塊内部・空白の問い合わせが総当たりと一致する', () => {
    const { positions, blobs } = makeClustered(31337, 20000);
    const idx = new SpatialIndex(positions);
    const rand = mulberry32(4242);
    const gauss = makeGaussian(rand);
    for (let t = 0; t < 40; t++) {
      let q: [number, number, number];
      switch (t % 3) {
        case 0: {
          const id = Math.floor(rand() * 20000);
          q = [positions[3 * id], positions[3 * id + 1], positions[3 * id + 2]];
          break;
        }
        case 1: {
          const b = blobs[Math.floor(rand() * blobs.length)];
          q = [
            b.center[0] + b.sigma * gauss(),
            b.center[1] + b.sigma * gauss(),
            b.center[2] + b.sigma * gauss(),
          ];
          break;
        }
        default:
          q = [rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2];
      }
      expectMatchesBrute(idx, positions, q, [1, 8, 100][t % 3], [0.01, 0.1, 1][t % 3], [0.005, 0.05, 0.5][(t + 1) % 3]);
    }
  });
});
