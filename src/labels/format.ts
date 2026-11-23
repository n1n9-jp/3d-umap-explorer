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
 * - 外: `最寄り: 7 のクラスタ  ↗ 右上 · 縁まで 0.42`（方向はカメラから見た向き、距離は縁までの距離）
 */
export function formatLocation(loc: Location, name: string, direction: Direction | null): LocationView | null {
  if (loc.kind === 'none') return null;
  if (loc.kind === 'inside') return { kind: 'inside', text: `現在地: ${clusterTitle(name)}` };
  const dir = direction ? `  ${direction.arrow} ${direction.word} · ` : '  ';
  return { kind: 'nearest', text: `最寄り: ${clusterTitle(name)}${dir}縁まで ${loc.distance.toFixed(2)}` };
}

/** HUD の操作説明の行（3 行目）の末尾へ、L キーの説明を足す。行が足りなければそのまま返す。 */
export function appendHudHelp(hudText: string, hint: string, helpLine = 2): string {
  const lines = hudText.split('\n');
  if (helpLine >= lines.length) return hudText;
  lines[helpLine] = `${lines[helpLine]} / ${hint}`;
  return lines.join('\n');
}
