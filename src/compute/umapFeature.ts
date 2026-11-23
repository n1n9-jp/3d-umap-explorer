/**
 * ブラウザ内の UMAP の再計算（パネルを開くか、URL に nn・md・seed があるときにだけ読み込む、別のチャンク）。
 *
 * 流れ:
 *   1. パネルの「計算」→ kNN グラフを取得（初回だけ）→ Worker を作ってグラフを送る（初回だけ）→ 計算を始める。
 *      計算中も描画ループは止まらず、表示中の埋め込みを飛行して探索できる。
 *   2. 「計算の途中を表示する」が有効なら、Worker が一定の間隔で途中の座標を送り、正規化と位置合わせをして点群に描く。
 *   3. 完走したら、座標を正規化し、表示中の座標に位置合わせ（Procrustes）してから正規化し直す。
 *      表示中の座標から新しい座標へ、約 1 秒かけて点を動かす（点の番号は変わらない）。
 *   4. 動かし終えたら、新しい座標で、データに依存する部分（空間索引・ピッキング・目印・ミニマップ・速度の自動調整・ホームの視点）
 *      を作り直す（`host.replaceView`）。選択中の点は番号で引き継ぐ。カメラはその場に留める（理由は README の「使い方」）。
 *   5. 結果は、パラメータと種を鍵に、セッションの間（データセットを切り替えるまで）保持する（上限 `MAX_CACHED`）。
 */
import { loadKnnGraph, type KnnGraph } from '../data/knn';
import { UmapPanel } from '../app/umapPanel';
import { applyTransform, meanDisplacement, normalizePositions, procrustes } from './align';
import { takeFault } from '../app/faults';
import type { SpatialIndex } from '../spatial/SpatialIndex';
import { buildEmbeddingData, structureInputs } from './embedding';
import type { EmbeddingHost, UmapFeatureState } from './host';
import {
  UMAP_CHUNK_EPOCHS, UMAP_EPOCHS, UMAP_LIMITS, describeComputed, describePrecomputed, embeddingStatusText, formatUmapParams, paramsKey, validParams,
  type UmapParams,
} from './params';
import type { FromWorker, ToWorker } from './protocol';
import { StructureAborted, startStructureJob, type StructureJob } from './structureClient';
import { describeComputeError, describeWorkerError } from './workerError';

/** `faults.worker` で使う、読み込みの時点で例外を投げる Worker（検証用）。 */
const FAILING_WORKER_URL = `data:text/javascript;charset=utf-8,${encodeURIComponent('throw new Error("検証用に Worker を失敗させました");')}`;

/** 新旧の座標の間を点が動く時間（秒） */
export const MORPH_SECONDS = 1.0;
/** 計算の途中の座標を点群へ反映する間隔（ミリ秒） */
export const PREVIEW_INTERVAL_MS = 300;
/** 保持する結果の数の上限（古いものから捨てる） */
export const MAX_CACHED = 8;

/** データセットが切り替わって打ち切ったときの、`UmapOutcome.error` の文 */
const DATASET_CHANGED = 'データセットが切り替わりました';

/** 計算・表示の結果。打ち切ったとき（データセットの切り替えなど）も、必ず `cancelled: true` で解決する。 */
export interface UmapOutcome {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  /** 保持していた結果を使ったか */
  cached?: boolean;
}

interface CacheEntry {
  key: string;
  params: UmapParams;
  /** Worker が返した座標（正規化の前） */
  raw: Float32Array;
  /** 正規化した座標（位置合わせの前） */
  normalized: Float32Array;
}

interface RunningJob {
  id: number;
  params: UmapParams;
  key: string;
  /** 位置合わせの基準（計算を始めたときに表示していた埋め込みの座標） */
  target: Float32Array;
  t0: number;
  cancelRequested: boolean;
  /** 中断を指示した時刻（performance.now） */
  cancelAt: number;
  resolve(o: UmapOutcome): void;
}

interface Morph {
  from: Float32Array;
  to: Float32Array;
  buf: Float32Array;
  t: number;
  /** 動かし終えたら true、途中で打ち切ったら false で呼ぶ（どちらでも `morphTo` の Promise は解決する） */
  done(completed: boolean): void;
}

/**
 * メインスレッドで同期的に動く区間の時間を、`performance.measure` に記録する（名前は `umap:` で始まる。計測用。
 * scripts/spike/switch-stall/measure.cjs が読む）。結果はそのまま返す。
 */
