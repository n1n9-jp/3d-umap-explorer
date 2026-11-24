/**
 * 情報パネルの「元のデータで近い点」の一覧（src/neighbors/）。要素は index.html の #info-neighbors にある。
 *
 * - 一覧の上に要約（「元のデータで近い10点のうち、地図で近い10点にも入っているのは N 点」と、この点の周りで地図がどの程度当てになるか）。
 *   計算の途中の表示の間は、要約に「（計算前の地図での判定）」を添える（`setBeforeCompute`）。
 * - 画像のデータセットでは近傍の画像の小さな一覧（下の縁にラベルの色）、単語のデータセットでは単語の一覧（クラスタの色の印）。近い順。
 * - それぞれに、地図での近傍に入っているかの印（● 地図で近い点にも入っている／○ 入っていない）。
 * - 項目はボタン。カーソルを重ねる・フォーカスすると `onFocus(順位)`、押すと `onPick(点の番号)`。矢印キーで項目の間を移れる。
 * - 読み上げ: 一覧は見出しつきのリスト、各項目の名前は「N 番目に近い: 単語（番号）、地図で近い10点にも入っている」。要約は、パネルの外の
 *   #info-neighbors-live（role=status）へも入れる（選択の読み上げ #info-live とは別）。
 */
import type { PointInfoSource } from './infoPanel';
import { inMapPhrase, neighborItemLabel, summaryHintText, summaryLeadText, summaryText } from '../neighbors/neighbors';

/** 一覧の 1 項目。 */
export interface NeighborListItem {
  index: number;
  inMap: boolean;
}

export type NeighborListState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: NeighborListItem[]; matches: number };

/** 一覧の画像の大きさ（CSS ピクセル。画像のセルと同じ大きさで、拡大しない） */
export const THUMB_PX = 28;

export class NeighborList {
  private readonly root: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly backEl: HTMLButtonElement;
  private readonly liveEl: HTMLElement;
  private readonly src: PointInfoSource;
  private readonly doc: Document;
  private readonly onFocus: (rank: number) => void;
  private readonly onPick: (index: number) => void;
  private readonly onBack: () => void;
  private state: NeighborListState = { kind: 'hidden' };
  private focusedRank = -1;
  /** 計算の途中の表示の間（要約に「計算前の地図での判定」を添える） */
  private beforeCompute = false;

  constructor(doc: Document, src: PointInfoSource, handlers: { onFocus(rank: number): void; onPick(index: number): void; onBack(): void }) {
    this.doc = doc;
    this.src = src;
    this.onFocus = handlers.onFocus;
    this.onPick = handlers.onPick;
    this.onBack = handlers.onBack;
    const get = (id: string) => {
      const el = doc.getElementById(id);
      if (!el) throw new Error(`#${id} がありません`);
      return el;
    };
    this.root = get('info-neighbors');
    this.summaryEl = get('info-neighbors-summary');
    this.hintEl = get('info-neighbors-hint');
    this.listEl = get('info-neighbors-list');
    this.backEl = get('info-back') as HTMLButtonElement;
    this.liveEl = get('info-neighbors-live');
    this.root.dataset.kind = src.kind;
    this.listEl.addEventListener('keydown', this.onKeyDown);
    this.backEl.addEventListener('click', this.onBackClick);
    this.setBackAvailable(false);
    this.set({ kind: 'hidden' });
  }

  getState(): NeighborListState {
    return this.state;
  }

  /** 一覧の状態を設定する。 */
  set(state: NeighborListState): void {
    this.state = state;
    this.setFocusedRank(-1);
    if (state.kind === 'hidden') {
      this.root.hidden = true;
      this.listEl.replaceChildren();
      this.liveEl.textContent = '';
      return;
    }
    this.root.hidden = false;
    this.root.dataset.state = state.kind;
    if (state.kind === 'loading') {
      this.summaryEl.textContent = '元のデータで近い点を読み込み中…';
      this.hintEl.textContent = '';
      this.listEl.replaceChildren();
      this.liveEl.textContent = '';
      return;
    }
    if (state.kind === 'error') {
      this.summaryEl.textContent = `元のデータで近い点を読み込めませんでした（${state.message}）`;
      this.hintEl.textContent = '';
      this.listEl.replaceChildren();
      this.liveEl.textContent = '';
      return;
    }
    this.renderSummary(state);
    // 一覧の項目を押して選び直したとき、フォーカスを新しい一覧の先頭へ移す（キーボードで近傍をたどり続けられるように）
    const hadFocus = this.listEl.contains(this.doc.activeElement);
    this.listEl.replaceChildren(...state.items.map((it, k) => this.item(it, k, state.items.length)));
    if (hadFocus) this.listEl.querySelector<HTMLButtonElement>('button.nb-item')?.focus({ preventScroll: true });
  }

