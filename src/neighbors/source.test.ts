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

describe('NeighborsShared.knnGraph（kNN グラフの唯一の取得口）', () => {
  const other = { count: 2, knn: { k: 1 } } as unknown as DatasetManifest;

  it('近傍の機能（source.load）と UMAP の機能（knnGraph）の同時の要求が、1 回の取得にまとまり、同じ 1 部を共有する', async () => {
    const d = deferred<KnnGraph>();
    let calls = 0;
    const shared = new NeighborsShared({ loader: () => { calls++; return d.promise; } });
    shared.setDataset({ dir: 'a', manifest: withKnn });
    const a = shared.source!.load(), b = shared.knnGraph(), c = shared.knnGraph();
    d.resolve(g);
    const [ga, gb, gc] = await Promise.all([a, b, c]);
    expect(ga).toBe(g);
    expect(gb).toBe(g);
    expect(gc).toBe(g);
    expect(shared.source!.graph).toBe(g);
    expect(await shared.knnGraph()).toBe(g);
    expect(calls).toBe(1);
    expect(shared.source!.loads).toBe(1);
  });

  it('UMAP が先に取得しても、近傍の機能は読み込み直さない', async () => {
    let calls = 0;
    const shared = new NeighborsShared({ loader: async () => { calls++; return g; } });
    shared.setDataset({ dir: 'a', manifest: withKnn });
    await shared.knnGraph();
    expect(await shared.source!.load()).toBe(g);
    expect(shared.source!.status).toBe('ready');
    expect(calls).toBe(1);
  });

  it('読み込み中に切り替えると、どちらの機能にも古い結果を渡さない。切り替え後の取得は新しいデータセットのもの', async () => {
    const old = deferred<KnnGraph>();
    const fresh: KnnGraph = { ...g, indices: new Uint16Array([1, 0]) };
    const loads: string[] = [];
    const shared = new NeighborsShared({
      loader: (dir) => { loads.push(dir); return dir === 'a' ? old.promise : Promise.resolve(fresh); },
    });
    shared.setDataset({ dir: 'a', manifest: withKnn });
    const oldSource = shared.source!;
    const viaSource = oldSource.load();
    const viaHost = shared.knnGraph();
    shared.setDataset({ dir: 'b', manifest: other });
    old.resolve(g);
    await expect(viaSource).rejects.toThrow();
    await expect(viaHost).rejects.toThrow();
    expect(oldSource.graph).toBeNull();
    expect(shared.source!.graph).toBeNull();
    expect(await shared.knnGraph()).toBe(fresh);
    expect(shared.source!.graph).toBe(fresh);
    expect(loads).toEqual(['a', 'b']);
  });

  it('失敗したら、どちらの機能からの次の要求でも読み込み直す（失敗を保持しない）', async () => {
    let calls = 0;
    const shared = new NeighborsShared({ loader: async () => { calls++; if (calls <= 2) throw new Error(`HTTP 50${calls}`); return g; } });
    shared.setDataset({ dir: 'a', manifest: withKnn });
    await expect(shared.knnGraph()).rejects.toThrow('HTTP 501');
    expect(shared.source!.status).toBe('error');
    await expect(shared.source!.load()).rejects.toThrow('HTTP 502');
    expect(await shared.knnGraph()).toBe(g);
    expect(shared.source!.graph).toBe(g);
    expect(calls).toBe(3);
  });

  it('同時の要求が失敗したら、すべて同じ失敗で終わり、そのあとの要求は読み込み直す', async () => {
    const d = deferred<KnnGraph>();
    let calls = 0;
    const shared = new NeighborsShared({ loader: () => { calls++; return calls === 1 ? d.promise : Promise.resolve(g); } });
    shared.setDataset({ dir: 'a', manifest: withKnn });
    const a = shared.source!.load(), b = shared.knnGraph();
    d.reject(new Error('HTTP 500'));
    await expect(a).rejects.toThrow('HTTP 500');
    await expect(b).rejects.toThrow('HTTP 500');
    expect(calls).toBe(1);
    expect(await shared.knnGraph()).toBe(g);
    expect(calls).toBe(2);
  });

  it('データセットがない・kNN グラフがないデータセットでは、読み込まずに拒否する', async () => {
    let calls = 0;
    const shared = new NeighborsShared({ loader: async () => { calls++; return g; } });
    await expect(shared.knnGraph()).rejects.toThrow();
    shared.setDataset({ dir: 'a', manifest: withoutKnn });
    await expect(shared.knnGraph()).rejects.toThrow();
    shared.setDataset(null);
    await expect(shared.knnGraph()).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('同じデータセットの setDataset（表示の作り直し）では、読み込み中のものも捨てない', async () => {
    const d = deferred<KnnGraph>();
    let calls = 0;
    const shared = new NeighborsShared({ loader: () => { calls++; return d.promise; } });
    shared.setDataset({ dir: 'a', manifest: withKnn });
    const p = shared.knnGraph();
    shared.setDataset({ dir: 'a', manifest: withKnn });
    d.resolve(g);
    expect(await p).toBe(g);
    expect(await shared.knnGraph()).toBe(g);
    expect(calls).toBe(1);
  });
});
