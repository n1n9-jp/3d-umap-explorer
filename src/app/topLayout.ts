/**
 * 画面の上部（#top-bar）の高さ。左上に作品タイトルとカメラのモード、右上の列（#top-right）にデータセットの選択欄・UMAP の再計算のパネル・
 * 情報パネルを置く（並べ方は index.html の CSS）。右上の列が、下の UI（左下の HUD と現在地、右下のミニマップ）に重ならないように、
 * 右上の列と横の範囲が重なる下の UI の上端より上で、上部の領域を終わらせる。列の中のパネルは、その高さに収まらない分を、それぞれの中でスクロールする。
 *
 * 横の範囲は、パネルの矩形（getBoundingClientRect）から直接は求めない。パネルは `overflow-y: auto` で、高さが縮むとスクロールバーが現れて
 * 幅が増え、列の左端が動く。その矩形で重なりを判定すると、高さ → スクロールバー → 幅 → 重なり → 高さ、と循環して、判定が入れ替わりうる。
 * そこで、右端は列の枠（#top-right。タイトルの右から画面の右端まで。高さにもスクロールバーにも中身にも左右されない）に固定し、
 * 左端は、各要素の「スクロールバーを含まない幅」（`columnBox`）と、スクロールバーの分の固定の余裕（`SCROLLBAR_ALLOWANCE`）から決める。
 * どれも、いまの高さ・スクロールバーの有無に依らない値なので、高さの決め直しが判定を変えない。
 *
 * 下の UI の大きさと位置（HUD の文の長さ、ミニマップの表示）や、列の中身（パネルの開閉、一覧の長さ）は変わるので、毎フレーム決め直す。
 */

export interface Box { left: number; top: number; right: number; bottom: number }

export interface TopBarInput {
  viewportHeight: number;
  /** 上部の領域の上端（CSS の top） */
  top: number;
  /** 右上の列が横に占める範囲（`columnBox`）。列に表示されている要素がなければ null（避けるものがない） */
  column: Box | null;
  /** 下の UI の、表示されている要素の矩形 */
  obstacles: readonly Box[];
}

/** 下の UI との間に空ける余白と、画面の下端の余白（CSS ピクセル）。 */
export const TOP_BAR_GAP = 8;
export const TOP_BAR_BOTTOM_MARGIN = 10;
/** 上部の領域の高さの下限（極端に縦の短い画面でも、選択欄の 1 行は出す）。 */
export const TOP_BAR_MIN_HEIGHT = 40;
/**
 * 列の左端に足す、スクロールバーの分の余裕（CSS ピクセル）。列の中のスクロールする要素（情報パネル・UMAP のパネル・並び）の
 * スクロールバーが重なって現れても、なお列の範囲に入る大きさ。スクロールバーの有無で、判定が変わらないように、いつも足す。
 */
export const SCROLLBAR_ALLOWANCE = 36;

const overlapsX = (a: Box, b: Box) => a.left < b.right && b.left < a.right;

/**
 * 上部の領域の高さ。画面の下端の余白か、列の範囲と横の範囲が重なる下の UI の上端（から余白を引いた位置）の、高いほうまで。
 * 下限は `TOP_BAR_MIN_HEIGHT`。
 */
export function topBarHeight(input: TopBarInput): number {
  let bottom = input.viewportHeight - TOP_BAR_BOTTOM_MARGIN;
  const column = input.column;
  if (column) {
    for (const o of input.obstacles) {
      if (o.bottom <= o.top || o.right <= o.left) continue;
      if (overlapsX(column, o)) bottom = Math.min(bottom, o.top - TOP_BAR_GAP);
    }
  }
  return Math.max(TOP_BAR_MIN_HEIGHT, Math.floor(bottom - input.top));
}

