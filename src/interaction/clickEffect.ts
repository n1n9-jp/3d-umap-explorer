/**
 * クリックの結果、選択をどう変え、どの点へ飛ぶか。DOM に依存しない。
 *
 * 仕様（ダブルクリックは「クリック 2 回」として届き、どちらのクリックも同じ規則で選択を変える）:
 * - クリックは、離した位置の点を選択する。点のない場所なら選択を解除する（`index` が null）。
 * - ダブルクリックの 2 回目のクリックだけが、その点へ飛ぶ。点のない場所のダブルクリックでは飛ばない。
 * - そのため、点 B を選択中に点 A をダブルクリックすると、1 回目のクリックで選択が A に移る。
 *   飛んだ先の点が選択されている、という意図した動作である。
 * - 点のない場所をダブルクリックしたときは、1 回目のクリックで選択が解除される。
 */

export interface ClickEffect {
  /** 新しい選択（null で解除） */
  select: number | null;
  /** 飛ぶ点。飛ばないときは null */
  flyTo: number | null;
}

/** 離した位置の点 `index`（なければ null）への、クリックまたはダブルクリックの 2 回目の結果。 */
export function clickEffect(index: number | null, double: boolean): ClickEffect {
  return { select: index, flyTo: double && index !== null ? index : null };
}
