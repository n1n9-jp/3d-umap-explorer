/**
 * UMAP の再計算のパネル（画面の左上、データセットの選択欄の下。U キーで開閉）。要素は index.html にある（#umap-panel）。
 * 入力の検証と表示の更新だけを受け持ち、計算と表示の切り替えは src/compute/umapFeature.ts が行う。
 *
 * 入力欄（数値・チェックボックス）にフォーカスがある間は、移動やモード切り替えのキーは働かない
 * （どのキーの処理も src/app/keyEvents.ts の `isFromEditable` で入力欄を除いている）。パネルの中で Esc を押すと閉じる。
 */
import { UMAP_LIMITS, validParams, type UmapParams } from '../compute/params';

export interface UmapPanelCallbacks {
  compute(params: UmapParams): void;
  cancel(): void;
  revert(): void;
  /** 保持している結果を表示する */
  showCached(key: string): void;
  /** 「計算の途中を表示する」の切り替え */
  previewChanged(enabled: boolean): void;
  /** 開閉が変わったとき */
  visibilityChanged?(open: boolean): void;
}

export interface UmapPanelView {
  /** 機能が使えるか（kNN グラフのないデータセットでは false） */
  available: boolean;
  /** 使えない理由など、パネルの下に出す文 */
  message: string;
  error: boolean;
  /** 表示中の埋め込みの説明 */
  current: string;
  /** 'idle': 待機、'loading': kNN グラフや Worker の準備、'running': 計算中、'morphing': 表示の切り替え中 */
  phase: 'idle' | 'loading' | 'running' | 'morphing';
  epoch: number;
  total: number;
  /** 表示中がブラウザで計算した埋め込みか（「事前計算に戻す」を有効にする） */
  computed: boolean;
  cache: { key: string; label: string; current: boolean }[];
}

/** 入力欄の値を検証してパラメータにする。不正なら、どの欄が不正かを返す。 */
export function parsePanelInputs(nn: string, md: string, seed: string, maxNeighbors: number): { params: UmapParams } | { error: string; field: 'nn' | 'md' | 'seed' } {
  const n = Number(nn), m = Number(md), s = Number(seed);
  const nMax = Math.min(UMAP_LIMITS.nNeighbors.max, maxNeighbors);
  if (nn.trim() === '' || !Number.isInteger(n) || n < UMAP_LIMITS.nNeighbors.min || n > nMax) {
    return { error: `近傍数は ${UMAP_LIMITS.nNeighbors.min}〜${nMax} の整数です`, field: 'nn' };
  }
  if (md.trim() === '' || !Number.isFinite(m) || m < UMAP_LIMITS.minDist.min || m > UMAP_LIMITS.minDist.max) {
    return { error: `min_dist は ${UMAP_LIMITS.minDist.min}〜${UMAP_LIMITS.minDist.max} の数です`, field: 'md' };
  }
  if (seed.trim() === '' || !Number.isInteger(s) || s < UMAP_LIMITS.seed.min || s > UMAP_LIMITS.seed.max) {
    return { error: `乱数の種は ${UMAP_LIMITS.seed.min}〜${UMAP_LIMITS.seed.max} の整数です`, field: 'seed' };
  }
  const params = validParams(n, m, s, nMax);
  return params ? { params } : { error: '値が範囲の外です', field: 'nn' };
}

