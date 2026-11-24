/**
 * 「元の空間で近い点」の、データセットの表示（DatasetView）をまたいで保つ状態。アプリ全体（src/main.ts）で 1 つだけ持つ。
 *
 * - kNN グラフ（`KnnSource`。取得口は `knnGraph()`）と選択の履歴は、データセットごとに持つ。データセットを切り替えたら
 *   （読み込み中のものも含めて）捨てる。捨てるのは `setDataset` の 1 か所。ブラウザで計算した埋め込みへ表示を作り直すときは、同じデータセットなので保つ
 *   （元の空間での近傍は、埋め込みによらず同じ）。
 * - 地図の上の表示（強調と線）の有効・無効（N キー）は、データセットを切り替えても保つ。
 */
import type { KnnGraph } from '../data/knn';
import type { DatasetManifest } from '../data/manifest';
import { SelectionHistory } from './history';
import { KnnSource, type KnnLoader } from './source';
import { DEFAULT_NEIGHBOR_COUNT } from './neighbors';

export class NeighborsShared {
  /** 一覧に出す近傍の数 */
  readonly count: number;
  readonly history = new SelectionHistory();
  private _source: KnnSource | null = null;
  private _enabled = true;
  private readonly loader: KnnLoader | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(options: { count?: number; loader?: KnnLoader } = {}) {
    this.count = options.count ?? DEFAULT_NEIGHBOR_COUNT;
    this.loader = options.loader;
  }

  /** 表示中のデータセットの kNN グラフ（データセットがなければ null） */
  get source(): KnnSource | null {
    return this._source;
  }

  /**
   * 表示中のデータセットの kNN グラフ。アプリ内の kNN グラフの取得口はここだけ（近傍の一覧と、ブラウザでの UMAP の再計算の両方が使う）。
   * 同時の要求は 1 回の取得にまとまり、読み込んだ 1 部を共有する。読み込み中にデータセットが切り替わると拒否される。
   * 失敗したら、次の要求で読み込み直す。
   */
  knnGraph(): Promise<KnnGraph> {
    const source = this._source;
    if (!source) return Promise.reject(new Error('表示中のデータセットがありません'));
    return source.load();
  }

  /**
   * 表示中のデータセットを設定する（読み込んだ場所と manifest）。前と同じデータセット（同じ manifest）なら何もしない。
   * 違えば、読み込んだ kNN グラフと選択の履歴を捨てる。
   */
  setDataset(data: { dir: string; manifest: DatasetManifest } | null): void {
    if (data && this._source && this._source.dir === data.dir && this._source.manifest === data.manifest) return;
    this._source?.dispose();
    this._source = data ? new KnnSource(data.dir, data.manifest, this.loader) : null;
    this.history.clear();
    this.emit();
  }

  /** 地図の上の表示（強調と線）が有効か（N キー） */
  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this._enabled === enabled) return;
    this._enabled = enabled;
    this.emit();
  }

  /** 状態が変わったとき（有効・無効、データセット）に呼ぶ関数を登録する。返す関数で外す。 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
