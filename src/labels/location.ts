/** カメラの現在地（どのクラスタの内部か、どのクラスタが最寄りか）の判定。DOM に依存しない。 */
import type { Vec3 } from './projection';

export interface ClusterSphere {
  id: number;
  center: Vec3;
  radius: number;
}

export type Location =
  | { kind: 'inside'; id: number; distance: number }
  | { kind: 'nearest'; id: number; distance: number }
  | { kind: 'none' };

/** 点 p から球の中心までの距離。 */
export function distanceToCenter(p: Vec3, c: ClusterSphere): number {
  return Math.hypot(p[0] - c.center[0], p[1] - c.center[1], p[2] - c.center[2]);
}

/**
 * カメラの位置 `p` から現在地を決める。
 * - どれかの球（中心から `radius` 以内）の内部にいれば `inside`。複数の球に入るときは、距離を半径で割った値が最小のもの
 *   （中心に最も近いもの。同値なら id が小さいもの）。`distance` は中心までの距離。
 * - どの球の内部でもなければ、球の表面までの距離（中心までの距離 − radius）が最小のものを `nearest` とする。
 *   `distance` はその表面までの距離。
 * - クラスタがなければ `none`。
 */
export function locateCamera(p: Vec3, clusters: readonly ClusterSphere[]): Location {
  let inside: { id: number; ratio: number; distance: number } | null = null;
  let nearest: { id: number; distance: number } | null = null;
  for (const c of clusters) {
    const d = distanceToCenter(p, c);
    if (d <= c.radius) {
      const ratio = c.radius > 0 ? d / c.radius : 0;
      if (!inside || ratio < inside.ratio || (ratio === inside.ratio && c.id < inside.id)) inside = { id: c.id, ratio, distance: d };
    } else {
      const surface = d - c.radius;
      if (!nearest || surface < nearest.distance || (surface === nearest.distance && c.id < nearest.id)) nearest = { id: c.id, distance: surface };
    }
  }
  if (inside) return { kind: 'inside', id: inside.id, distance: inside.distance };
  if (nearest) return { kind: 'nearest', id: nearest.id, distance: nearest.distance };
  return { kind: 'none' };
}

export interface Direction {
  arrow: string;
  word: string;
}

/** 正面とみなす、視線からの角度（度）。 */
export const FRONT_ANGLE_DEG = 18;
/** これを超えると「後方」とみなす、視線からの角度（度）。 */
export const BACK_ANGLE_DEG = 110;

const ARROWS: readonly Direction[] = [
  { arrow: '→', word: '右' },
  { arrow: '↗', word: '右上' },
  { arrow: '↑', word: '上' },
  { arrow: '↖', word: '左上' },
  { arrow: '←', word: '左' },
  { arrow: '↙', word: '左下' },
  { arrow: '↓', word: '下' },
  { arrow: '↘', word: '右下' },
];

/**
 * カメラから見たクラスタの方向。引数はカメラの座標系（右・上・前）での、カメラからクラスタ中心へのベクトル。
 * 視線から 18° 以内は「正面」、110° を超えると「後方」、その間は画面の中での向き（右・右上・上…の 8 方向）。
 */
export function describeDirection(right: number, up: number, forward: number): Direction {
  const len = Math.hypot(right, up, forward);
  if (!(len > 0)) return { arrow: '◎', word: '正面' };
  const angle = (Math.acos(Math.min(1, Math.max(-1, forward / len))) * 180) / Math.PI;
  if (angle <= FRONT_ANGLE_DEG) return { arrow: '◎', word: '正面' };
  if (angle > BACK_ANGLE_DEG) return { arrow: '↩', word: '後方' };
  const a = Math.atan2(up, right); // -π..π、右が 0、上が +π/2
  const k = Math.round(a / (Math.PI / 4));
  return ARROWS[((k % 8) + 8) % 8]!;
}
