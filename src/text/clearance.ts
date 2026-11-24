/**
 * 単語の文字の周りの丸い点を小さくする判定。DOM と WebGL に依存しない。
 *
 * クラスタの縁や少し外から見ると、単語の文字（その点の色）と同じ色の丸い点が、文字の周りに密集して読みにくくする。
 * そこで、表示中の単語の画面上の矩形（縁取りを含む）を `marginPx` 広げた範囲に中心が入る丸い点を、`DOT_CLEARANCE_SCALE` 倍に縮める。
 * 丸い点の倍率はピッキングと共有するので、選ばれる形も同じだけ小さくなる（吸着の半径で選べる）。
 */
import type { ScreenRect, SelectView } from './selection';

/** 単語の周りの丸い点の半径の倍率 */
export const DOT_CLEARANCE_SCALE = 0.4;
/** 単語の矩形を広げる幅（CSS ピクセル。丸い点の半径の上限 5 より少し小さい） */
export const DOT_CLEARANCE_MARGIN_PX = 4;

/** 点の領域の問い合わせ（src/spatial/SpatialIndex.ts の `forEachInBoxes`）。DOM・WebGL に依存しないよう、必要な形だけを取る。 */
export interface BoxQueryIndex {
  forEachInBoxes(
    mayContain: (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) => boolean,
    visit: (id: number, x: number, y: number, z: number) => void,
  ): void;
}

/** 矩形を引く格子のタイルの大きさ（CSS ピクセル） */
const TILE_PX = 16;
/** タイルの範囲を決めるときの、浮動小数点の丸めに対する余裕（CSS ピクセル）。境界の点を取りこぼさない */
const TILE_SLACK_PX = 1e-6;

/**
 * 点を画面（CSS ピクセル）へ投影する関数を作る。`selection.ts` の `projectPoint` と同じ式で、結果を `out`（[x, y]）へ書き、
 * 投影できれば true（カメラの後ろなら false）。点ごとにオブジェクトを作らない。
 */
function screenProjector(v: SelectView): (x: number, y: number, z: number, out: Float64Array) => boolean {
  const m = v.view, p = v.projection;
  const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m8 = m[8]!, m9 = m[9]!, m10 = m[10]!, m12 = m[12]!, m13 = m[13]!, m14 = m[14]!;
  const p0 = p[0]!, p1 = p[1]!, p3 = p[3]!, p4 = p[4]!, p5 = p[5]!, p7 = p[7]!, p8 = p[8]!, p9 = p[9]!, p11 = p[11]!, p12 = p[12]!, p13 = p[13]!, p15 = p[15]!;
  const w = v.width, h = v.height;
  return (x, y, z, out) => {
    const vz = m2 * x + m6 * y + m10 * z + m14;
    if (vz >= 0) return false;
    const vx = m0 * x + m4 * y + m8 * z + m12;
    const vy = m1 * x + m5 * y + m9 * z + m13;
    const cw = p3 * vx + p7 * vy + p11 * vz + p15;
    if (!(cw > 0)) return false;
    const cx = p0 * vx + p4 * vy + p8 * vz + p12;
    const cy = p1 * vx + p5 * vy + p9 * vz + p13;
    out[0] = (cx / cw + 1) / 2 * w;
    out[1] = (1 - cy / cw) / 2 * h;
    return true;
  };
}

/**
 * 矩形（`marginPx` 広げたもの）を、タイルの格子に登録して、点がどれかの矩形に入るかを、その点のタイルの矩形だけを調べて答える。
 * 判定の式は `Math.abs(x − r.x) <= r.width / 2 + marginPx`（全矩形を総当たりで調べた場合と同じ）。
 * タイルごとの有無の累積和で、画面上の範囲が矩形のあるタイルと交わるかも、一定時間で答える（木の範囲の枝刈り用）。
 */
class RectGrid {
  /** 広げた矩形の外接範囲（格子の範囲） */
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly sum: Int32Array;
  private readonly rx: Float64Array;
  private readonly ry: Float64Array;
  private readonly rw: Float64Array;
  private readonly rh: Float64Array;

