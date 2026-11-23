/**
 * ミニマップの計算（DOM にも WebGL にも依存しない）。
 *
 * - 面と奥行き: ホームの視点（src/app/homeView.ts）のカメラの右・上・後ろを、そのままミニマップの横・縦・奥行きにする。
 *   ホームの視点は manifest の `overview.axes` の第3軸の方向から見て、第1軸が横、第2軸が縦に広がる（カメラは
 *   横に傾かないので、傾きなしに合わせられる範囲で合わせる）。同じ基底を使うので、ホームの視点で見える配置と
 *   ミニマップの配置が対応する。`overview` がなければ +Z から見る（横 +X、縦 +Y）。
 * - 範囲: 全点を面へ投影した座標の範囲の中心を中心とし、縦横の広いほうに余白を掛けた正方形。
 *   奥行きの目盛りも同じ中心・同じ縮尺（面の 1 辺と同じ長さ）にする。
 */
import { homeDirection } from '../app/homeView';
import type { Vec3 } from '../render/view';

export interface MinimapBasis {
  /** ミニマップの横（右が正） */
  right: Vec3;
  /** ミニマップの縦（上が正） */
  up: Vec3;
  /** 奥行き（ホームの視点の側＝手前が正） */
  back: Vec3;
}

export interface MinimapExtent {
  /** 面の座標（u, v）と奥行き（w）の中心 */
  center: Vec3;
  /** 正方形の半分の大きさ（ワールド単位）。奥行きの目盛りも ±half */
  half: number;
  /** 全点の奥行きの範囲 [最小, 最大] */
  depthRange: [number, number];
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MinimapLayout {
  /** 地図（正方形）の領域。CSS ピクセル、画面の左上が原点 */
  map: Rect;
  /** 奥行きの目盛りの領域（地図の左脇） */
  gauge: Rect;
  /** 地図と目盛りを合わせた領域 */
  outer: Rect;
}

/** 範囲に掛ける余白（点が枠に接しない）。 */
export const EXTENT_MARGIN = 1.08;
/** 描く点の数の上限。超えるときは間引く。 */
export const MAX_MINIMAP_POINTS = 20000;
/** 地図の 1 辺の大きさ（CSS ピクセル）の上限と下限、画面の短辺に対する割合。 */
export const MAP_SIZE_MAX = 200;
export const MAP_SIZE_MIN = 96;
export const MAP_SIZE_FRACTION = 0.3;
/** 画面の端からの余白、目盛りの幅、地図と目盛りの間（CSS ピクセル）。 */
export const LAYOUT_MARGIN = 12;
export const GAUGE_WIDTH = 18;
export const GAUGE_GAP = 4;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/**
 * ホームの視点のカメラの右・上・後ろ。three.js の `lookAt`（上は +Y）と同じ決め方：
 * 後ろ = 中心からカメラへの向き（`homeDirection`）、右 = 正規化(Y × 後ろ)、上 = 後ろ × 右。
 */
export function minimapBasis(axes?: readonly [Vec3, Vec3, Vec3] | null): MinimapBasis {
  const back = homeDirection(axes);
  const right = normalize(cross([0, 1, 0], back));
  const up = cross(back, right);
  return { right, up, back };
}

/** ワールド座標 → 面の座標 u（横）・v（縦）と奥行き w。 */
export function toPlane(p: Vec3, b: MinimapBasis): Vec3 {
  return [dot(p, b.right), dot(p, b.up), dot(p, b.back)];
}

/** 面の座標と奥行き → ワールド座標（`toPlane` の逆）。 */
export function fromPlane(q: Vec3, b: MinimapBasis): Vec3 {
  const [u, v, w] = q;
  return [
    b.right[0] * u + b.up[0] * v + b.back[0] * w,
    b.right[1] * u + b.up[1] * v + b.back[1] * w,
    b.right[2] * u + b.up[2] * v + b.back[2] * w,
  ];
}

/** 全点（`positions` は x, y, z の並び）が収まる正方形の範囲と、奥行きの範囲。 */
export function computeExtent(positions: ArrayLike<number>, b: MinimapBasis, margin: number = EXTENT_MARGIN): MinimapExtent {
  const n = Math.floor(positions.length / 3);
  const mn: Vec3 = [Infinity, Infinity, Infinity];
  const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const q = toPlane([positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!], b);
    for (let k = 0; k < 3; k++) {
      if (q[k]! < mn[k]!) mn[k] = q[k]!;
      if (q[k]! > mx[k]!) mx[k] = q[k]!;
    }
  }
  if (n === 0) return { center: [0, 0, 0], half: 1, depthRange: [0, 0] };
  const center: Vec3 = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const extent = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  const half = Math.max(1e-6, (extent / 2) * margin);
  return { center, half, depthRange: [mn[2], mx[2]] };
}

