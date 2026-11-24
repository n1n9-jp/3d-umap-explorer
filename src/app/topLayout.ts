/**
 * 画面の上部（#top-bar）の高さ。左上に作品タイトルとカメラのモード、右上の列にデータセットの選択欄・UMAP の再計算のパネル・
 * 情報パネルを置く（並べ方は index.html の CSS）。右上の列が、下の UI（左下の HUD と現在地、右下のミニマップ）に重ならないように、
 * 列の要素と横の範囲が重なる下の UI の上端より上で、上部の領域を終わらせる。列の中のパネルは、その高さに収まらない分を、それぞれの中でスクロールする。
 *
 * 下の UI の大きさと位置（HUD の文の長さ、ミニマップの表示）や、列の中身（パネルの開閉、一覧の長さ）は変わるので、毎フレーム決め直す。
 */

export interface Box { left: number; top: number; right: number; bottom: number }

export interface TopBarInput {
  viewportHeight: number;
  /** 上部の領域の上端（CSS の top） */
  top: number;
  /** 右上の列の、表示されている要素の矩形 */
  columns: readonly Box[];
  /** 下の UI の、表示されている要素の矩形 */
  obstacles: readonly Box[];
}

/** 下の UI との間に空ける余白と、画面の下端の余白（CSS ピクセル）。 */
export const TOP_BAR_GAP = 8;
export const TOP_BAR_BOTTOM_MARGIN = 10;
/** 上部の領域の高さの下限（極端に縦の短い画面でも、選択欄の 1 行は出す）。 */
export const TOP_BAR_MIN_HEIGHT = 40;

const overlapsX = (a: Box, b: Box) => a.left < b.right && b.left < a.right;

/**
 * 上部の領域の高さ。画面の下端の余白か、列の要素のどれかと横の範囲が重なる下の UI の上端（から余白を引いた位置）の、高いほうまで。
 * 下限は `TOP_BAR_MIN_HEIGHT`。
 */
export function topBarHeight(input: TopBarInput): number {
  let bottom = input.viewportHeight - TOP_BAR_BOTTOM_MARGIN;
  for (const o of input.obstacles) {
    if (o.bottom <= o.top || o.right <= o.left) continue;
    if (input.columns.some((c) => overlapsX(c, o))) bottom = Math.min(bottom, o.top - TOP_BAR_GAP);
  }
  return Math.max(TOP_BAR_MIN_HEIGHT, Math.floor(bottom - input.top));
}

/** 右上の列の要素と、避ける下の UI の id。 */
export const TOP_COLUMN_IDS = ['dataset-switcher', 'umap-panel', 'info'] as const;
export const BOTTOM_UI_IDS = ['hud', 'cluster-location', 'minimap'] as const;

/** 上部の領域の高さを、要素の実際の矩形から決めて CSS 変数（--top-bar-height）へ渡す。 */
export class TopLayout {
  private last = -1;

  constructor(private readonly doc: Document) {}

  update(): void {
    const bar = this.doc.getElementById('top-bar');
    if (!bar) return;
    const rects = (ids: readonly string[]) => ids.flatMap((id) => {
      const el = this.doc.getElementById(id);
      if (!el || el.hidden) return [];
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? [{ left: r.left, top: r.top, right: r.right, bottom: r.bottom }] : [];
    });
    const top = bar.getBoundingClientRect().top;
    const view = this.doc.defaultView;
    const h = topBarHeight({ viewportHeight: view?.innerHeight ?? 0, top, columns: rects(TOP_COLUMN_IDS), obstacles: rects(BOTTOM_UI_IDS) });
    if (h === this.last) return;
    this.last = h;
    bar.style.setProperty('--top-bar-height', `${h}px`);
  }
}
