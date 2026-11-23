/**
 * UmapFeature の、計算・表示の切り替えの Promise の解決と、Worker のエラーの報告。
 * パネル（DOM）・kNN グラフの取得・Worker・構造の計算の Worker は差し替える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FromWorker, ToWorker } from './protocol';
import { StructureAborted, type StructureJob } from './structureClient';
import { computeStructure } from './structure';

const h = vi.hoisted(() => ({
  panelUpdates: [] as { message: string; error: boolean; phase: string }[],
  jobs: [] as { abort: ReturnType<typeof vi.fn>; resolve(): void; reject(e: unknown): void; settled: boolean }[],
  structureMode: 'manual' as 'manual' | 'immediate',
}));

vi.mock('../app/umapPanel', () => ({
  UmapPanel: class {
    isOpen = false;
    previewEnabled = false;
    setInputs() {}
    setOpen(v: boolean) { this.isOpen = v; }
    toggle() { this.isOpen = !this.isOpen; }
    setPreview(v: boolean) { this.previewEnabled = v; }
    update(v: { message: string; error: boolean; phase: string }) { h.panelUpdates.push({ message: v.message, error: v.error, phase: v.phase }); }
    dispose() {}
  },
}));
vi.mock('../data/knn', () => ({
  loadKnnGraph: async () => ({ count: 50, k: 20, indices: new Uint16Array(50 * 20), distances: new Float32Array(50 * 20) }),
}));
vi.mock('./structureClient', async () => {
  const actual = await vi.importActual<typeof import('./structureClient')>('./structureClient');
  return {
    ...actual,
    startStructureJob: (positions: Float32Array, labels: Uint8Array | null, names: string[] | null): StructureJob => {
      let resolve!: (r: ReturnType<typeof computeStructure>) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<ReturnType<typeof computeStructure>>((res, rej) => { resolve = res; reject = rej; });
      const job = {
        abort: vi.fn(() => { rec.settled = true; reject(new actual.StructureAborted()); }),
        resolve: () => { rec.settled = true; resolve(computeStructure(positions, labels, names)); },
        reject: (e: unknown) => { rec.settled = true; reject(e); },
        settled: false,
      };
      const rec = job;
      h.jobs.push(job);
      if (h.structureMode === 'immediate') job.resolve();
      return { promise, abort: job.abort };
    },
  };
});

import { UmapFeature, MORPH_SECONDS } from './umapFeature';
import type { EmbeddingHost } from './host';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((ev: { data: FromWorker }) => void) | null = null;
  onerror: ((ev: { message: string; preventDefault(): void }) => void) | null = null;
  posted: ToWorker[] = [];
  terminated = false;
  constructor(readonly url: unknown, readonly options?: unknown) { FakeWorker.instances.push(this); }
  postMessage(m: ToWorker) { this.posted.push(m); }
  terminate() { this.terminated = true; }
  emit(m: FromWorker) { this.onmessage?.({ data: m }); }
  fail(message = '') { this.onerror?.({ message, preventDefault() {} }); }
  runMessage() { return this.posted.find((m) => m.type === 'run') as Extract<ToWorker, { type: 'run' }> | undefined; }
}
vi.stubGlobal('Worker', FakeWorker);

const N = 50;
function cloud(seed: number): Float32Array {
  const p = new Float32Array(3 * N);
  let s = seed;
  for (let i = 0; i < p.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; p[i] = (s / 4294967296 - 0.5) * 1.8; }
  return p;
}

function makeHost() {
  const base = cloud(1);
  const state = {
    generation: 0,
    shown: new Float32Array(base),
    computing: false,
    computingCalls: [] as boolean[],
    replaced: 0,
    replaceError: null as Error | null,
    viewPresent: true,
  };
  const view = {
    arrays: { positions: base, manifest: { count: N } },
    spatialIndex: { tag: 'base-index' },
    get shownPositions() { return state.shown; },
    setDisplayPositions: (p: ArrayLike<number>) => { state.shown.set(p); },
    setComputingDisplay: (on: boolean) => { state.computing = on; state.computingCalls.push(on); },
  };
  const baseData = {
    dir: 'x', atlas: null,
    arrays: { positions: base, manifest: { count: N, knn: { k: 20 }, umap: { nNeighbors: 15, minDist: 0.1, randomState: 42 } } },
  };
  (view.arrays as unknown) = baseData.arrays;
  const urlParams: unknown[] = [];
  const host: EmbeddingHost = {
    doc: {} as Document,
    view: () => (state.viewPresent ? (view as never) : null),
    baseData: () => baseData as never,
    generation: () => state.generation,
    replaceView: (...args) => {
      if (state.replaceError) throw state.replaceError;
      state.replaced++;
      void args;
      return view as never;
    },
    setUrlParams: (p) => { urlParams.push(p); },
    setEmbeddingStatus: () => {},
  };
  return { host, state, view, urlParams };
}

const P = { nNeighbors: 15, minDist: 0.1, seed: 42 };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** 計算を始めて、Worker が `run` を受け取るところまで進める。 */
async function startCompute(f: UmapFeature) {
  const promise = f.compute(P);
  await flush();
  const w = FakeWorker.instances[FakeWorker.instances.length - 1]!;
  expect(w.runMessage()).toBeDefined();
  return { promise, w, id: w.runMessage()!.id };
}

