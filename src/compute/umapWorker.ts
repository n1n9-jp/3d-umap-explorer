/**
 * UMAP を計算する Web Worker（ブラウザ内の UMAP の再計算を使うときにだけ読み込まれる、別のチャンク）。
 * メッセージの形は `protocol.ts`、計算の手順は `umapRun.ts`。座標は transfer で渡し、コピーしない。
 */
import type { FromWorker, ToWorker } from './protocol';
import { knnInput, runUmap, yieldToEventLoop } from './umapRun';

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let graph: Extract<ToWorker, { type: 'graph' }> | null = null;
/** 実行中の計算（同時に 1 つだけ） */
let active: { id: number; cancel: boolean; previewMs: number; lastPreview: number } | null = null;
/** 実行中の計算が終わるまで、次の計算を待たせる */
let queue: Promise<void> = Promise.resolve();
/** 始まる前に中断を指示された計算 */
const cancelledEarly = new Set<number>();

scope.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'graph':
      graph = m;
      break;
    case 'cancel':
      if (active && active.id === m.id) active.cancel = true;
      else cancelledEarly.add(m.id);
      break;
    case 'preview':
      if (active && active.id === m.id) active.previewMs = m.previewMs;
      break;
    case 'run':
      queue = queue.then(() => run(m));
      break;
  }
};

async function run(m: Extract<ToWorker, { type: 'run' }>): Promise<void> {
  if (cancelledEarly.delete(m.id)) {
    scope.postMessage({ type: 'cancelled', id: m.id, epoch: 0 });
    return;
  }
  const state = { id: m.id, cancel: false, previewMs: m.previewMs, lastPreview: -Infinity };
  active = state;
  try {
    if (!graph) throw new Error('kNN グラフがまだ届いていません');
    const { idx, dist } = knnInput(graph.indices, graph.distances, graph.count, graph.k, m.params.nNeighbors);
    const result = await runUmap({
      count: graph.count, idx, dist, params: m.params, nEpochs: m.nEpochs, chunkEpochs: m.chunkEpochs,
      onReady: (initMs) => scope.postMessage({ type: 'ready', id: m.id, initMs }),
      onChunk: (epoch, total, embedding) => {
        scope.postMessage({ type: 'progress', id: m.id, epoch, total });
        const now = performance.now();
        if (state.previewMs > 0 && epoch < total && now - state.lastPreview >= state.previewMs) {
          state.lastPreview = now;
          const positions = new Float32Array(embedding); // 再利用されるバッファなのでコピーし、それを transfer する
          scope.postMessage({ type: 'snapshot', id: m.id, epoch, total, positions }, [positions.buffer]);
        }
      },
      shouldCancel: () => state.cancel,
      yieldFn: yieldToEventLoop,
    });
    if (result.cancelled || !result.embedding) {
      scope.postMessage({ type: 'cancelled', id: m.id, epoch: result.epochs });
    } else {
      const positions = result.embedding;
      scope.postMessage(
        { type: 'done', id: m.id, positions, epochs: result.epochs, initMs: result.initMs, optimizeMs: result.optimizeMs },
        [positions.buffer],
      );
    }
  } catch (e) {
    scope.postMessage({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) });
  } finally {
    if (active === state) active = null;
  }
}
