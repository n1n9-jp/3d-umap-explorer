/**
 * 元の空間での kNN グラフを、必要になったとき（点を選んだとき）に 1 度だけ読み込む（DOM に依存しない）。
 * データセットごとに作り、切り替えたら `dispose` で捨てる（読み込み中の結果も使わない）。
 */
import { loadKnnGraph, type KnnGraph } from '../data/knn';
import type { DatasetManifest } from '../data/manifest';

export type KnnSourceStatus = 'unavailable' | 'idle' | 'loading' | 'ready' | 'error' | 'disposed';

export type KnnLoader = (dir: string, manifest: DatasetManifest) => Promise<KnnGraph>;

export class KnnSource {
  readonly dir: string;
  readonly manifest: DatasetManifest;
  private _status: KnnSourceStatus;
  private _graph: KnnGraph | null = null;
  private _error: string | null = null;
  private promise: Promise<KnnGraph> | null = null;
  private readonly loader: KnnLoader;
  /** 読み込みを始めた回数（検証用） */
  loads = 0;

  constructor(dir: string, manifest: DatasetManifest, loader: KnnLoader = loadKnnGraph) {
    this.dir = dir;
    this.manifest = manifest;
    this.loader = loader;
    this._status = manifest.knn ? 'idle' : 'unavailable';
  }

  /** kNN グラフのあるデータセットか */
  get available(): boolean {
    return !!this.manifest.knn;
  }

  get status(): KnnSourceStatus {
    return this._status;
  }

  get graph(): KnnGraph | null {
    return this._graph;
  }

  get error(): string | null {
    return this._error;
  }

  /** 読み込む（読み込み中・読み込み済みなら同じ結果）。失敗したら、次の呼び出しで読み込み直す。 */
  load(): Promise<KnnGraph> {
    if (this._status === 'disposed') return Promise.reject(new Error('データセットが切り替わりました'));
    if (!this.available) return Promise.reject(new Error('このデータセットには kNN グラフがありません'));
    if (this._graph) return Promise.resolve(this._graph);
    if (!this.promise) {
      this.loads++;
      this._status = 'loading';
      this._error = null;
      const p = this.loader(this.dir, this.manifest).then((g) => {
        if (this.promise !== p) throw new Error('データセットが切り替わりました');
        this._graph = g;
        this._status = 'ready';
        return g;
      }, (e: unknown) => {
        if (this.promise === p) {
          this.promise = null;
          this._status = 'error';
          this._error = e instanceof Error ? e.message : String(e);
        }
        throw e;
      });
      this.promise = p;
    }
    return this.promise;
  }

  /** 読み込んだものを捨てる（読み込み中の結果も使わない）。 */
  dispose(): void {
    this._status = 'disposed';
    this._graph = null;
    this.promise = null;
  }
}