const done = (id: number, seed = 7): FromWorker => ({ type: 'done', id, positions: cloud(seed), epochs: 200, initMs: 1, optimizeMs: 2 });

beforeEach(() => {
  FakeWorker.instances.length = 0;
  h.panelUpdates.length = 0;
  h.jobs.length = 0;
  h.structureMode = 'manual';
});

describe('Worker のエラー', () => {
  it('計算中の Worker のエラーは、切り替えによる中断ではなく、エラーとして報告する（パネルに原因が出る）。次の計算ができる', async () => {
    const { host, state } = makeHost();
    const f = new UmapFeature(host);
    const { promise, w } = await startCompute(f);
    w.fail(''); // 読み込みの失敗（ブラウザは文を渡さないことがある）
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBeUndefined();
    expect(r.error).toMatch(/Worker を読み込めない/);
    expect(r.error).toMatch(/SIMD/);
    expect(w.terminated).toBe(true);
    const s = f.getState();
    expect(s.phase).toBe('idle');
    expect(s.lastOutcome).toBe('error');
    expect(s.error).toBe(r.error);
    expect(s.workerStarted).toBe(false);
    const last = h.panelUpdates[h.panelUpdates.length - 1]!;
    expect(last.error).toBe(true);
    expect(last.message).toContain('計算に失敗しました');
    expect(last.message).toContain('SIMD');
    expect(state.generation).toBe(0);

    // 次の計算: Worker を作り直して、計算できる
    const next = await startCompute(f);
    expect(FakeWorker.instances.length).toBe(2);
    h.structureMode = 'immediate';
    next.w.emit(done(next.id));
    await flush();
    f.update(MORPH_SECONDS + 0.1);
    const r2 = await next.promise;
    expect(r2.ok).toBe(true);
    expect(f.getState().lastOutcome).toBe('done');
  });

  it('Worker が捕まえて返したエラー（Wasm の失敗など）も、エラーとして報告し、Wasm らしければ SIMD の説明を添える', async () => {
    const { host } = makeHost();
    const f = new UmapFeature(host);
    const { promise, w, id } = await startCompute(f);
    w.emit({ type: 'error', id, message: 'CompileError: WebAssembly.instantiate(): invalid value type v128' });
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBeUndefined();
    expect(r.error).toContain('v128');
    expect(r.error).toContain('SIMD');
  });

  it('計算していないときの Worker のエラーは、次の計算で Worker を作り直せるよう、Worker を捨てるだけ', async () => {
    const { host } = makeHost();
    const f = new UmapFeature(host);
    const { promise, w, id } = await startCompute(f);
    w.emit({ type: 'cancelled', id, epoch: 3 });
    await promise;
    w.fail('boom');
    expect(f.getState().workerStarted).toBe(false);
    expect(f.getState().phase).toBe('idle');
  });
});

