import { describe, expect, it } from 'vitest';
import type { DatasetManifest } from '../data/manifest';
import type { KnnGraph } from '../data/knn';
import { KnnSource } from './source';
import { NeighborsShared } from './shared';

const withKnn = { count: 2, knn: { k: 1 } } as unknown as DatasetManifest;
const withoutKnn = { count: 2 } as unknown as DatasetManifest;
const g: KnnGraph = { count: 2, k: 1, metric: 'euclidean', indices: new Uint16Array([1, 0]), distances: new Float32Array([1, 1]) };

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

describe('KnnSource', () => {
  it('kNN グラフのないデータセットでは unavailable で、読み込みは失敗する（読み込み関数は呼ばない）', async () => {
    let calls = 0;
    const s = new KnnSource('d', withoutKnn, async () => { calls++; return g; });
    expect(s.available).toBe(false);
    expect(s.status).toBe('unavailable');
    await expect(s.load()).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it('最初の load で 1 度だけ読み込み、同時の呼び出しは同じ結果を待つ', async () => {
    const d = deferred<KnnGraph>();
    let calls = 0;
    const s = new KnnSource('d', withKnn, () => { calls++; return d.promise; });
    expect(s.status).toBe('idle');
    const a = s.load(), b = s.load();
    expect(s.status).toBe('loading');
    d.resolve(g);
    expect(await a).toBe(g);
    expect(await b).toBe(g);
    expect(await s.load()).toBe(g);
    expect(calls).toBe(1);
    expect(s.status).toBe('ready');
    expect(s.graph).toBe(g);
  });
  it('失敗したら error になり、次の load で読み込み直す', async () => {
    let calls = 0;
    const s = new KnnSource('d', withKnn, async () => { calls++; if (calls === 1) throw new Error('HTTP 500'); return g; });
    await expect(s.load()).rejects.toThrow('HTTP 500');
    expect(s.status).toBe('error');
    expect(s.error).toBe('HTTP 500');
    expect(await s.load()).toBe(g);
    expect(calls).toBe(2);
  });
  it('dispose すると、読み込み中の結果を使わず、グラフを捨てる', async () => {
    const d = deferred<KnnGraph>();
    const s = new KnnSource('d', withKnn, () => d.promise);
    const p = s.load();
    s.dispose();
    d.resolve(g);
    await expect(p).rejects.toThrow();
    expect(s.graph).toBeNull();
    expect(s.status).toBe('disposed');
    await expect(s.load()).rejects.toThrow();
  });
});

describe('NeighborsShared', () => {
  it('データセットを切り替えると、前の kNN グラフと選択の履歴を捨てる。同じデータセットなら保つ', async () => {
    const shared = new NeighborsShared({ loader: async () => g });
    shared.setDataset({ dir: 'a', manifest: withKnn });
    const first = shared.source!;
    await first.load();
    shared.history.record(0);
    shared.history.record(1);
    shared.setDataset({ dir: 'a', manifest: withKnn }); // 同じ
    expect(shared.source).toBe(first);
    expect(shared.history.length).toBe(1);
    const other = { count: 2, knn: { k: 1 } } as unknown as DatasetManifest;
    shared.setDataset({ dir: 'b', manifest: other });
    expect(first.status).toBe('disposed');
    expect(first.graph).toBeNull();
    expect(shared.source).not.toBe(first);
    expect(shared.history.length).toBe(0);
  });
  it('N キーの有効・無効の変化を知らせる（既定は有効）', () => {
    const shared = new NeighborsShared();
    let n = 0;
    const off = shared.onChange(() => n++);
    expect(shared.enabled).toBe(true);
    shared.setEnabled(false);
    shared.setEnabled(false);
    expect(n).toBe(1);
    off();
    shared.setEnabled(true);
    expect(n).toBe(1);
    expect(shared.count).toBe(10);
  });
});