/**
 * 画面（CSS ピクセル）の右下に置く地図と、その左脇の奥行きの目盛りの領域。
 * 地図の 1 辺は画面の短辺の 30% を [96, 200] に収めた値（整数）。画面が小さいときは縮む。
 */
export function computeLayout(viewWidth: number, viewHeight: number): MinimapLayout {
  const short = Math.max(0, Math.min(viewWidth, viewHeight));
  const size = Math.round(Math.min(MAP_SIZE_MAX, Math.max(MAP_SIZE_MIN, short * MAP_SIZE_FRACTION)));
  const map: Rect = { left: Math.round(viewWidth) - LAYOUT_MARGIN - size, top: Math.round(viewHeight) - LAYOUT_MARGIN - size, width: size, height: size };
  const gauge: Rect = { left: map.left - GAUGE_GAP - GAUGE_WIDTH, top: map.top, width: GAUGE_WIDTH, height: size };
  const outer: Rect = { left: gauge.left, top: map.top, width: map.left + size - gauge.left, height: size };
  return { map, gauge, outer };
}

/** 面の座標 → 地図の中の位置（地図の左上が原点、CSS ピクセル。下向きが y の正）。 */
export function planeToMap(u: number, v: number, e: MinimapExtent, size: number): [number, number] {
  return [((u - e.center[0]) / e.half + 1) * 0.5 * size, (1 - (v - e.center[1]) / e.half) * 0.5 * size];
}

/** 地図の中の位置 → 面の座標（`planeToMap` の逆）。 */
export function mapToPlane(x: number, y: number, e: MinimapExtent, size: number): [number, number] {
  return [e.center[0] + ((2 * x) / size - 1) * e.half, e.center[1] + (1 - (2 * y) / size) * e.half];
}

/** 奥行き w → 目盛りの中の高さ（上端が 0。上が手前＝w の大きいほう）。 */
export function depthToGauge(w: number, e: MinimapExtent, height: number): number {
  return (1 - (w - e.center[2]) / e.half) * 0.5 * height;
}

/**
 * 地図の中の位置を、枠から `inset` だけ内側の範囲に収める。範囲の外なら `outside` が真になり、
 * 位置は中心から元の位置へ向かう線が範囲の縁と交わる点になる（向きを保つ）。
 */
export function clampToFrame(x: number, y: number, size: number, inset: number): { x: number; y: number; outside: boolean } {
  const c = size / 2;
  const lim = Math.max(0, c - inset);
  const dx = x - c, dy = y - c;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  if (m <= lim || !Number.isFinite(m)) return { x, y, outside: false };
  const k = lim / m;
  return { x: c + dx * k, y: c + dy * k, outside: true };
}

/** 0..1 の値を [lo, hi] に収め、外なら outside。 */
export function clampRange(value: number, lo: number, hi: number): { value: number; outside: boolean } {
  if (value < lo) return { value: lo, outside: true };
  if (value > hi) return { value: hi, outside: true };
  return { value, outside: false };
}

