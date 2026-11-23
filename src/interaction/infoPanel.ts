/**
 * 選択中の点の情報パネル（画面の右上）と、ホバー中の点のラベル（カーソルの近く）。
 * 要素は index.html にある（#info、#hover-label）。
 */

export interface PointInfoSource {
  /** アトラス画像 */
  atlas: CanvasImageSource;
  /** アトラスのセルの大きさ（画像のピクセル）と列数 */
  cellSize: [number, number];
  columns: number;
  labels: Uint8Array;
  labelNames: string[];
  /** ラベルの色（0..1 の RGB）。ラベルの添字の順 */
  labelColors: [number, number, number][];
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

const css = ([r, g, b]: [number, number, number]) => `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

export class InfoPanel {
  private readonly root: HTMLElement;
  private readonly image: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly labelEl: HTMLElement;
  private readonly swatch: HTMLElement;
  private readonly indexEl: HTMLElement;
  private readonly clusterEl: HTMLElement;
  private readonly hoverEl: HTMLElement;
  private readonly src: PointInfoSource;

  constructor(doc: Document, src: PointInfoSource, onClose: () => void) {
    this.src = src;
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
    this.image.width = src.cellSize[0] * INFO_IMAGE_SCALE;
    this.image.height = src.cellSize[1] * INFO_IMAGE_SCALE;
    this.image.style.width = `${this.image.width}px`;
    this.image.style.height = `${this.image.height}px`;
    this.ctx = this.image.getContext('2d')!;
    get('info-close').addEventListener('click', onClose);
  }

  /** 選択中の点を表示する。null で隠す。 */
  show(index: number | null): void {
    if (index === null) {
      this.root.hidden = true;
      this.root.dataset.index = '';
      return;
    }
    const { src } = this;
    const label = src.labels[index]!;
    const [cw, ch] = src.cellSize;
    const sx = (index % src.columns) * cw;
    const sy = Math.floor(index / src.columns) * ch;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.image.width, this.image.height);
    ctx.drawImage(src.atlas, sx, sy, cw, ch, 0, 0, this.image.width, this.image.height);

    this.labelEl.textContent = src.labelNames[label] ?? String(label);
    this.swatch.style.background = css(src.labelColors[label] ?? [1, 1, 1]);
    this.indexEl.textContent = `#${index}`;
    const cluster = coarseClusterName(src, index);
    this.clusterEl.textContent = cluster === undefined ? '（情報なし）' : cluster === null ? 'なし（ノイズ）' : cluster;
    this.root.dataset.index = String(index);
    this.root.hidden = false;
  }

  /** ホバー中の点のラベルをカーソルの近くに出す。null で隠す。 */
  showHover(index: number | null, clientX = 0, clientY = 0): void {
    if (index === null) {
      this.hoverEl.hidden = true;
      return;
    }
    const label = this.src.labels[index]!;
    this.hoverEl.textContent = this.src.labelNames[label] ?? String(label);
    this.hoverEl.style.borderColor = css(this.src.labelColors[label] ?? [1, 1, 1]);
    // 画面の右端・下端では、カーソルの反対側へ出す
    const w = this.hoverEl.ownerDocument.defaultView?.innerWidth ?? Infinity;
    const h = this.hoverEl.ownerDocument.defaultView?.innerHeight ?? Infinity;
    this.hoverEl.hidden = false;
    const r = this.hoverEl.getBoundingClientRect();
    const x = clientX + 14 + r.width > w ? clientX - 10 - r.width : clientX + 14;
    const y = clientY + 16 + r.height > h ? clientY - 10 - r.height : clientY + 16;
    this.hoverEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