describe('点の移動中・構造の計算中にデータセットを切り替える', () => {
  it('点を動かしている間に切り替えても、compute の Promise が「中断」で解決し、次の計算ができる', async () => {
    const { host, state } = makeHost();
    const f = new UmapFeature(host);
    const { promise, w, id } = await startCompute(f);
    w.emit(done(id));
    await flush();
    f.update(0.3); // 点を動かしている途中
    expect(f.getState().phase).toBe('morphing');
    state.generation++; // データセットが切り替わった
    f.datasetChanged();
    const r = await promise;
    expect(r).toMatchObject({ ok: false, cancelled: true });
    expect(f.getState().phase).toBe('idle');
    expect(f.getState().lastOutcome).toBe('cancelled');
    expect(h.jobs[0]!.abort).toHaveBeenCalled(); // 構造の計算も打ち切る

    const next = await startCompute(f); // 次のデータセットでも計算できる
    h.structureMode = 'immediate';
    next.w.emit(done(next.id, 9));
    await flush();
    f.update(MORPH_SECONDS + 0.1);
    expect((await next.promise).ok).toBe(true);
  });

  it('切り替えを update が先に見つけても（datasetChanged の前）、Promise は解決する', async () => {
    const { host, state } = makeHost();
    const f = new UmapFeature(host);
    const { promise, w, id } = await startCompute(f);
    w.emit(done(id));
    await flush();
    f.update(0.2);
    state.generation++;
    f.update(0.016); // 世代が違うので、点を動かすのをやめる
    expect(await promise).toMatchObject({ ok: false, cancelled: true });
    expect(f.getState().phase).not.toBe('morphing');
  });

  it('点を動かし終えたあと、構造の計算を待つ間に切り替えても、解決する', async () => {
    const { host, state } = makeHost();
    const f = new UmapFeature(host);
    const { promise, w, id } = await startCompute(f);
    w.emit(done(id));
    await flush();
    f.update(MORPH_SECONDS + 0.1); // 動かし終えたが、構造はまだ
    await flush();
    expect(f.getState().phase).toBe('morphing');
    expect(state.replaced).toBe(0);
    state.generation++;
    f.datasetChanged();
    expect(await promise).toMatchObject({ ok: false, cancelled: true });
    expect(state.replaced).toBe(0);
  });

  it('show（保持している結果）・revert も、切り替えで必ず解決する', async () => {
    const { host, state } = makeHost();
    const f = new UmapFeature(host);
    const first = await startCompute(f);
    h.structureMode = 'immediate';
    first.w.emit(done(first.id));
    await flush();
    f.update(MORPH_SECONDS + 0.1);
    expect((await first.promise).ok).toBe(true);

    // 保持している結果を、別のパラメータの計算のあとで表示 → 動かしている途中で切り替え
    const cached = f.compute(P, { force: false });
    expect((await cached).cached).toBe(true); // 表示中と同じ設定
    const second = f.compute({ ...P, seed: 1 });
    await flush();
    FakeWorker.instances[FakeWorker.instances.length - 1]!.emit(done(2, 5));
    await flush();
    f.update(MORPH_SECONDS + 0.1);
    expect((await second).ok).toBe(true);
    const back = f.compute(P); // 保持している結果
    await flush();
    f.update(0.2);
    state.generation++;
    f.datasetChanged();
    expect(await back).toMatchObject({ ok: false, cancelled: true });

    // revert（事前計算に戻す）
    const f2 = new UmapFeature(host);
    const c = await startCompute(f2);
    c.w.emit(done(c.id));
    await flush();
    f2.update(MORPH_SECONDS + 0.1);
    expect((await c.promise).ok).toBe(true);
    const rev = f2.revert();
    await flush();
    f2.update(0.2);
    state.generation++;
    f2.datasetChanged();
    expect(await rev).toMatchObject({ ok: false, cancelled: true });
  });

  it('dispose でも、待っている Promise を解決する', async () => {
    const { host } = makeHost();
    const f = new UmapFeature(host);
    const { promise, w, id } = await startCompute(f);
    w.emit(done(id));
    await flush();
    f.update(0.3);
    f.dispose();
    expect(await promise).toMatchObject({ ok: false, cancelled: true });
  });
});

