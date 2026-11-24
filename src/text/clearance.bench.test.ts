// @ts-nocheck 計測用（Node の fs・process を使う）。通常のテストでは SYNTH を設定しないので、何もしない。
/**
 * 単語の周りの丸い点の探索（clearance.ts）の計測。7 万点の合成データ（scripts/spike/words-select-bench/README.md）の位置を使い、
 *   SYNTH=<合成データのディレクトリ> npx vitest run src/text/clearance.bench.test.ts --disableConsoleIntercept
 * で、修正の前の方式（全点を投影し、点ごとに全矩形を総当たり）・全点＋タイルの格子・空間索引の木＋タイルの格子の時間を、
 * 表示する単語の数を変えて出す（3 つの結果が一致することも確かめる）。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import fs from 'node:fs';
import { DOT_CLEARANCE_MARGIN_PX, pointsNearRects, pointsNearRectsIndexed } from './clearance';
import { SpatialIndex } from '../spatial/SpatialIndex';
import { DEFAULT_SELECT_PARAMS, projectPoint, selectWords } from './selection';

/** 修正の前の方式: 全点を projectPoint（点ごとにオブジェクトを作る）で投影し、外接範囲の中の点を、全矩形について調べる。 */
function bruteOriginal(positions, view, rects, marginPx, exclude) {
  const out = new Set();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x - r.width / 2); maxX = Math.max(maxX, r.x + r.width / 2);
    minY = Math.min(minY, r.y - r.height / 2); maxY = Math.max(maxY, r.y + r.height / 2);
  }
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    if (exclude.has(i)) continue;
    const q = projectPoint(view, positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
    if (!q) continue;
    const x = (q.ndcX + 1) / 2 * view.width;
    const y = (1 - q.ndcY) / 2 * view.height;
    if (x < minX - marginPx || x > maxX + marginPx || y < minY - marginPx || y > maxY + marginPx) continue;
    for (const r of rects) {
      if (Math.abs(x - r.x) <= r.width / 2 + marginPx && Math.abs(y - r.y) <= r.height / 2 + marginPx) { out.add(i); break; }
    }
  }
  return out;
}

const dir = globalThis.process?.env?.SYNTH;
describe.skipIf(!dir)('丸い点の探索の計測', () => {
  it('3 つの方式の時間と一致', () => {
    const b = fs.readFileSync(`${dir}/positions.f32`);
    const pos = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const index = new SpatialIndex(pos);
    const W = 1280, H = 800;
    const camera = new THREE.PerspectiveCamera(60, W / H, 0.0005, 12);
    // MNIST の 3 つの視点（scripts/verify/lib.cjs の computeViews の、縁・内部・内部の密な場所）
    const poses = [
      [[-0.5073, 0.3237, -0.6764], [-0.3332, 0.2126, -0.4442]],
      [[-0.3935, 0.251, -0.5246], [-0.3332, 0.2126, -0.4442]],
      [[-0.3796, 0.3346, -0.594], [-0.2059, 0.2238, -0.3624]],
    ];
    const time = (f, reps) => { f(); const t0 = performance.now(); for (let i = 0; i < reps; i++) f(); return (performance.now() - t0) / reps; };
    for (const [p, l] of poses) {
      camera.position.set(...p);
      camera.lookAt(...l);
      camera.updateMatrixWorld();
      const view = { view: camera.matrixWorldInverse.elements, projection: camera.projectionMatrix.elements, width: W, height: H };
      const cand = index.kNearest(p[0], p[1], p[2], 1200).indices;
      const res = selectWords({
        candidates: cand, positions: pos, view, emWorld: 0.4 * 0.004, nearLimit: 5 * 0.004 * 1.5,
        box: () => ({ left: 0, right: 3, top: 0.8, bottom: -0.3 }), shown: new Set(), params: DEFAULT_SELECT_PARAMS,
      });
      const all = res.words.map((w) => w.rect);
      for (const take of [all.length, 20, 5]) {
        const rects = all.slice(0, take);
        const ex = new Set(res.words.slice(0, take).map((w) => w.index));
        const a = bruteOriginal(pos, view, rects, DOT_CLEARANCE_MARGIN_PX, ex);
        const g = pointsNearRects(null, pos, view, rects, DOT_CLEARANCE_MARGIN_PX, ex);
        const t = pointsNearRectsIndexed(index, view, rects, DOT_CLEARANCE_MARGIN_PX, ex);
        expect([...g].sort((x, y) => x - y)).toEqual([...a].sort((x, y) => x - y));
        expect([...t].sort((x, y) => x - y)).toEqual([...a].sort((x, y) => x - y));
        const tOrig = time(() => bruteOriginal(pos, view, rects, DOT_CLEARANCE_MARGIN_PX, ex), 10);
        const tGrid = time(() => pointsNearRects(null, pos, view, rects, DOT_CLEARANCE_MARGIN_PX, ex), 10);
        const tIdx = time(() => pointsNearRectsIndexed(index, view, rects, DOT_CLEARANCE_MARGIN_PX, ex), 10);
        console.log(`単語 ${String(take).padStart(3)} 語、小さくする点 ${String(a.size).padStart(5)} 個: 修正の前の方式 ${tOrig.toFixed(2)}ms / 全点＋タイルの格子 ${tGrid.toFixed(2)}ms / 木＋タイルの格子 ${tIdx.toFixed(2)}ms`);
      }
    }
  });
});