export interface ColumnBoxInput {
  /** 列の枠（#top-right）の矩形。右端は、列の中の要素が右にそろう位置 */
  frame: Box;
  /** 選択欄の、スクロールバーを含まない幅（表示されていなければ null） */
  switcherWidth: number | null;
  /** 表示されているパネル（UMAP・情報）それぞれの、スクロールバーを含まない幅 */
  panelWidths: readonly number[];
  /** パネルを横に並べているか（false なら縦に重ねる） */
  panelsRow: boolean;
  /** 横に並べたときのパネルの間隔 */
  panelGap: number;
}

/**
 * 右上の列が横に占める範囲。右端は列の枠、左端は、右にそろえた要素のうち最も幅の広いもの（横に並べるパネルは、幅と間隔の合計）の幅に、
 * スクロールバーの余裕を足した位置（列の枠より左へは出ない）。表示されている要素がなければ null。
 * 入力はスクロールバーを含まない幅だけなので、高さを縮めてスクロールバーが現れても、結果は変わらない。
 */
export function columnBox(input: ColumnBoxInput): Box | null {
  const { frame, switcherWidth, panelWidths, panelsRow, panelGap } = input;
  const panels = panelWidths.length === 0 ? 0 : panelsRow
    ? panelWidths.reduce((sum, w) => sum + w, 0) + panelGap * (panelWidths.length - 1)
    : Math.max(...panelWidths);
  const width = Math.max(switcherWidth ?? 0, panels);
  if (switcherWidth === null && panelWidths.length === 0) return null;
  const left = Math.max(frame.left, frame.right - width - SCROLLBAR_ALLOWANCE);
  return { left, top: frame.top, right: frame.right, bottom: frame.bottom };
}

/** 右上の列の枠・要素と、避ける下の UI の id。 */
export const TOP_COLUMN_FRAME_ID = 'top-right';
export const TOP_SWITCHER_ID = 'dataset-switcher';
export const TOP_PANELS_ID = 'top-panels';
export const TOP_PANEL_IDS = ['umap-panel', 'info'] as const;
export const BOTTOM_UI_IDS = ['hud', 'cluster-location', 'minimap'] as const;

/** 上部の領域の高さを、要素の実際の矩形から決めて CSS 変数（--top-bar-height）へ渡す。 */
export class TopLayout {
  private last = -1;

  constructor(private readonly doc: Document) {}

  /** 要素の、スクロールバーを含まない幅（border-box。縦のスクロールバーの分は引く）。表示されていなければ null。 */
  private widthWithoutScrollbar(id: string): number | null {
    const el = this.doc.getElementById(id);
    if (!el || el.hidden || el.offsetWidth <= 0) return null;
    const view = this.doc.defaultView;
    const cs = view?.getComputedStyle(el);
    const borders = cs ? (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0) : 0;
    // scrollWidth はパディングを含み、縦のスクロールバーを含まない
    return Math.max(el.scrollWidth, el.clientWidth) + borders;
  }

  update(): void {
    const bar = this.doc.getElementById('top-bar');
    if (!bar) return;
    const rect = (id: string): Box | null => {
      const el = this.doc.getElementById(id);
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    };
    const top = bar.getBoundingClientRect().top;
    const view = this.doc.defaultView;
    const frame = rect(TOP_COLUMN_FRAME_ID);
    const panels = this.doc.getElementById(TOP_PANELS_ID);
    const pcs = panels && view ? view.getComputedStyle(panels) : null;
    const column = frame ? columnBox({
      frame,
      switcherWidth: this.widthWithoutScrollbar(TOP_SWITCHER_ID),
      panelWidths: TOP_PANEL_IDS.flatMap((id) => { const w = this.widthWithoutScrollbar(id); return w === null ? [] : [w]; }),
      panelsRow: !pcs || pcs.flexDirection.startsWith('row'),
      panelGap: pcs ? parseFloat(pcs.columnGap) || 0 : 0,
    }) : null;
    const obstacles = BOTTOM_UI_IDS.flatMap((id) => { const b = rect(id); return b ? [b] : []; });
    const h = topBarHeight({ viewportHeight: view?.innerHeight ?? 0, top, column, obstacles });
    if (h === this.last) return;
    this.last = h;
    bar.style.setProperty('--top-bar-height', `${h}px`);
  }
}
