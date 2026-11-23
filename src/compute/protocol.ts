/** メインスレッドと UMAP の Worker（`umapWorker.ts`）の間のメッセージ。 */
import type { ManifestBounds, ManifestClusters, ManifestDensity, ManifestOverview } from '../data/manifest';
import type { SpatialIndexData } from '../spatial/SpatialIndex';
import type { UmapParams } from './params';

export type ToWorker =
  /** kNN グラフ（自分自身を含まない k 列）。データセットごとに 1 回送る */
  | { type: 'graph'; count: number; k: number; indices: Uint16Array | Uint32Array; distances: Float32Array }
  /** 計算の開始。`previewMs` が 0 より大きければ、その間隔以上あけて途中の座標を送る（0 なら送らない） */
  | { type: 'run'; id: number; params: UmapParams; nEpochs: number; chunkEpochs: number; previewMs: number }
  /** 途中の座標を送るかを、計算中に切り替える */
  | { type: 'preview'; id: number; previewMs: number }
  | { type: 'cancel'; id: number };

export type FromWorker =
  /** 初期化（グラフの構築とスペクトル初期化）が終わった */
  | { type: 'ready'; id: number; initMs: number }
  | { type: 'progress'; id: number; epoch: number; total: number }
  /** 途中の座標（transfer）。正規化・位置合わせの前の値 */
  | { type: 'snapshot'; id: number; epoch: number; total: number; positions: Float32Array }
  /** 計算した座標（transfer）。正規化・位置合わせの前の値 */
  | { type: 'done'; id: number; positions: Float32Array; epochs: number; initMs: number; optimizeMs: number }
  | { type: 'cancelled'; id: number; epoch: number }
  | { type: 'error'; id: number; message: string };

// ---------------------------------------------------------------- 空間の構造の計算（structureWorker.ts）

/** 座標から空間の構造を計算する依頼（メインスレッド → 構造の Worker。座標とラベルはコピーして渡す） */
export interface StructureRequest {
  type: 'structure';
  positions: Float32Array;
  /** ラベル（ラベルのあるデータセットだけ） */
  labels: Uint8Array | null;
  names: string[] | null;
}

/** 構造の計算の結果（Worker → メインスレッド。空間索引の配列は transfer で渡す） */
export type StructureReply =
  | {
    type: 'done';
    bounds: ManifestBounds;
    density: ManifestDensity;
    overview: ManifestOverview;
    groups: { clusters: ManifestClusters; ids: Uint16Array } | null;
    index: SpatialIndexData;
  }
  | { type: 'error'; message: string };
