/**
 * ブラウザ内の UMAP の再計算（`umapFeature.ts`。使うときにだけ読み込む）が、アプリ全体（src/main.ts）に求める窓口。
 * 型だけを置き、main.ts から import しても計算の部分はバンドルに入らない。
 */
import type { DatasetView, LoadedDataset } from '../app/datasetView';
import type { PointColoring } from '../render/colorScheme';
import type { UmapParams } from './params';

export interface EmbeddingHost {
  readonly doc: Document;
  /** 表示中のデータセットの表示（なければ null） */
  view(): DatasetView | null;
  /** 表示中のデータセットの、読み込んだ（事前計算の）データ */
  baseData(): LoadedDataset | null;
  /** データセットの切り替えの回数。切り替わったら、それまでの計算と結果を捨てる */
  generation(): number;
  /**
   * 表示を `data` で作り直す（点の大きさ・カメラの位置と向き・モード・速度・自動調整・目印とミニマップの表示・選択を引き継ぐ）。
   * 作れなければ前の表示を保ってエラーを投げる。
   */
  replaceView(data: LoadedDataset, options: { coloring: PointColoring | null }): DatasetView;
  /** URL の nn・md・seed を書き換える（null で外す）。履歴は増やさない */
  setUrlParams(params: UmapParams | null): void;
  /** 常に見える表示（データセットの選択欄の横）の文面。`computed` はブラウザで計算した埋め込みか */
  setEmbeddingStatus(text: string, computed: boolean): void;
}

/** 検証用の状態（`window.__explorer.umap.getState()`）。 */
export interface UmapFeatureState {
  loaded: true;
  /** 表示中のデータセットに kNN グラフがあり、使えるか */
  available: boolean;
  open: boolean;
  phase: 'idle' | 'loading' | 'running' | 'morphing';
  epoch: number;
  total: number;
  /** 表示中の埋め込み */
  current: { kind: 'precomputed' } | { kind: 'computed'; params: UmapParams; key: string };
  /** 保持している結果の鍵（古い順） */
  cache: string[];
  /** 直近に完走した計算 */
  lastRun: { key: string; initMs: number; optimizeMs: number; totalMs: number; epochs: number } | null;
  /** 直近に表示を切り替えたときの、点の平均の移動量（位置合わせあり・なし。前の表示の座標から） */
  lastAlignment: { key: string; aligned: number; unaligned: number; reflection: boolean } | null;
  /** 計算の途中の座標を点群へ反映した回数（計算ごとに 0 から） */
  previewUpdates: number;
  /** 直近の中断（「中断」を指示してから止まるまでのミリ秒と、止まったエポック） */
  lastCancel: { ms: number; epoch: number } | null;
  /** 直近の計算の結果（'done'・'cancelled'・'error'） */
  lastOutcome: 'done' | 'cancelled' | 'error' | null;
  error: string | null;
  /** kNN グラフを読み込んだか・Worker を作ったか */
  graphLoaded: boolean;
  workerStarted: boolean;
}
