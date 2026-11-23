/** 目印と現在地の文面・色。DOM に依存しない。 */
import { clusterColorIndex, colorIndexHex, type ColorSource } from '../render/colorScheme';
import type { Direction, Location } from './location';

/**
 * クラスタの色。点をラベルで色分けするデータセットでは多数派ラベルの色（なければ id）、
 * クラスタで色分けするデータセットでは id の色（点の色と一致する）。どちらも 10 色を繰り返す。
 */
export function clusterColor(cluster: { id: number; majorityLabel: number | null }, source: ColorSource = 'label'): string {
  return colorIndexHex(clusterColorIndex(cluster, source));
}

/**
 * 目印に出す名前。代表の単語（`terms`）があれば ` · ` で区切って並べ（`nodes · node · operators`）、なければ `name`。
 * 長い名前は目印の最大幅で省略する（CSS）。省略しない名前は aria-label と title に入れる。
 */
export function chipText(cluster: { name: string; terms?: readonly string[] }): string {
  return cluster.terms && cluster.terms.length > 0 ? cluster.terms.join(' · ') : cluster.name;
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
