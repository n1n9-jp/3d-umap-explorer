/**
 * 選択中の点の情報パネル（画面の右上）と、ホバー中の点のラベル（カーソルの近く）。
 * 要素は index.html にある（#info、#hover-label、#info-live）。
 *
 * 画像のデータセット（MNIST）では、元の画像・ラベル・番号・クラスタを、
 * 単語のデータセット（word2vec）では、画像の代わりに単語を大きく出し、番号とクラスタを出す。
 *
 * アクセシビリティ: パネルは見出しつきのリージョン（role="region"）で、画像のキャンバスは role="img" と
 * 代替テキストを持つ。選択したときの読み上げは、常に DOM にある #info-live（role="status"、aria-live="polite"）へ
 * 文を入れて行う。パネル自体は `hidden` で出し入れするので、中身を読み上げ対象にしても出現時に拾われない読み上げ環境がある。
 */
import type { DatasetKind } from '../data/manifest';

export interface PointInfoImage {
  /** アトラス画像 */
  atlas: CanvasImageSource;
  /** アトラスのセルの大きさ（画像のピクセル）と列数 */
  cellSize: [number, number];
  columns: number;
}

export interface PointInfoSource {
  kind: DatasetKind;
  /** 点の名前（画像のデータセットではラベル名、単語のデータセットでは単語） */
  title(index: number): string;
  /** 点の色（'#rrggbb'。描画と同じ色） */
  color(index: number): string;
  /** 画像アトラス（画像のデータセットだけ） */
  image: PointInfoImage | null;
  /** 点ごとの粗い階層のクラスタ id と、その名前。クラスタの情報がないデータセットでは null */
  coarse: { ids: Uint16Array; names: string[]; noise: number } | null;
}

/** 情報パネルの画像の拡大率（整数。補間でぼかさない） */
export const INFO_IMAGE_SCALE = 4;

/** 点 index の粗い階層のクラスタ名。ノイズなら null、クラスタの情報がなければ undefined。 */
export function coarseClusterName(src: Pick<PointInfoSource, 'coarse'>, index: number): string | null | undefined {
  if (!src.coarse) return undefined;
  const id = src.coarse.ids[index];
  if (id === undefined || id === src.coarse.noise) return null;
  return src.coarse.names[id] ?? null;
}

/** 情報パネルの画像の代替テキスト（例: 「手書きの数字 6 の画像」）。 */
export function imageAltText(labelName: string): string {
  return `手書きの数字 ${labelName} の画像`;
}

/**
 * クラスタ名の表示。どのクラスタにも属さなければ、画像のデータセットでは「なし（ノイズ）」、単語のデータセットでは「なし」。
 * クラスタの情報がなければ「（情報なし）」。
 */
export function clusterText(cluster: string | null | undefined, kind: DatasetKind = 'image'): string {
  if (cluster === undefined) return '（情報なし）';
  if (cluster === null) return kind === 'text' ? 'なし' : 'なし（ノイズ）';
  return cluster;
}

/** 選択したときに読み上げる文（画像: ラベル・番号・クラスタ名、単語: 単語・番号・クラスタ名）。 */
export function selectionAnnouncement(title: string, index: number, cluster: string, kind: DatasetKind = 'image'): string {
  if (kind === 'text') return `選択した単語: ${title}、番号 ${index}、クラスタ ${cluster}`;
  return `選択した点: ${title}、番号 ${index}、クラスタ ${cluster}`;
}

export class InfoPanel {
  private readonly root: HTMLElement;
  private readonly image: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly labelEl: HTMLElement;
  private readonly swatch: HTMLElement;
  private readonly indexEl: HTMLElement;
  private readonly clusterEl: HTMLElement;
  private readonly hoverEl: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly closeEl: HTMLElement;
  private readonly src: PointInfoSource;
  private readonly onClose: () => void;

  constructor(doc: Document, src: PointInfoSource, onClose: () => void) {
    this.src = src;
    this.onClose = onClose;
    const get = (id: string) => {
      const el = doc.getElementById(id);
      if (!el) throw new Error(`#${id} がありません`);
      return el;
    };
    this.root = get('info');
    this.image = get('info-image') as HTMLCanvasElement;
    this.labelEl = get('info-label');
    this.swatch = get('info-swatch');
    this.indexEl = get('info-index');
    this.clusterEl = get('info-cluster');
    this.hoverEl = get('hover-label');
    this.liveEl = get('info-live');
    this.closeEl = get('info-close');
    this.root.dataset.kind = src.kind;
    this.image.hidden = src.image === null;
    if (src.image) {
      this.image.width = src.image.cellSize[0] * INFO_IMAGE_SCALE;
      this.image.height = src.image.cellSize[1] * INFO_IMAGE_SCALE;
      this.image.style.width = `${this.image.width}px`;
      this.image.style.height = `${this.image.height}px`;
    }
    this.ctx = this.image.getContext('2d')!;
    this.closeEl.addEventListener('click', this.onClose);
    this.show(null);
    this.showHover(null);
  }

  /** 選択中の点を表示する。null で隠す。 */
  show(index: number | null): void {
    if (index === null) {
      this.root.hidden = true;
      this.root.dataset.index = '';
      this.liveEl.textContent = ''; // 解除は読み上げない（次の選択が同じ文でも読み上げ直せるよう、空に戻す）
      return;
    }
    const { src } = this;
    const title = src.title(index);
    if (src.image) {
      const { atlas, cellSize: [cw, ch], columns } = src.image;
      const sx = (index % columns) * cw;
      const sy = Math.floor(index / columns) * ch;
      const ctx = this.ctx;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, this.image.width, this.image.height);
      ctx.drawImage(atlas, sx, sy, cw, ch, 0, 0, this.image.width, this.image.height);
      this.image.setAttribute('aria-label', imageAltText(title));
    }
    this.labelEl.textContent = title;
    this.swatch.style.background = src.color(index);
    this.indexEl.textContent = `#${index}`;
    const clusterLabel = clusterText(coarseClusterName(src, index), src.kind);
    this.clusterEl.textContent = clusterLabel;
    this.liveEl.textContent = selectionAnnouncement(title, index, clusterLabel, src.kind);
    this.root.dataset.index = String(index);
    this.root.hidden = false;
  }

  /** ホバー中の点のラベルをカーソルの近くに出す。null で隠す。 */
  showHover(index: number | null, clientX = 0, clientY = 0): void {
    if (index === null) {
      this.hoverEl.hidden = true;
      return;
    }
    this.hoverEl.textContent = this.src.title(index);
    this.hoverEl.style.borderColor = this.src.color(index);
    // 画面の右端・下端では、カーソルの反対側へ出す
    const w = this.hoverEl.ownerDocument.defaultView?.innerWidth ?? Infinity;
    const h = this.hoverEl.ownerDocument.defaultView?.innerHeight ?? Infinity;
    this.hoverEl.hidden = false;
    const r = this.hoverEl.getBoundingClientRect();
    const x = clientX + 14 + r.width > w ? clientX - 10 - r.width : clientX + 14;
    const y = clientY + 16 + r.height > h ? clientY - 10 - r.height : clientY + 16;
    this.hoverEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /** パネルとホバーのラベルを隠し、閉じるボタンのリスナーを外す（データセットの切り替え時）。 */
  dispose(): void {
    this.show(null);
    this.showHover(null);
    this.closeEl.removeEventListener('click', this.onClose);
  }
}
