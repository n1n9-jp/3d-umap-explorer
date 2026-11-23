/** 目印と現在地の文面・色。DOM に依存しない。 */
import { LABEL_COLORS } from '../render/palette';
import type { Direction, Location } from './location';

/** クラスタの色。多数派ラベルの色、ラベルがなければ id で 10 色を繰り返す。 */
export function clusterColor(cluster: { id: number; majorityLabel: number | null }): string {
  const i = cluster.majorityLabel ?? cluster.id;
  return LABEL_COLORS[((i % LABEL_COLORS.length) + LABEL_COLORS.length) % LABEL_COLORS.length]!;
}

export function clusterTitle(name: string): string {
  return `${name} のクラスタ`;
}

export interface LocationView {
  kind: 'inside' | 'nearest';
  /** 画面に出す 1 行 */
  text: string;
}

/**
 * 現在地の表示。
 * - 内部: `現在地: 3 のクラスタ`
 * - 外: `最寄り: 7 のクラスタ ↗ 右上`（方向はカメラから見た向き）
 *
 * 距離は文面に入れない（座標の単位そのままで、利用者には意味が伝わりにくく、移動のたびに文面が変わる）。
 * 距離は `Location` が持つ値を、検証用の状態として返す。
 */
export function formatLocation(loc: Location, name: string, direction: Direction | null): LocationView | null {
  if (loc.kind === 'none') return null;
  if (loc.kind === 'inside') return { kind: 'inside', text: `現在地: ${clusterTitle(name)}` };
  const dir = direction ? ` ${direction.arrow} ${direction.word}` : '';
  return { kind: 'nearest', text: `最寄り: ${clusterTitle(name)}${dir}` };
}