/**
 * 描く点の番号。`count` が `limit` 以下なら全点、超えるなら等間隔に `limit` 点を選ぶ（決定的）。
 */
export function sampleIndices(count: number, limit: number = MAX_MINIMAP_POINTS): Uint32Array {
  const n = Math.max(0, Math.floor(count));
  const m = Math.max(0, Math.floor(limit));
  if (n <= m) return Uint32Array.from({ length: n }, (_, i) => i);
  const out = new Uint32Array(m);
  for (let k = 0; k < m; k++) out[k] = Math.floor((k * n) / m);
  return out;
}

export interface ViewFigureInput {
  /** カメラの前・右・上（単位ベクトル、ワールド座標） */
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** 縦の視野角（度）と縦横比 */
  fovDeg: number;
  aspect: number;
}

export interface ViewFigure {
  /** 視線を面へ投影した向き（地図の中の単位ベクトル。下向きが y の正）。視線が面にほぼ垂直なら [0, 0] */
  heading: [number, number];
  /** 視線のうち面に沿った成分の長さ（0..1）。1 なら面に平行、0 なら奥行きの方向を向いている */
  headingLength: number;
  /** 視野の 4 隅の向きを面へ投影した点（地図の中、長さ 1 あたり。カメラの位置からの相対） */
  corners: [number, number][];
  /** カメラの位置（原点）と 4 隅を囲む凸包（地図の中の相対位置、長さ 1 あたり） */
  hull: [number, number][];
}

/** カメラの視線と視野の広がりを、ミニマップの面へ投影した図形。 */
export function viewFigure(input: ViewFigureInput, b: MinimapBasis): ViewFigure {
  const { forward, right, up } = input;
  const tv = Math.tan((input.fovDeg * Math.PI) / 360);
  const th = tv * (Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 1);
  // 地図の中の向き: 横は right、縦は up（画面の下向きが正なので符号を反転）
  const toMap = (d: Vec3): [number, number] => [dot(d, b.right), -dot(d, b.up)];
  const f = toMap(forward);
  const fl = Math.hypot(f[0], f[1]);
  const heading: [number, number] = fl > 1e-6 ? [f[0] / fl, f[1] / fl] : [0, 0];
  const corners: [number, number][] = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const d = normalize([
      forward[0] + right[0] * sx * th + up[0] * sy * tv,
      forward[1] + right[1] * sx * th + up[1] * sy * tv,
      forward[2] + right[2] * sx * th + up[2] * sy * tv,
    ]);
    corners.push(toMap(d));
  }
  return { heading, headingLength: Math.min(1, fl), corners, hull: convexHull([[0, 0], ...corners]) };
}

/** 2 次元の点の凸包（反時計回り、Andrew の単調鎖）。点が 2 個以下ならそのまま。 */
export function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cr = (o: [number, number], a: [number, number], c: [number, number]) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cr(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cr(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** 奥行きの分布（目盛りに出すヒストグラム）。`bins` 個の区間に [center-half, center+half] を分け、各区間の点数の最大値で割った値。 */
export function depthHistogram(positions: ArrayLike<number>, b: MinimapBasis, e: MinimapExtent, bins: number): number[] {
  const h = new Array<number>(bins).fill(0);
  const n = Math.floor(positions.length / 3);
  for (let i = 0; i < n; i++) {
    const w = dot([positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!], b.back);
    const t = (w - (e.center[2] - e.half)) / (2 * e.half);
    const k = Math.min(bins - 1, Math.max(0, Math.floor(t * bins)));
    h[k]!++;
  }
  const max = Math.max(1, ...h);
  return h.map((c) => c / max);
}

/** HUD の操作説明（3 行目）の末尾に、ミニマップの切り替えキーを足す。 */
export function withMinimapHelp(hudText: string): string {
  const lines = hudText.split('\n');
  if (lines.length < 3) return hudText;
  lines[2] = `${lines[2]} / M ミニマップ`;
  return lines.join('\n');
}