  /** 計算の途中の表示の間、要約に「計算前の地図での判定」を添える。一覧の項目（フォーカス）は作り直さない。 */
  setBeforeCompute(on: boolean): void {
    if (this.beforeCompute === on) return;
    this.beforeCompute = on;
    if (this.state.kind === 'ready') this.renderSummary(this.state);
  }

  private renderSummary(state: Extract<NeighborListState, { kind: 'ready' }>): void {
    const total = state.items.length;
    this.summaryEl.textContent = summaryLeadText(state.matches, total, this.beforeCompute);
    this.hintEl.textContent = summaryHintText(state.matches, total);
    this.liveEl.textContent = summaryText(state.matches, total, this.beforeCompute);
    this.root.dataset.beforeCompute = this.beforeCompute ? '1' : '0';
  }

  /** 戻る操作を出すか。 */
  setBackAvailable(available: boolean): void {
    this.backEl.hidden = !available;
  }

  /** カーソルを重ねている（フォーカスしている）項目の順位（0 から。なければ -1）。 */
  get focused(): number {
    return this.focusedRank;
  }

  dispose(): void {
    this.set({ kind: 'hidden' });
    this.setBackAvailable(false);
    this.listEl.removeEventListener('keydown', this.onKeyDown);
    this.backEl.removeEventListener('click', this.onBackClick);
  }

  private item(it: NeighborListItem, rank: number, total: number): HTMLElement {
    const doc = this.doc;
    const li = doc.createElement('li');
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'nb-item';
    b.dataset.index = String(it.index);
    b.dataset.rank = String(rank);
    b.dataset.inMap = it.inMap ? '1' : '0';
    const title = this.src.title(it.index);
    const name = this.src.kind === 'text' ? title : `${title}（番号 ${it.index}）`;
    b.setAttribute('aria-label', neighborItemLabel(rank + 1, name, it.inMap, total));
    b.title = `${rank + 1}. ${name}（${inMapPhrase(it.inMap, total)}）`;
    const mark = doc.createElement('span');
    mark.className = 'nb-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = it.inMap ? '●' : '○';
    const color = this.src.color(it.index);
    const img = this.src.image;
    if (img) {
      b.classList.add('nb-thumb');
      const c = doc.createElement('canvas');
      c.width = img.cellSize[0];
      c.height = img.cellSize[1];
      c.style.width = `${THUMB_PX}px`;
      c.style.height = `${THUMB_PX}px`;
      c.setAttribute('aria-hidden', 'true');
      const ctx = c.getContext('2d');
      if (ctx) {
        const [cw, ch] = img.cellSize;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img.atlas, (it.index % img.columns) * cw, Math.floor(it.index / img.columns) * ch, cw, ch, 0, 0, cw, ch);
      }
      b.style.borderBottomColor = color;
      b.append(c, mark);
    } else {
      const sw = doc.createElement('span');
      sw.className = 'nb-swatch';
      sw.setAttribute('aria-hidden', 'true');
      sw.style.background = color;
      const t = doc.createElement('span');
      t.className = 'nb-text';
      t.textContent = title;
      b.append(mark, sw, t);
    }
    b.addEventListener('pointerenter', () => this.setFocusedRank(rank));
    b.addEventListener('pointerleave', () => { if (this.focusedRank === rank && this.doc.activeElement !== b) this.setFocusedRank(-1); });
    b.addEventListener('focus', () => this.setFocusedRank(rank));
    b.addEventListener('blur', () => { if (this.focusedRank === rank) this.setFocusedRank(-1); });
    b.addEventListener('click', () => this.onPick(it.index));
    li.append(b);
    return li;
  }

  private setFocusedRank(rank: number): void {
    if (this.focusedRank === rank) return;
    this.focusedRank = rank;
    this.onFocus(rank);
  }

  private readonly onBackClick = (): void => {
    this.onBack();
  };

  /** 矢印キーで項目の間を移る（Home・End で先頭・末尾）。 */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const buttons = [...this.listEl.querySelectorAll<HTMLButtonElement>('button.nb-item')];
    const cur = buttons.indexOf(e.target as HTMLButtonElement);
    if (cur < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(buttons.length - 1, cur + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    if (next < 0) return;
    e.preventDefault();
    e.stopPropagation(); // 矢印キーをカメラの操作へ渡さない
    // フォーカスした項目を、一覧のスクロールの中で見える位置へ（一覧がパネルの高さに収まらないとき）
    const target = buttons[next]!;
    target.focus();
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
}