function timed<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    performance.measure(name, { start, end: performance.now() });
  }
}

/** 0..1 の始まりと終わりを緩やかにする */
const smoothstep = (t: number) => t * t * (3 - 2 * t);

export class UmapFeature {
  private readonly host: EmbeddingHost;
  private readonly panel: UmapPanel;
  private gen = -1;
  private available = false;
  private maxNeighbors: number = UMAP_LIMITS.nNeighbors.max;
  private defaults: UmapParams = { nNeighbors: 15, minDist: 0.1, seed: 42 };
  private graph: KnnGraph | null = null;
  private graphPromise: Promise<KnnGraph> | null = null;
  private worker: Worker | null = null;
  private nextId = 1;
  private loading: RunningJob | null = null;
  private running: RunningJob | null = null;
  private morph: Morph | null = null;
  /** 新しい座標の空間の構造を Worker で計算している間（点を動かしている間も含む） */
  private structureJob: StructureJob | null = null;
  /** 事前計算の座標の空間索引（事前計算へ戻すとき、作り直さずに使う） */
  private baseSpatialIndex: SpatialIndex | null = null;
  private current: UmapFeatureState['current'] = { kind: 'precomputed' };
  private readonly cache = new Map<string, CacheEntry>();
  private epoch = 0;
  private total = UMAP_EPOCHS;
  private previewUpdates = 0;
  private previewShown = false;
  private message = '';
  private error: string | null = null;
  private lastRun: UmapFeatureState['lastRun'] = null;
  private lastAlignment: UmapFeatureState['lastAlignment'] = null;
  private lastOutcome: UmapFeatureState['lastOutcome'] = null;
  private lastCancel: UmapFeatureState['lastCancel'] = null;

  constructor(host: EmbeddingHost) {
    this.host = host;
    this.panel = new UmapPanel(host.doc, {
      compute: (p) => { void this.compute(p); },
      cancel: () => this.cancel(),
      revert: () => { void this.revert(); },
      showCached: (key) => { const e = this.cache.get(key); if (e) void this.compute(e.params); },
      previewChanged: (on) => this.setPreview(on),
      visibilityChanged: () => this.render(),
    });
    this.syncDataset();
  }

  // ---------------------------------------------------------------- 開閉と状態

  get isOpen(): boolean {
    return this.panel.isOpen;
  }

  /** データセットを切り替えたあと（main.ts から）。計算中の Worker を止め、保持していた結果を捨てる。 */
  datasetChanged(): void {
    this.syncDataset();
  }

  open(moveFocus = false): void {
    this.syncDataset();
    this.panel.setOpen(true, moveFocus);
  }

  toggle(moveFocus = false): void {
    this.syncDataset();
    this.panel.toggle(moveFocus);
  }

  getState(): UmapFeatureState {
    this.syncDataset();
    return {
      loaded: true,
      available: this.available,
      open: this.panel.isOpen,
      phase: this.phase,
      epoch: this.epoch,
      total: this.total,
      current: this.current.kind === 'computed' ? { ...this.current, params: { ...this.current.params } } : { kind: 'precomputed' },
      cache: [...this.cache.keys()],
      lastRun: this.lastRun ? { ...this.lastRun } : null,
      lastAlignment: this.lastAlignment ? { ...this.lastAlignment } : null,
      previewUpdates: this.previewUpdates,
      lastCancel: this.lastCancel ? { ...this.lastCancel } : null,
      lastOutcome: this.lastOutcome,
      error: this.error,
      graphLoaded: this.graph !== null,
      workerStarted: this.worker !== null,
    };
  }

  /** 保持している結果の、Worker が返した座標（正規化の前）のコピー。 */
  raw(key: string): Float32Array | null {
    const e = this.cache.get(key);
    return e ? new Float32Array(e.raw) : null;
  }

  get previewEnabled(): boolean {
    return this.panel.previewEnabled;
  }

  /** 「計算の途中を表示する」を切り替える（パネルのチェックボックスと同じ）。 */
  setPreview(enabled: boolean): void {
    if (this.panel.previewEnabled !== enabled) this.panel.setPreview(enabled);
    if (this.running && this.worker) {
      this.post({ type: 'preview', id: this.running.id, previewMs: enabled ? PREVIEW_INTERVAL_MS : 0 });
      if (!enabled && this.previewShown) this.restoreDisplay();
    }
  }

  private get phase(): UmapFeatureState['phase'] {
    if (this.morph || this.structureJob) return 'morphing';
    if (this.running) return 'running';
    if (this.loading) return 'loading';
    return 'idle';
  }

