/**
 * 空間の構造（全体の範囲・密度・主成分軸・ラベルごとのまとまり）と、その空間索引を計算する Web Worker
 * （ブラウザ内の UMAP の再計算を使うときにだけ読み込まれる、別のチャンク）。計算は `structureRun.ts`。
 * 点数に比例して時間がかかる（7 万点で秒に近い）ので、メインスレッドで計算して描画を止めないよう、ここで行う。
 */
import type { StructureReply, StructureRequest } from './protocol';
import { handleStructureRequest } from './structureRun';

interface WorkerScope {
  postMessage(message: StructureReply, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<StructureRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  const { reply, transfer } = handleStructureRequest(ev.data);
  scope.postMessage(reply, transfer);
};
