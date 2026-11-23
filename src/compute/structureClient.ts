/**
 * 空間の構造の計算（`structureWorker.ts`）をメインスレッドから呼ぶ。計算ごとに Worker を 1 つ作り、終わったら止める
 * （構造の計算は、計算した座標を表示へ切り替えるときに 1 回だけなので、作り直しの費用は小さい）。
 */
import { SpatialIndex } from '../spatial/SpatialIndex';
import type { StructureReply, StructureRequest } from './protocol';
import type { StructureResult } from './structure';

/** `Worker` のうち、ここで使う部分（テストで差し替える）。 */
export interface StructureWorkerLike {
  onmessage: ((ev: { data: StructureReply }) => void) | null;
  onerror: ((ev: { message?: string; preventDefault?(): void }) => void) | null;
  postMessage(message: StructureRequest): void;
  terminate(): void;
}

/** 計算を打ち切った（データセットが切り替わったなど）ときの拒否の理由。 */
export class StructureAborted extends Error {
  constructor() {
    super('空間の構造の計算を打ち切りました');
    this.name = 'StructureAborted';
  }
}

export interface StructureJob {
  /** 計算の結果。`abort()` されると `StructureAborted` で拒否する */
  promise: Promise<StructureResult>;
  /** 計算を打ち切って、Worker を止める（終わったあとに呼んでも害はない） */
  abort(): void;
}

const createDefaultWorker = (): StructureWorkerLike =>
  new Worker(new URL('./structureWorker.ts', import.meta.url), { type: 'module', name: 'umap-structure' }) as unknown as StructureWorkerLike;

/**
 * 座標から空間の構造を Worker で計算する。`positions` は Worker へコピーして渡すので、呼んだあとも使える。
 * 結果の空間索引は、Worker が構築したものを `positions` に結びつけて返す（メインスレッドでは構築しない）。
 */
export function startStructureJob(
  positions: Float32Array, labels: Uint8Array | null, names: string[] | null,
  createWorker: () => StructureWorkerLike = createDefaultWorker,
): StructureJob {
  let worker: StructureWorkerLike | null = null;
  let settle: { resolve(r: StructureResult): void; reject(e: unknown): void } | null = null;
  const finish = () => {
    worker?.terminate();
    worker = null;
  };
  const promise = new Promise<StructureResult>((resolve, reject) => {
    settle = { resolve, reject };
    try {
      worker = createWorker();
    } catch (e) {
      settle = null;
      reject(e);
      return;
    }
    const w = worker;
    w.onmessage = (ev) => {
      const m = ev.data;
      finish();
      if (m.type === 'error') { reject(new Error(`空間の構造を計算できませんでした: ${m.message}`)); return; }
      try {
        resolve({
          bounds: m.bounds, density: m.density, overview: m.overview, groups: m.groups,
          index: new SpatialIndex(positions, m.index),
        });
      } catch (e) {
        reject(e);
      }
    };
    w.onerror = (ev) => {
      ev.preventDefault?.();
      finish();
      reject(new Error(`空間の構造を計算する Worker でエラーが起きました: ${ev.message || '不明'}`));
    };
    w.postMessage({ type: 'structure', positions: new Float32Array(positions), labels: labels ? new Uint8Array(labels) : null, names });
  });
  return {
    promise,
    abort: () => {
      if (!worker) return;
      finish();
      settle?.reject(new StructureAborted());
    },
  };
}