  /** データセットが切り替わっていたら、計算と結果を捨てて、パネルを新しいデータセットに合わせる。 */
  private syncDataset(): void {
    const gen = this.host.generation();
    if (gen === this.gen) return;
    this.gen = gen;
    this.stopWorker();
    this.structureJob?.abort();
    this.structureJob = null;
    this.morph?.done(false); // 表示を切り替えている途中なら、待っている処理（show・revert）を打ち切りで解決させる
    this.morph = null;
    this.baseSpatialIndex = null;
    this.cache.clear();
    this.graph = null;
    this.graphPromise = null;
    this.current = { kind: 'precomputed' };
    this.lastAlignment = null;
    this.previewShown = false;
    this.epoch = 0;
    this.error = null;
    const base = this.host.baseData();
    const m = base?.arrays.manifest;
    this.available = !!m?.knn;
    this.maxNeighbors = m?.knn ? Math.min(UMAP_LIMITS.nNeighbors.max, m.knn.k + 1) : UMAP_LIMITS.nNeighbors.max;
    const u = (m?.umap ?? {}) as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    this.defaults = validParams(
      clamp(Math.round(num(u.nNeighbors, 15)), UMAP_LIMITS.nNeighbors.min, this.maxNeighbors),
      clamp(num(u.minDist, 0.1), UMAP_LIMITS.minDist.min, UMAP_LIMITS.minDist.max),
      clamp(Math.round(num(u.randomState, 42)), UMAP_LIMITS.seed.min, UMAP_LIMITS.seed.max),
      this.maxNeighbors,
    ) ?? { nNeighbors: 15, minDist: 0.1, seed: 42 };
    this.message = this.available ? '' : 'このデータセットには kNN グラフがないため、UMAP を再計算できません。';
    this.panel.setInputs(this.defaults, this.maxNeighbors);
    this.render();
  }

  // ---------------------------------------------------------------- 計算

  /** URL の nn・md・seed から計算して表示する（読み込みのあと）。パネルを開いて進捗を見せる。 */
  computeFromUrl(params: UmapParams): Promise<UmapOutcome> {
    this.syncDataset();
    this.panel.setInputs(params, this.maxNeighbors);
    this.panel.setOpen(true);
    return this.compute(params);
  }

  /**
   * パラメータで計算して表示する。保持している結果があればそれを使う（`force` で計算し直す）。
   * 表示を切り替え終えたとき（または中断・失敗したとき）に解決する。
   */
  async compute(params: UmapParams, opts: { force?: boolean } = {}): Promise<UmapOutcome> {
    this.syncDataset();
    if (!this.available) return { ok: false, error: this.message };
    if (this.phase !== 'idle') return { ok: false, error: '計算中か、表示を切り替えている途中です' };
    const p = validParams(params.nNeighbors, params.minDist, params.seed, this.maxNeighbors);
    if (!p) return { ok: false, error: 'パラメータが範囲の外です' };
    const key = paramsKey(p);
    this.panel.setInputs(p, this.maxNeighbors);
    this.error = null;
    if (!opts.force) {
      if (this.current.kind === 'computed' && this.current.key === key) {
        this.message = 'この設定の埋め込みを表示しています。';
        this.render();
        return { ok: true, cached: true };
      }
      const hit = this.cache.get(key);
      if (hit) {
        this.touch(hit);
        this.message = '保持していた結果を表示します。';
        return this.show(hit, true);
      }
    }
    const view = this.host.view();
    if (!view) return { ok: false, error: '表示中のデータセットがありません' };
    const gen = this.gen;
    return new Promise<UmapOutcome>((resolve) => {
      const job: RunningJob = {
        id: this.nextId++, params: p, key, target: new Float32Array(view.arrays.positions), t0: performance.now(),
        cancelRequested: false, cancelAt: 0, resolve,
      };
      this.loading = job;
      this.epoch = 0;
      this.total = UMAP_EPOCHS;
      this.previewUpdates = 0;
      this.message = '';
      this.render();
      this.ensureWorker().then(() => {
        if (gen !== this.host.generation() || this.loading !== job) return;
        this.loading = null;
        if (job.cancelRequested) { this.finishJob(job, 'cancelled'); return; }
        this.running = job;
        this.post({
          type: 'run', id: job.id, params: p, nEpochs: UMAP_EPOCHS, chunkEpochs: UMAP_CHUNK_EPOCHS,
          previewMs: this.panel.previewEnabled ? PREVIEW_INTERVAL_MS : 0,
        });
        this.render();
      }, (e: unknown) => {
        if (this.loading !== job) return;
        this.loading = null;
        this.fail(job, e instanceof Error ? e.message : String(e));
      });
    });
  }