export class UmapPanel {
  private readonly root: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly nn: HTMLInputElement;
  private readonly md: HTMLInputElement;
  private readonly seed: HTMLInputElement;
  private readonly preview: HTMLInputElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly revertBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly currentEl: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly progressBar: HTMLProgressElement;
  private readonly progressText: HTMLElement;
  private readonly messageEl: HTMLElement;
  private readonly cacheBox: HTMLElement;
  private readonly cacheList: HTMLElement;
  private readonly openBtn: HTMLButtonElement | null;
  private readonly cb: UmapPanelCallbacks;
  private maxNeighbors: number = UMAP_LIMITS.nNeighbors.max;
  private state: UmapPanelView | null = null;
  private inputError: string | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(doc: Document, callbacks: UmapPanelCallbacks) {
    this.cb = callbacks;
    const $ = <T extends HTMLElement>(id: string) => {
      const el = doc.getElementById(id);
      if (!el) throw new Error(`#${id} がありません`);
      return el as T;
    };
    this.root = $('umap-panel');
    this.form = $<HTMLFormElement>('umap-form');
    this.nn = $<HTMLInputElement>('umap-nn');
    this.md = $<HTMLInputElement>('umap-md');
    this.seed = $<HTMLInputElement>('umap-seed');
    this.preview = $<HTMLInputElement>('umap-preview');
    this.runBtn = $<HTMLButtonElement>('umap-run');
    this.cancelBtn = $<HTMLButtonElement>('umap-cancel');
    this.revertBtn = $<HTMLButtonElement>('umap-revert');
    this.closeBtn = $<HTMLButtonElement>('umap-close');
    this.currentEl = $('umap-current');
    this.progress = $('umap-progress');
    this.progressBar = $<HTMLProgressElement>('umap-progress-bar');
    this.progressText = $('umap-progress-text');
    this.messageEl = $('umap-message');
    this.cacheBox = $('umap-cache');
    this.cacheList = $('umap-cache-list');
    this.openBtn = doc.getElementById('umap-open') as HTMLButtonElement | null;

    this.nn.min = String(UMAP_LIMITS.nNeighbors.min);
    this.nn.max = String(UMAP_LIMITS.nNeighbors.max);
    this.md.min = String(UMAP_LIMITS.minDist.min);
    this.md.max = String(UMAP_LIMITS.minDist.max);
    this.md.step = String(UMAP_LIMITS.minDist.step);
    this.seed.min = String(UMAP_LIMITS.seed.min);
    this.seed.max = String(UMAP_LIMITS.seed.max);

    this.on(this.form, 'submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.on(this.cancelBtn, 'click', () => this.cb.cancel());
    this.on(this.revertBtn, 'click', () => this.cb.revert());
    this.on(this.closeBtn, 'click', () => this.setOpen(false, true));
    this.on(this.preview, 'change', () => this.cb.previewChanged(this.preview.checked));
    for (const input of [this.nn, this.md, this.seed]) {
      this.on(input, 'input', () => {
        input.removeAttribute('aria-invalid');
        if (this.inputError) { this.inputError = null; this.render(); }
      });
    }
    this.on(this.cacheList, 'click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-key]');
      if (btn && !btn.disabled) this.cb.showCached(btn.dataset.key!);
    });
    // パネルの中の Esc は、パネルを閉じる（選択の解除には届けない）
    this.on(this.root, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        this.setOpen(false, true);
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** 開閉する。`moveFocus` が true なら、開いたときにパネルへ、閉じたときに開くボタンへフォーカスを移す。 */
  setOpen(open: boolean, moveFocus = false): void {
    if (this.isOpen === open) return;
    const hadFocus = this.root.contains(this.root.ownerDocument.activeElement);
    this.root.hidden = !open;
    this.openBtn?.setAttribute('aria-expanded', String(open));
    if (open && moveFocus) this.root.focus({ preventScroll: true });
    if (!open && hadFocus) {
      if (moveFocus && this.openBtn) this.openBtn.focus({ preventScroll: true });
      else (this.root.ownerDocument.activeElement as HTMLElement | null)?.blur?.();
    }
    this.cb.visibilityChanged?.(open);
  }

  toggle(moveFocus = false): void {
    this.setOpen(!this.isOpen, moveFocus);
  }

  /** 入力欄の値と、近傍数の上限（kNN グラフの列数 + 1）を設定する（データセットを開いたとき、URL から計算するとき）。 */
  setInputs(params: UmapParams, maxNeighbors: number = this.maxNeighbors): void {
    this.maxNeighbors = Math.min(UMAP_LIMITS.nNeighbors.max, maxNeighbors);
    this.nn.max = String(this.maxNeighbors);
    this.nn.value = String(params.nNeighbors);
    this.md.value = params.minDist.toFixed(2);
    this.seed.value = String(params.seed);
    for (const input of [this.nn, this.md, this.seed]) input.removeAttribute('aria-invalid');
    this.inputError = null;
    this.render();
  }

  get previewEnabled(): boolean {
    return this.preview.checked;
  }

  setPreview(enabled: boolean): void {
    this.preview.checked = enabled;
  }

  /** 状態を表示へ反映する。 */
  update(view: UmapPanelView): void {
    this.state = view;
    this.render();
  }

  /** 入力欄の値で計算を始める（「計算」のボタンと Enter）。 */
  submit(): void {
    if (!this.state?.available || this.state.phase !== 'idle') return;
    const r = parsePanelInputs(this.nn.value, this.md.value, this.seed.value, this.maxNeighbors);
    if ('error' in r) {
      this.inputError = r.error;
      const field = r.field === 'nn' ? this.nn : r.field === 'md' ? this.md : this.seed;
      field.setAttribute('aria-invalid', 'true');
      this.render();
      return;
    }
    this.cb.compute(r.params);
  }

  dispose(): void {
    for (const f of this.cleanup) f();
    this.cleanup.length = 0;
    this.setOpen(false);
  }

  private on(el: EventTarget, type: string, fn: (e: Event) => void): void {
    el.addEventListener(type, fn);
    this.cleanup.push(() => el.removeEventListener(type, fn));
  }

  private render(): void {
    const s = this.state;
    if (!s) return;
    const busy = s.phase !== 'idle';
    setText(this.currentEl, s.current);
    for (const input of [this.nn, this.md, this.seed]) input.disabled = !s.available || busy;
    this.runBtn.disabled = !s.available || busy;
    this.cancelBtn.hidden = !(s.phase === 'running' || s.phase === 'loading');
    this.cancelBtn.disabled = s.phase !== 'running' && s.phase !== 'loading';
    this.revertBtn.disabled = !s.computed || busy;
    this.preview.disabled = !s.available || s.phase === 'morphing';
    this.progress.hidden = !(s.phase === 'running' || s.phase === 'loading' || s.phase === 'morphing');
    const pct = s.total > 0 ? Math.round((100 * s.epoch) / s.total) : 0;
    this.progressBar.max = Math.max(1, s.total);
    this.progressBar.value = s.epoch;
    const progressText = s.phase === 'loading'
      ? '準備中…（kNN グラフの読み込み・グラフの構築）'
      : s.phase === 'running'
        ? (s.epoch > 0 ? `エポック ${s.epoch} / ${s.total}（${pct}%）` : '準備中…（グラフの構築と初期配置）')
        : s.phase === 'morphing' ? '表示を切り替えています…' : '';
    setText(this.progressText, progressText);
    const message = this.inputError ?? s.message;
    setText(this.messageEl, message);
    this.messageEl.classList.toggle('error', this.inputError !== null || s.error);
    this.messageEl.hidden = message === '';
    // 保持している結果
    this.cacheBox.hidden = s.cache.length === 0;
    const sig = JSON.stringify([s.cache, busy]);
    if (this.cacheList.dataset.sig !== sig) {
      this.cacheList.dataset.sig = sig;
      const doc = this.cacheList.ownerDocument;
      this.cacheList.replaceChildren(...s.cache.map((c) => {
        const li = doc.createElement('li');
        const b = doc.createElement('button');
        b.type = 'button';
        b.dataset.key = c.key;
        b.textContent = c.label;
        b.disabled = busy || c.current;
        if (c.current) b.setAttribute('aria-current', 'true');
        li.append(b);
        return li;
      }));
    }
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
