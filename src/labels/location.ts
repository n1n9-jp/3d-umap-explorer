/** カメラの現在地（どのクラスタの内部か、どのクラスタが最寄りか）の判定。DOM に依存しない。 */
import type { Vec3 } from './projection';

export interface ClusterSphere {
  id: number;
  center: Vec3;
  radius: number;
}

export type Location =
  | { kind: 'inside'; id: number; distance: number }
  /** `distance` は選んだクラスタの表面までの距離。`closest` は、どのクラスタでも最小の表面までの距離（保っているクラスタを選んでいるときは、`distance` より小さいことがある） */
  | { kind: 'nearest'; id: number; distance: number; closest?: number }
  | { kind: 'none' };

/** カメラがクラスタの内部へ入ったと判定する距離（半径に対する割合。中心から半径のこの倍以内）。 */
export const INSIDE_ENTER_RATIO = 0.95;
/** 内部にいたカメラが、外へ出たと判定する距離（半径に対する割合。中心から半径のこの倍を超えたら）。入る距離との差が、判定の幅になる。 */
export const INSIDE_EXIT_RATIO = 1.05;
/** 重なり合う球の内部で、いまの現在地のクラスタから別のクラスタへ替えるために、新しい側の（距離 ÷ 半径）が下回らなければならない差。 */
export const INSIDE_SWITCH_MARGIN = 0.1;
/** 最寄りのクラスタを替えるために、新しい側の表面までの距離が、いまの側（の半径に対する割合）だけ小さくなければならない差。 */
export const NEAREST_SWITCH_MARGIN = 0.05;

/** 前のフレームの判定。`locateCamera` に渡すと、境界の付近でカメラが小さく動いても、判定が入れ替わり続けない。 */
export interface LocationMemory {
  /** 前のフレームで内部にいたクラスタ（いなければ null） */
  insideId: number | null;
  /** 前のフレームで最寄りだったクラスタ（内部にいたとき・なかったときは null） */
  nearestId: number | null;
}

export const EMPTY_MEMORY: LocationMemory = { insideId: null, nearestId: null };

/** 判定の結果から、次のフレームへ渡す記憶を作る。 */
export function rememberLocation(location: Location): LocationMemory {
  return {
    insideId: location.kind === 'inside' ? location.id : null,
    nearestId: location.kind === 'nearest' ? location.id : null,
  };
}

/** 点 p から球の中心までの距離。 */
export function distanceToCenter(p: Vec3, c: ClusterSphere): number {
  return Math.hypot(p[0] - c.center[0], p[1] - c.center[1], p[2] - c.center[2]);
}

/**
 * カメラの位置 `p` から現在地を決める。
 * - どれかの球（中心から `radius` 以内）の内部にいれば `inside`。複数の球に入るときは、距離を半径で割った値が最小のもの
 *   （中心に最も近いもの。同値なら id が小さいもの）。`distance` は中心までの距離。
 * - どの球の内部でもなければ、球の表面までの距離（中心までの距離 − radius。内側へ 0.95 以内の帯では 0）が最小のものを `nearest` とする。
 *   `distance` はその表面までの距離。
 * - クラスタがなければ `none`。
 *
 * `memory`（前のフレームの判定）を渡すと、境界の付近で判定が入れ替わり続けないよう、判定に幅を持たせる。
 * - 内部へ入るのは、中心から `INSIDE_ENTER_RATIO × radius` 以内に入ったとき。いったん内部にいたら、`INSIDE_EXIT_RATIO × radius` を
 *   超えるまで、そのクラスタの内部にいるものとする。
 * - 内部にいるクラスタは、別のクラスタの（距離 ÷ 半径）がそれより `INSIDE_SWITCH_MARGIN` を超えて小さくなるまで替えない。
 * - 最寄りのクラスタは、別のクラスタの表面までの距離が、それより最寄りの側の半径の `NEAREST_SWITCH_MARGIN` 倍を超えて小さくなるまで替えない。
 * `memory` を渡さなければ、幅のない判定（中心から `radius` 以内が内部）。
 */
export function locateCamera(p: Vec3, clusters: readonly ClusterSphere[], memory?: LocationMemory): Location {
  const enter = memory ? INSIDE_ENTER_RATIO : 1;
  const exit = memory ? INSIDE_EXIT_RATIO : 1;
  let best: { id: number; ratio: number; distance: number } | null = null;
  let held: { id: number; ratio: number; distance: number } | null = null;
  let nearest: { id: number; surface: number; radius: number } | null = null;
  let heldNearest: { id: number; surface: number; radius: number } | null = null;
  for (const c of clusters) {
    const d = distanceToCenter(p, c);
    const ratio = c.radius > 0 ? d / c.radius : d > 0 ? Infinity : 0;
    if (ratio <= enter && (!best || ratio < best.ratio || (ratio === best.ratio && c.id < best.id))) best = { id: c.id, ratio, distance: d };
    if (memory && c.id === memory.insideId && ratio <= exit) held = { id: c.id, ratio, distance: d };
    const surface = Math.max(0, d - c.radius);
    if (!nearest || surface < nearest.surface || (surface === nearest.surface && c.id < nearest.id)) nearest = { id: c.id, surface, radius: c.radius };
    if (memory && c.id === memory.nearestId) heldNearest = { id: c.id, surface, radius: c.radius };
  }
  const inside = held && best && best.id !== held.id && best.ratio < held.ratio - INSIDE_SWITCH_MARGIN ? best : held ?? best;
  if (inside) return { kind: 'inside', id: inside.id, distance: inside.distance };
  if (nearest) {
    const chosen = heldNearest && nearest.id !== heldNearest.id && nearest.surface >= heldNearest.surface - NEAREST_SWITCH_MARGIN * heldNearest.radius
      ? heldNearest : nearest;
    return { kind: 'nearest', id: chosen.id, distance: chosen.surface, closest: nearest.surface };
  }
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