describe('構造の計算（Worker）と表示の作り直し', () => {
  it('構造の計算の Worker が失敗したら、エラーとして報告し、点群を計算前の座標へ戻して、計算中の表示をやめる', async () => {
    const { host, state } = makeHost();
    const f = new UmapFeature(host);
    const { promise, w, id } = await startCompute(f);
    w.emit(done(id));
    await flush();
    f.update(MORPH_SECONDS + 0.1);
    await flush();
    h.jobs[0]!.reject(new Error('空間の構造を計算できませんでした: だめ'));
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBeUndefined();
    expect(r.error).toContain('だめ');
    expect(f.getState().lastOutcome).toBe('error');
    expect(f.getState().phase).toBe('idle');
    expect(state.computing).toBe(false);
    expect(Array.from(state.shown)).toEqual(Array.from(makeHost().view.arrays.positions));
  });

  it('構造の結果の空間索引を、表示の作り直しへ渡す（構築し直さない）。事前計算へ戻すときは、最初の表示の索引を使う', async () => {
    const { host, view } = makeHost();
    const calls: { spatialIndex: unknown }[] = [];
    const orig = host.replaceView;
    host.replaceView = (data, options) => { calls.push({ spatialIndex: options.spatialIndex }); return orig(data, options); };
    const f = new UmapFeature(host);
    const { promise, w, id } = await startCompute(f);
    h.structureMode = 'immediate';
    w.emit(done(id));
    await flush();
    f.update(MORPH_SECONDS + 0.1);
    expect((await promise).ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.spatialIndex).toBeDefined();
    expect(calls[0]!.spatialIndex).not.toBe(view.spatialIndex);
    const rev = f.revert();
    await flush();
    f.update(MORPH_SECONDS + 0.1);
    expect((await rev).ok).toBe(true);
    expect(calls[1]!.spatialIndex).toBe(view.spatialIndex);
  });

  it('点を動かしている間は計算中の表示にし、表示の作り直しに失敗したら元に戻す', async () => {
    const { host, state } = makeHost();
    const f = new UmapFeature(host);
    const { promise, w, id } = await startCompute(f);
    state.replaceError = new Error('作れない');
    h.structureMode = 'immediate';
    w.emit(done(id));
    await flush();
    expect(state.computing).toBe(true);
    f.update(MORPH_SECONDS + 0.1);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('作れない');
    expect(state.computing).toBe(false);
  });

  it('途中の座標を反映している間は計算中の表示にし、中断すると戻す', async () => {
    const { host, state } = makeHost();
    const f = new UmapFeature(host);
    f.setPreview(true);
    const { promise, w, id } = await startCompute(f);
    w.emit({ type: 'snapshot', id, epoch: 5, total: 200, positions: cloud(3) });
    expect(state.computing).toBe(true);
    f.cancel();
    w.emit({ type: 'cancelled', id, epoch: 6 });
    expect(await promise).toMatchObject({ ok: false, cancelled: true });
    expect(state.computing).toBe(false);
  });
});

describe('StructureAborted', () => {
  it('打ち切りは、エラーとして扱わない', () => {
    expect(new StructureAborted().name).toBe('StructureAborted');
  });
});
