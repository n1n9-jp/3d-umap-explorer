import { MAX_VIEW_PITCH, type Vec3, type ViewSpec } from '../render/view';

/**
 * 点群全体が画面に収まる「ホーム」の視点。DOM にも three.js にも依存しない。
 *
 * - 距離: 全点を含む球（中心 `center`、半径 `radius`）が、縦と横の両方の視野に収まる最小の距離に、余白を掛ける。
 *   球は視錐台の側面の平面すべてから半径以上離れていればよいので、距離は `radius / sin(半視野角)`。
 *   視野角の小さいほう（縦長の画面では横、横長の画面では縦）で決まる。
 * - 向き: manifest の `overview.axes`（主成分分析の第1〜第3軸）があれば、第3軸の方向から見る。
 *   カメラは横傾き（roll）を持たないので、画面の上は常にワールドの +Y 側になる。第1軸を画面の右に取り、
 *   第2軸の +Y 側を上に取る（左右が反転しないように、見る側の符号を決める）。なければ +Z から見る。
 *   仰角は ±MAX_VIEW_PITCH に収める。
 */

/** 球が画面の縁に接しないように、距離に掛ける余白。 */
export const HOME_MARGIN = 1.08;

/** `overview.axes` がないときに、中心からカメラへ向かう向き（+Z から原点を見る）。 */
export const DEFAULT_HOME_DIRECTION: Vec3 = [0, 0, 1];

export interface HomeBounds {
  center: Vec3;
  radius: number;
}

export interface HomeViewOptions {
  /** 距離に掛ける余白（1 で球が画面の縁に接する）。既定は `HOME_MARGIN`。 */
  margin?: number;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function normalized(a: Vec3): Vec3 | null {
  const l = length(a);
  return l > 1e-9 && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : null;
}

/** 球（半径 `radius`）が縦の視野角 `fovDeg`・縦横比 `aspect` の画面に収まる、中心からの最小の距離。 */
export function fitDistance(radius: number, fovDeg: number, aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * a);
  return radius / Math.sin(Math.min(halfV, halfH));
}

/** 中心からカメラへ向かう単位ベクトルの仰角を ±MAX_VIEW_PITCH に収める。 */
function clampElevation(d: Vec3): Vec3 {
  const elevation = Math.asin(Math.min(1, Math.max(-1, d[1])));
  if (Math.abs(elevation) <= MAX_VIEW_PITCH) return d;
  const h = normalized([d[0], 0, d[2]]) ?? [0, 0, 1];
  const e = Math.sign(elevation) * MAX_VIEW_PITCH;
  return [h[0] * Math.cos(e), Math.sin(e), h[2] * Math.cos(e)];
}

/** 中心からカメラへ向かう単位ベクトル。`axes` が使えなければ既定の向き。 */
export function homeDirection(axes?: readonly [Vec3, Vec3, Vec3] | null): Vec3 {
  if (!axes) return [...DEFAULT_HOME_DIRECTION];
  const right = normalized(axes[0]);
  if (!right) return [...DEFAULT_HOME_DIRECTION];
  // 第2軸を第1軸に直交させ、+Y 側を上に取る
  const a1 = axes[1];
  const k = dot(a1, right);
  let up = normalized([a1[0] - k * right[0], a1[1] - k * right[1], a1[2] - k * right[2]]);
  if (!up) return [...DEFAULT_HOME_DIRECTION];
  if (up[1] < 0) up = [-up[0], -up[1], -up[2]];
  // カメラの右 × 上 = 後ろ（カメラの位置の向き）
  const back = normalized(cross(right, up));
  return back ? clampElevation(back) : [...DEFAULT_HOME_DIRECTION];
}

/** 点群全体が画面に収まる視点（位置と、中心を向く注視点）。 */
export function computeHomeView(
  bounds: HomeBounds,
  fovDeg: number,
  aspect: number,
  axes?: readonly [Vec3, Vec3, Vec3] | null,
  options: HomeViewOptions = {},
): ViewSpec {
  const margin = options.margin ?? HOME_MARGIN;
  const radius = Number.isFinite(bounds.radius) && bounds.radius > 1e-6 ? bounds.radius : 1e-6;
  const distance = fitDistance(radius, fovDeg, aspect) * margin;
  const d = homeDirection(axes);
  const c = bounds.center;
  return {
    pos: [c[0] + d[0] * distance, c[1] + d[1] * distance, c[2] + d[2] * distance],
    look: [c[0], c[1], c[2]],
  };
}