  constructor(rects: readonly ScreenRect[], marginPx: number) {
    const n = rects.length;
    this.rx = new Float64Array(n); this.ry = new Float64Array(n); this.rw = new Float64Array(n); this.rh = new Float64Array(n);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < n; k++) {
      const r = rects[k]!;
      this.rx[k] = r.x; this.ry[k] = r.y;
      this.rw[k] = r.width / 2 + marginPx; this.rh[k] = r.height / 2 + marginPx;
      minX = Math.min(minX, r.x - this.rw[k]!); maxX = Math.max(maxX, r.x + this.rw[k]!);
      minY = Math.min(minY, r.y - this.rh[k]!); maxY = Math.max(maxY, r.y + this.rh[k]!);
    }
    minX -= TILE_SLACK_PX; minY -= TILE_SLACK_PX; maxX += TILE_SLACK_PX; maxY += TILE_SLACK_PX;
    this.minX = minX; this.maxX = maxX; this.minY = minY; this.maxY = maxY;
    const cols = Math.max(1, Math.floor((maxX - minX) / TILE_PX) + 1);
    const rows = Math.max(1, Math.floor((maxY - minY) / TILE_PX) + 1);
    this.cols = cols; this.rows = rows;
    // 矩形ごとのタイルの範囲を数えて、CSR の形（タイルごとの矩形の番号の並び）にする
    const c0 = new Int32Array(n), c1 = new Int32Array(n), r0 = new Int32Array(n), r1 = new Int32Array(n);
    const count = new Int32Array(cols * rows + 1);
    for (let k = 0; k < n; k++) {
      c0[k] = Math.max(0, Math.floor((this.rx[k]! - this.rw[k]! - TILE_SLACK_PX - minX) / TILE_PX));
      c1[k] = Math.min(cols - 1, Math.floor((this.rx[k]! + this.rw[k]! + TILE_SLACK_PX - minX) / TILE_PX));
      r0[k] = Math.max(0, Math.floor((this.ry[k]! - this.rh[k]! - TILE_SLACK_PX - minY) / TILE_PX));
      r1[k] = Math.min(rows - 1, Math.floor((this.ry[k]! + this.rh[k]! + TILE_SLACK_PX - minY) / TILE_PX));
      for (let j = r0[k]!; j <= r1[k]!; j++) for (let i = c0[k]!; i <= c1[k]!; i++) count[j * cols + i + 1]!++;
    }
    for (let t = 0; t < cols * rows; t++) count[t + 1]! += count[t]!;
    this.start = count;
    this.items = new Int32Array(count[cols * rows]!);
    const fill = count.slice(0, cols * rows);
    for (let k = 0; k < n; k++) {
      for (let j = r0[k]!; j <= r1[k]!; j++) for (let i = c0[k]!; i <= c1[k]!; i++) this.items[fill[j * cols + i]!++] = k;
    }
    // タイルに矩形があるかの 2 次元の累積和
    const stride = cols + 1;
    const sum = new Int32Array((rows + 1) * stride);
    for (let j = 1; j <= rows; j++) {
      for (let i = 1; i <= cols; i++) {
        const has = count[(j - 1) * cols + i]! > count[(j - 1) * cols + i - 1]! ? 1 : 0;
        sum[j * stride + i] = has + sum[(j - 1) * stride + i]! + sum[j * stride + i - 1]! - sum[(j - 1) * stride + i - 1]!;
      }
    }
    this.sum = sum;
  }

  /** 画面上の点 (x, y) が、広げた矩形のどれかに入るか。 */
  hit(x: number, y: number): boolean {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false;
    const i = Math.min(this.cols - 1, Math.floor((x - this.minX) / TILE_PX));
    const j = Math.min(this.rows - 1, Math.floor((y - this.minY) / TILE_PX));
    const t = j * this.cols + i;
    const end = this.start[t + 1]!;
    for (let q = this.start[t]!; q < end; q++) {
      const k = this.items[q]!;
      if (Math.abs(x - this.rx[k]!) <= this.rw[k]! && Math.abs(y - this.ry[k]!) <= this.rh[k]!) return true;
    }
    return false;
  }

  /** 画面上の範囲 [x0, x1] × [y0, y1] が、矩形のあるタイルと交わる（かもしれない）か。 */
  anyIn(x0: number, x1: number, y0: number, y1: number): boolean {
    if (x1 < this.minX || x0 > this.maxX || y1 < this.minY || y0 > this.maxY) return false;
    const c0 = Math.max(0, Math.floor((x0 - this.minX) / TILE_PX)), c1 = Math.min(this.cols - 1, Math.floor((x1 - this.minX) / TILE_PX));
    const r0 = Math.max(0, Math.floor((y0 - this.minY) / TILE_PX)), r1 = Math.min(this.rows - 1, Math.floor((y1 - this.minY) / TILE_PX));
    const stride = this.cols + 1;
    const s = this.sum;
    return s[(r1 + 1) * stride + c1 + 1]! - s[r0 * stride + c1 + 1]! - s[(r1 + 1) * stride + c0]! + s[r0 * stride + c0]! > 0;
  }
}

