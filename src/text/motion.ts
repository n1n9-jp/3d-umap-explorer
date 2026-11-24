/**
 * カメラが速く動く間の、単語の選び直しの間隔と、障害物との間隔の余裕。DOM と WebGL に依存しない。
 *
 * 単語の矩形（障害物との重なりの判定）は、最後に選び直したときの位置なので、カメラが速く回る間は、選び直しの間（最大 0.1 秒）に
 * 単語が画面上で大きく動いて、UI や目印と一瞬重なる。そこで、表示中の単語の基準点が、最後に選び直したときの位置から動いた量
 * （`motionPx`）を見て、
 * - 動きが大きい間は、選び直しの間隔を短くする（ただし、選び直し 1 回の時間の `COST_FACTOR` 倍以上は空けて、負荷を抑える）、
 * - 次の選び直しまでに動く量を見込んで、障害物との間隔を広げる（動いて重なる手前から外し始める）。
 */
/** 動きが小さいときの選び直しの間隔の下限（ミリ秒） */
export const BASE_INTERVAL_MS = 100;
/** 動きが大きいときの選び直しの間隔の下限（ミリ秒。60 fps で 2 フレーム） */
export const FAST_INTERVAL_MS = 33;
/** 表示中の単語の基準点が、最後に選び直したときの位置からこれ以上動いたら「速い」とみなす（CSS ピクセル） */
export const FAST_MOTION_PX = 16;
/** 選び直しの間隔は、選び直し 1 回の時間のこの倍数以上にする（選び直しが CPU 時間の 1/6 以下になる） */
export const COST_FACTOR = 6;
/** 障害物との間隔の余裕を見積もる時間（秒）。この間の単語の動きの分だけ、間隔を広げる */
export const MARGIN_HORIZON_S = 0.1;
/** 障害物との間隔の余裕の上限（CSS ピクセル） */
export const MAX_MOTION_MARGIN_PX = 48;

/** 選び直しの間隔（ミリ秒）。動きが `FAST_MOTION_PX` 未満なら 100、以上なら 33 と `COST_FACTOR × lastSelectMs` の大きいほう（100 を超えない）。 */
export function selectIntervalMs(motionPx: number, lastSelectMs: number): number {
  if (!(motionPx >= FAST_MOTION_PX)) return BASE_INTERVAL_MS;
  const cost = Number.isFinite(lastSelectMs) && lastSelectMs > 0 ? COST_FACTOR * lastSelectMs : 0;
  return Math.min(BASE_INTERVAL_MS, Math.max(FAST_INTERVAL_MS, cost));
}

/**
 * 障害物との間隔に足す余裕（CSS ピクセル）。最後の選び直しから `elapsedMs` の間に `motionPx` 動いたとして、
 * その速さで `MARGIN_HORIZON_S` 秒に動く量（`MAX_MOTION_MARGIN_PX` まで）。
 */
export function motionMarginPx(motionPx: number, elapsedMs: number): number {
  if (!(motionPx > 0) || !(elapsedMs > 0)) return 0;
  const speed = motionPx / (Math.max(elapsedMs, FAST_INTERVAL_MS / 2) / 1000);
  return Math.min(MAX_MOTION_MARGIN_PX, speed * MARGIN_HORIZON_S);
}

/** 基準点の画面上の位置の、前回からの最大の移動量（CSS ピクセル）。カメラの後ろへ回った点（`null`）は、上限の `Infinity` ではなく大きな値として数える。 */
export function maxAnchorDisplacement(before: readonly { x: number; y: number }[], now: readonly ({ x: number; y: number } | null)[]): number {
  let max = 0;
  const n = Math.min(before.length, now.length);
  for (let i = 0; i < n; i++) {
    const a = now[i];
    const d = a ? Math.hypot(a.x - before[i]!.x, a.y - before[i]!.y) : 1e4;
    if (d > max) max = d;
  }
  return max;
}