  /** 計算を中断する。表示は計算前のまま（途中の座標を出していたら戻す）。 */
  cancel(): void {
    if (this.loading) { this.loading.cancelRequested = true; this.loading.cancelAt = performance.now(); return; }
    if (!this.running || this.running.cancelRequested) return;
    this.running.cancelRequested = true;
    this.running.cancelAt = performance.now();
    this.post({ type: 'cancel', id: this.running.id });
    this.message = '中断しています…';
    this.render();
  }

  /** 事前計算の座標とクラスタへ戻す。 */
  async revert(): Promise<UmapOutcome> {
    this.syncDataset();
    if (this.current.kind !== 'computed') return { ok: true };
    if (this.phase !== 'idle') return { ok: false, error: '計算中か、表示を切り替えている途中です' };
    const base = this.host.baseData();
    if (!base) return { ok: false, error: '表示中のデータセットがありません' };
    const gen = this.gen;
    const morphed = await this.morphTo(base.arrays.positions);
    if (!morphed || gen !== this.host.generation()) return this.cancelledBySwitch();
    try {
      this.host.replaceView(base, { coloring: null, spatialIndex: this.baseSpatialIndex ?? undefined });
    } catch (e) {
      this.restoreDisplay();
      return this.failShow(e);
    }
    this.current = { kind: 'precomputed' };
    this.host.setUrlParams(null);
    this.message = '事前計算の埋め込みに戻しました。';
    this.render();
    return { ok: true };
  }

  /** 毎フレーム（描画の前）。点を新旧の座標の間で動かす。 */
  update(dt: number): void {
    const m = this.morph;
    if (!m) return;
    const view = this.host.view();
    if (!view || this.gen !== this.host.generation()) { this.morph = null; m.done(false); return; }
    m.t = Math.min(1, m.t + Math.max(0, dt) / MORPH_SECONDS);
    const s = smoothstep(m.t);
    const { from, to, buf } = m;
    for (let i = 0; i < buf.length; i++) buf[i] = from[i]! + (to[i]! - from[i]!) * s;
    view.setDisplayPositions(buf);
    if (m.t >= 1) {
      this.morph = null;
      m.done(true);
    }
  }

  dispose(): void {
    this.stopWorker();
    this.structureJob?.abort();
    this.structureJob = null;
    this.morph?.done(false);
    this.morph = null;
    this.panel.dispose();
  }

  // ---------------------------------------------------------------- 内部

  private async ensureWorker(): Promise<void> {
    const base = this.host.baseData();
    if (!base) throw new Error('表示中のデータセットがありません');
    if (!this.graph) {
      this.graphPromise ??= loadKnnGraph(base.dir, base.arrays.manifest);
      const gen = this.gen;
      const g = await this.graphPromise.catch((e: unknown) => {
        this.graphPromise = null;
        throw e;
      });
      if (gen !== this.host.generation()) throw new Error('データセットが切り替わりました');
      this.graph = g;
    }
    if (!this.worker) {
      const w = takeFault('worker')
        ? new Worker(FAILING_WORKER_URL, { name: 'umap' })
        : new Worker(new URL('./umapWorker.ts', import.meta.url), { type: 'module', name: 'umap' });
      w.onmessage = (ev: MessageEvent<FromWorker>) => this.onWorkerMessage(ev.data);
      w.onerror = (ev) => {
        ev.preventDefault();
        if (this.worker !== w) return;
        // Worker のエラーは、計算を「切り替えによる中断」にせず、エラーとして報告する（`stopWorker` は待っている計算を中断で解決してしまう）
        const job = this.running ?? this.loading;
        this.running = null;
        this.loading = null;
        this.terminateWorker();
        const message = describeWorkerError(ev.message);
        if (job) this.fail(job, message);
        else console.warn('UMAP の Worker でエラーが起きました:', message);
      };
      this.worker = w;
      const g = this.graph;
      // グラフはメインスレッドにも残す（Worker を作り直すときに使う）ので、コピーで送る
      this.post({ type: 'graph', count: g.count, k: g.k, indices: g.indices, distances: g.distances });
    }
  }

  private post(m: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(m, transfer);
  }

