/**
 * 点群の近くで、画面に出す目印の数を控えめにする規則。DOM に依存しない。
 *
 * クラスタの外では目印を優先して出すが、点群のすぐ近く（クラスタの縁の近く、点群の内側のクラスタに属さない領域）では、
 * 画面の中央に多数の目印が並んで、点・単語の見通しを妨げる。そこで、カメラから点群までの距離に応じて、出す目印の数に上限を設ける。
 *
 * - 近さ: `proximity` = min(最寄りのクラスタの表面までの距離, 点群を含む球の表面までの距離（中にいれば 0）) ÷ 点群の半径 R。
 * - 上限: 近さが `near` 以下なら `nearCount` 個（すぐ近くの数個だけ）。`far` 以上なら上限なし（全体が見える遠い視点は従来どおり）。
 *   その間は、`nearCount` から全数まで線形に増やす。
 * - 選び方: 上限の範囲で、カメラに近い（クラスタの中心までの距離が小さい）ものから選ぶ。前のフレームで出ていた目印は、
 *   距離を `stickiness` の割合だけ優遇して、順位が入れ替わる付近でちらつかないようにする。キーボードのフォーカスがある目印は必ず残す。
 */
import type { Vec3 } from './projection';

export interface BudgetParams {
  /** すぐ近くとみなす近さ（R に対する割合）。これ以下では nearCount 個 */
  near: number;
  /** 遠いとみなす近さ。これ以上では上限なし */
  far: number;
  /** すぐ近くで出す目印の数 */
  nearCount: number;
}

/** 既定値。ホームの視点（点群の中心から約 1.9 R、球の表面から約 0.9 R）は far より遠いので、従来どおりすべて出す。 */
export const DEFAULT_BUDGET: BudgetParams = { near: 0.25, far: 0.7, nearCount: 3 };
/** 縁の視点で出す目印の数の上限（検証スクリプトと README の値） */
export const NEAR_LABEL_COUNT = DEFAULT_BUDGET.nearCount;

/**
 * カメラから点群までの近さ（R に対する割合。0 なら点群の球の内側か、クラスタの表面上）。
 * `clusterSurface` は最寄りのクラスタの表面までの距離（クラスタの内部なら 0。クラスタがなければ Infinity）。
 */
export function cloudProximity(camera: Vec3, boundsCenter: Vec3, boundsRadius: number, clusterSurface: number): number {
  if (!(boundsRadius > 0)) return Infinity;
  const toCenter = Math.hypot(camera[0] - boundsCenter[0], camera[1] - boundsCenter[1], camera[2] - boundsCenter[2]);
  const toBounds = Math.max(0, toCenter - boundsRadius);
  const d = Math.min(toBounds, Math.max(0, clusterSurface));
  return d / boundsRadius;
}

/** 上限の切り替えに持たせる幅（目印 1 個に対する割合）。カメラが境目の付近で揺れても、数が切り替わり続けない */
export const BUDGET_HYSTERESIS = 0.25;

/**
 * 近さ `proximity` で画面に出してよい目印の数（`total` は目印の総数。上限なしなら total）。
 * `previous`（前のフレームの上限）を渡すと、連続値が前の上限の [previous − 幅, previous + 1 + 幅) にある間は前の値を保つ。
 */
export function labelBudget(proximity: number, total: number, params: BudgetParams = DEFAULT_BUDGET, previous: number | null = null): number {
  if (total <= params.nearCount) return total;
  if (!(proximity < params.far)) return total;
  const span = params.far - params.near;
  const t = span > 0 ? Math.min(1, Math.max(0, (proximity - params.near) / span)) : 0;
  const raw = params.nearCount + t * (total - params.nearCount);
  if (previous !== null && raw >= previous - BUDGET_HYSTERESIS && raw < previous + 1 + BUDGET_HYSTERESIS) return previous;
  return Math.min(total, Math.floor(raw));
}

export interface BudgetItem {
  id: number;
  /** カメラからクラスタの中心までの距離 */
  distance: number;
}

/**
 * 上限 `budget` の範囲で残す目印の id。近い順（前のフレームで出ていたものは距離 × (1 − stickiness)）、同値なら id の小さい順。
 * `pinned`（キーボードのフォーカスがある目印）は、候補にあれば必ず残し、上限の 1 つに数える。
 */
export function selectWithinBudget(items: readonly BudgetItem[], budget: number, shown: ReadonlySet<number> = new Set(),
  pinned: number | null = null, stickiness = 0.1): Set<number> {
  if (budget >= items.length) return new Set(items.map((it) => it.id));
  const rank = (it: BudgetItem): number => {
    if (it.id === pinned) return -Infinity;
    return shown.has(it.id) ? it.distance * (1 - stickiness) : it.distance;
  };
  const order = [...items].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return (ra === rb ? 0 : ra < rb ? -1 : 1) || a.id - b.id;
  });
  const n = Math.max(budget, pinned !== null && items.some((it) => it.id === pinned) ? 1 : 0);
  return new Set(order.slice(0, n).map((it) => it.id));
}
