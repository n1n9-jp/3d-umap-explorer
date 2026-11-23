/**
 * 空間の構造の計算の依頼を処理する（構造の Worker の中で使う。DOM に依存しないので Node のテストでも動く）。
 * 結果の配列は transfer で返す。
 */
import type { StructureReply, StructureRequest } from './protocol';
import { computeStructure } from './structure';

export function handleStructureRequest(req: StructureRequest): { reply: StructureReply; transfer: Transferable[] } {
  try {
    const r = computeStructure(req.positions, req.labels, req.names);
    const index = r.index.toData();
    const transfer: Transferable[] = [index.pts.buffer, index.ids.buffer, index.splitAxis.buffer, index.boxes.buffer];
    if (r.groups) transfer.push(r.groups.ids.buffer);
    return {
      reply: { type: 'done', bounds: r.bounds, density: r.density, overview: r.overview, groups: r.groups, index },
      transfer,
    };
  } catch (e) {
    return { reply: { type: 'error', message: e instanceof Error ? e.message : String(e) }, transfer: [] };
  }
}