/**
 * `candidates`（点の番号。null なら全点）のうち、画面へ投影した中心が、いずれかの矩形を `marginPx` 広げた範囲に入るものの番号。
 * `exclude`（文字を出している点）は除く。
 * 丸い点は、カメラから離れていても半径の上限の大きさで描かれる（word2vec では距離 0.67 まで直径 10px）ので、
 * 文字の候補（カメラに近い点）だけでなく全点を見る。矩形はタイルの格子に登録して、点ごとに、その点のタイルの矩形だけを調べる。
 */
export function pointsNearRects(candidates: ArrayLike<number> | null, positions: ArrayLike<number>, view: SelectView,
  rects: readonly ScreenRect[], marginPx: number, exclude: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  if (!rects.length) return out;
  const grid = new RectGrid(rects, marginPx);
  const project = screenProjector(view);
  const xy = new Float64Array(2);
  const n = candidates ? candidates.length : Math.floor(positions.length / 3);
  for (let k = 0; k < n; k++) {
    const i = candidates ? candidates[k]! : k;
    if (!project(positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!, xy)) continue;
    if (!grid.hit(xy[0]!, xy[1]!)) continue;
    if (exclude.has(i)) continue;
    out.add(i);
  }
  return out;
}

/**
 * `pointsNearRects(null, …)`（全点）と同じ結果を、空間索引の木を巡って求める。
 *
 * 木の範囲ごとの外接箱を画面へ投影し、投影した範囲が、矩形（`marginPx` 広げたもの）のどれとも交わらない範囲を、点ごとの投影をせずに飛ばす。
 * カメラの後ろにある範囲と、矩形のない画面の領域に投影される範囲が、まとめて飛ぶ。残った範囲の点は、全点の場合と同じ判定をする。
 * 箱の判定は保守的（箱が矩形と交わるときは必ず残す）なので、結果は全点を調べた場合と一致する。
 */
export function pointsNearRectsIndexed(index: BoxQueryIndex, view: SelectView, rects: readonly ScreenRect[], marginPx: number,
  exclude: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  if (!rects.length) return out;
  const grid = new RectGrid(rects, marginPx);
  const m = view.view, p = view.projection;
  const w = view.width, h = view.height;
  // 範囲の外接箱の 8 隅を投影して、画面上の範囲を作る（8 隅がすべてカメラの前なら、投影した範囲の凸包が箱の像になる）
  const mayContain = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean => {
    let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
    let behindZ = 0, behindW = 0;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? x1 : x0, y = k & 2 ? y1 : y0, z = k & 4 ? z1 : z0;
      const vx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      const vy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      const vz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      const cw = p[3]! * vx + p[7]! * vy + p[11]! * vz + p[15]!;
      if (vz >= 0) behindZ++;
      if (!(cw > 0)) behindW++;
      if (vz >= 0 || !(cw > 0)) continue;
      const cx = p[0]! * vx + p[4]! * vy + p[8]! * vz + p[12]!;
      const cy = p[1]! * vx + p[5]! * vy + p[9]! * vz + p[13]!;
      const sx = (cx / cw + 1) / 2 * w, sy = (1 - cy / cw) / 2 * h;
      if (sx < sx0) sx0 = sx;
      if (sx > sx1) sx1 = sx;
      if (sy < sy0) sy0 = sy;
      if (sy > sy1) sy1 = sy;
    }
    if (behindZ === 8 || behindW === 8) return false; // 全部がカメラの後ろ（どの点も投影されない）
    if (behindZ > 0 || behindW > 0) return true; // 手前をまたぐ箱は、画面上の範囲を決められないので残す
    return grid.anyIn(sx0 - 0.5, sx1 + 0.5, sy0 - 0.5, sy1 + 0.5);
  };
  const project = screenProjector(view);
  const xy = new Float64Array(2);
  index.forEachInBoxes(mayContain, (i, x, y, z) => {
    if (!project(x, y, z, xy)) return;
    if (!grid.hit(xy[0]!, xy[1]!)) return;
    if (exclude.has(i)) return;
    out.add(i);
  });
  return out;
}