  /** Worker を止める（待っている計算には触れない）。 */
  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /** データセットの切り替えなどで Worker を止める。待っている計算は、中断として解決する。 */
  private stopWorker(): void {
    this.terminateWorker();
    const job = this.running ?? this.loading;
    this.running = null;
    this.loading = null;
    if (job) {
      this.lastOutcome = 'cancelled';
      job.resolve({ ok: false, cancelled: true, error: DATASET_CHANGED });
    }
  }

  private onWorkerMessage(m: FromWorker): void {
    const job = this.running;
    if (!job || m.id !== job.id) return;
    switch (m.type) {
      case 'ready':
        break;
      case 'progress':
        this.epoch = m.epoch;
        this.total = m.total;
        this.render();
        break;
      case 'snapshot': {
        if (!this.panel.previewEnabled || job.cancelRequested) break;
        const view = this.host.view();
        if (!view) break;
        const aligned = normalizePositions(applyTransform(m.positions, procrustes(m.positions, job.target)));
        view.setComputingDisplay(true); // 目印とミニマップは計算前の座標のまま。目印を隠し、ミニマップに「計算中」を出す
        view.setDisplayPositions(aligned);
        this.previewShown = true;
        this.previewUpdates++;
        break;
      }
      case 'done': {
        this.epoch = m.epochs;
        const entry: CacheEntry = { key: job.key, params: job.params, raw: m.positions, normalized: normalizePositions(m.positions) };
        this.lastRun = { key: job.key, initMs: m.initMs, optimizeMs: m.optimizeMs, totalMs: performance.now() - job.t0, epochs: m.epochs };
        this.cache.delete(job.key);
        this.cache.set(job.key, entry);
        while (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
        this.running = null;
        this.message = `計算しました（${((performance.now() - job.t0) / 1000).toFixed(1)} 秒）。`;
        void this.show(entry, false).then((o) => job.resolve(o));
        break;
      }
      case 'cancelled':
        this.running = null;
        this.lastCancel = { ms: performance.now() - job.cancelAt, epoch: m.epoch };
        this.finishJob(job, 'cancelled');
        break;
      case 'error':
        this.running = null;
        this.fail(job, describeComputeError(m.message));
        break;
    }
  }

  private finishJob(job: RunningJob, outcome: 'cancelled'): void {
    if (this.previewShown) this.restoreDisplay();
    this.lastOutcome = outcome;
    this.epoch = 0;
    this.message = '計算を中断しました。表示は計算前のままです。';
    this.render();
    job.resolve({ ok: false, cancelled: true });
  }

  private fail(job: RunningJob, message: string): void {
    if (this.previewShown) this.restoreDisplay();
    this.lastOutcome = 'error';
    this.error = message;
    this.epoch = 0;
    this.message = `計算に失敗しました: ${message}`;
    console.warn('UMAP の計算に失敗しました:', message);
    this.render();
    job.resolve({ ok: false, error: message });
  }

  /** 点群の描画を、表示中の埋め込みの座標へ戻す（途中の座標を出していたとき）。 */
  private restoreDisplay(): void {
    const view = this.host.view();
    if (view) {
      view.setDisplayPositions(view.arrays.positions);
      view.setComputingDisplay(false);
    }
    this.previewShown = false;
  }

  /** データセットが切り替わって、表示の切り替えを打ち切ったときの結果。 */
  private cancelledBySwitch(): UmapOutcome {
    this.lastOutcome = 'cancelled';
    return { ok: false, cancelled: true, error: DATASET_CHANGED };
  }

  /**
   * 結果を表示中の座標へ位置合わせし、点を動かしてから、表示を作り直す。空間の構造（範囲・密度・主成分軸・ラベルごとの
   * まとまり）と空間索引は、点を動かしている間に Worker で計算する（メインスレッドを止めない）。
   * データセットが切り替わって打ち切ったときも、`cancelled: true` で解決する。想定外の例外も、失敗として解決する（拒否しない）。
   */
  private async show(entry: CacheEntry, cached: boolean): Promise<UmapOutcome> {
    try {
      return await this.showEntry(entry, cached);
    } catch (e) {
      this.restoreDisplay();
      return this.failShow(e);
    }
  }

  private async showEntry(entry: CacheEntry, cached: boolean): Promise<UmapOutcome> {
    const view = this.host.view();
    const base = this.host.baseData();
    if (!view || !base) return { ok: false, error: '表示中のデータセットがありません' };
    const gen = this.gen;
    const target = view.arrays.positions;
    if (this.current.kind === 'precomputed' && view.arrays === base.arrays) this.baseSpatialIndex ??= view.spatialIndex;
    const { tr, aligned } = timed('umap:align', () => {
      const t = procrustes(entry.normalized, target);
      return { tr: t, aligned: normalizePositions(applyTransform(entry.normalized, t)) };
    });
    this.lastAlignment = {
      key: entry.key, aligned: meanDisplacement(aligned, target), unaligned: meanDisplacement(entry.normalized, target), reflection: tr.reflection,
    };
    const { labels, names } = structureInputs(base.arrays);
    const structureStart = performance.now();
    const job = startStructureJob(aligned, labels, names);
    // 点を動かし終えたところで受け取る（それまでの失敗を、未処理の拒否にしない）。Worker の起動から結果が届くまでの時間も記録する
    job.promise.then(() => performance.measure('umap:structure-worker', { start: structureStart, end: performance.now() }), () => {});
    this.structureJob = job;
    const morphed = await this.morphTo(aligned);
    if (!morphed || gen !== this.host.generation()) {
      job.abort();
      if (this.structureJob === job) this.structureJob = null;
      return this.cancelledBySwitch();
    }
    let data;
    try {
      const structure = await job.promise;
      if (gen !== this.host.generation()) return this.cancelledBySwitch();
      data = timed('umap:build', () => buildEmbeddingData(base.arrays, aligned, entry.params, structure));
    } catch (e) {
      if (e instanceof StructureAborted || gen !== this.host.generation()) return this.cancelledBySwitch();
      this.restoreDisplay();
      return this.failShow(e);
    } finally {
      if (this.structureJob === job) this.structureJob = null;
    }
    try {
      const built = data;
      timed('umap:replaceView', () => this.host.replaceView(
        { dir: base.dir, atlas: base.atlas, arrays: built.arrays }, { coloring: built.coloring, spatialIndex: built.spatialIndex },
      ));
    } catch (e) {
      this.restoreDisplay();
      return this.failShow(e);
    }
    this.previewShown = false;
    this.current = { kind: 'computed', params: { ...entry.params }, key: entry.key };
    this.lastOutcome = 'done';
    this.host.setUrlParams(entry.params);
    this.render();
    return { ok: true, cached };
  }

  private failShow(e: unknown): UmapOutcome {
    const message = e instanceof Error ? e.message : String(e);
    this.error = message;
    this.lastOutcome = 'error';
    this.message = `表示を切り替えられませんでした: ${message}`;
    console.warn('埋め込みの表示を切り替えられませんでした:', e);
    this.render();
    return { ok: false, error: message };
  }

  /**
   * 点群の描画を、いまの座標から `to` へ MORPH_SECONDS かけて動かす。動かし終えたら true、打ち切られたら（データセットの切り替えなど）
   * false で解決する。動かしている間は、目印を隠し、ミニマップに「計算中」を出す（描いている座標が表示中の埋め込みと違うため）。
   */
  private morphTo(to: Float32Array): Promise<boolean> {
    const view = this.host.view();
    if (!view) return Promise.resolve(false);
    view.setComputingDisplay(true);
    return new Promise((resolve) => {
      const from = new Float32Array(view.shownPositions);
      this.morph = { from, to, buf: new Float32Array(from.length), t: 0, done: resolve };
      this.render();
    });
  }

  private touch(e: CacheEntry): void {
    this.cache.delete(e.key);
    this.cache.set(e.key, e);
  }

  private describeCurrent(): string {
    if (this.current.kind === 'computed') return describeComputed(this.current.params);
    return describePrecomputed(this.host.baseData()?.arrays.manifest.umap);
  }

  private render(): void {
    const currentKey = this.current.kind === 'computed' ? this.current.key : null;
    const describe = this.describeCurrent();
    this.panel.update({
      available: this.available,
      message: this.message,
      error: this.error !== null,
      current: `表示中: ${describe}`,
      phase: this.phase,
      epoch: this.epoch,
      total: this.total,
      computed: this.current.kind === 'computed',
      cache: [...this.cache.values()].reverse().map((e) => ({ key: e.key, label: formatUmapParams(e.params), current: e.key === currentKey })),
    });
    const status = this.current.kind === 'computed'
      ? embeddingStatusText(this.current)
      : embeddingStatusText({ kind: 'precomputed', umap: this.host.baseData()?.arrays.manifest.umap });
    this.host.setEmbeddingStatus(status, this.current.kind === 'computed');
  }
}
