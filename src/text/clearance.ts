/**
 * 単語の文字の周りの丸い点を小さくする判定。DOM と WebGL に依存しない。
 *
 * クラスタの縁や少し外から見ると、単語の文字（その点の色）と同じ色の丸い点が、文字の周りに密集して読みにくくする。
 * そこで、表示中の単語の画面上の矩形（縁取りを含む）を `marginPx` 広げた範囲に中心が入る丸い点を、`DOT_CLEARANCE_SCALE` 倍に縮める。
 * 丸い点の倍率はピッキングと共有するので、選ばれる形も同じだけ小さくなる（吸着の半径で選べる）。
 */
import { projectPoint, type ScreenRect, type SelectView } from './selection';

/** 単語の周りの丸い点の半径の倍率 */
export const DOT_CLEARANCE_SCALE = 0.4;
/** 単語の矩形を広げる幅（CSS ピクセル。丸い点の半径の上限 5 より少し小さい） */
export const DOT_CLEARANCE_MARGIN_PX = 4;

/**
 * `candidates`（点の番号。null なら全点）のうち、画面へ投影した中心が、いずれかの矩形を `marginPx` 広げた範囲に入るものの番号。
 * `exclude`（文字を出している点）は除く。
 * 丸い点は、カメラから離れていても半径の上限の大きさで描かれる（word2vec では距離 0.67 まで直径 10px）ので、
 * 文字の候補（カメラに近い点）だけでなく全点を見る。投影は 1 点あたり数十回の演算で、1 万点でも 1 ミリ秒ほど。
 */
export function pointsNearRects(candidates: ArrayLike<number> | null, positions: ArrayLike<number>, view: SelectView,
  rects: readonly ScreenRect[], marginPx: number, exclude: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  if (!rects.length) return out;
  // 矩形の外接範囲で先に絞る
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x - r.width / 2); maxX = Math.max(maxX, r.x + r.width / 2);
    minY = Math.min(minY, r.y - r.height / 2); maxY = Math.max(maxY, r.y + r.height / 2);
  }
  const n = candidates ? candidates.length : Math.floor(positions.length / 3);
  for (let k = 0; k < n; k++) {
    const i = candidates ? candidates[k]! : k;
    if (exclude.has(i)) continue;
    const q = projectPoint(view, positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!);
    if (!q) continue;
    const x = (q.ndcX + 1) / 2 * view.width;
    const y = (1 - q.ndcY) / 2 * view.height;
    if (x < minX - marginPx || x > maxX + marginPx || y < minY - marginPx || y > maxY + marginPx) continue;
    for (const r of rects) {
      if (Math.abs(x - r.x) <= r.width / 2 + marginPx && Math.abs(y - r.y) <= r.height / 2 + marginPx) { out.add(i); break; }
    }
  }
  return out;
}
