/**
 * データセットの選択欄（画面の右上）。要素は index.html にある（#dataset-select、#dataset-status）。
 * 選んだら `onSelect(id)` を呼ぶ。読み込み中は選択欄を無効にして「読み込み中…」を、失敗したらエラーを出す。
 */
import type { DatasetCatalog } from '../data/catalog';

/** 一覧にないパスで開いたときに、選択欄に一時的に足す項目の value。 */
const CUSTOM_VALUE = '__custom__';

export class DatasetSwitcher {
  private readonly select: HTMLSelectElement;
  private readonly status: HTMLElement;
  private readonly root: HTMLElement;
  private custom: HTMLOptionElement | null = null;
  private loading = false;
  private error: string | null = null;

  constructor(doc: Document, catalog: DatasetCatalog, onSelect: (id: string) => void) {
    this.root = doc.getElementById('dataset-switcher')!;
    this.select = doc.getElementById('dataset-select') as HTMLSelectElement;
    this.status = doc.getElementById('dataset-status')!;
    for (const d of catalog.datasets) {
      const opt = doc.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      this.select.append(opt);
    }
    this.select.value = '';
    this.select.addEventListener('change', () => {
      const id = this.select.value;
      if (!id || id === CUSTOM_VALUE) return;
      // 選んだあとはキー操作（WASD など）がすぐに効くよう、フォーカスを外す
      this.select.blur();
      onSelect(id);
    });
    this.root.hidden = false;
  }

  /** 表示中のデータセット。一覧にないパスで開いたときは id を null、`customDir` にその場所を渡す。 */
  setCurrent(id: string | null, customDir: string | null): void {
    if (id !== null) {
      this.custom?.remove();
      this.custom = null;
      this.select.value = id;
      return;
    }
    if (customDir === null) { this.select.value = ''; return; }
    if (!this.custom) {
      this.custom = this.select.ownerDocument.createElement('option');
      this.custom.value = CUSTOM_VALUE;
      this.select.append(this.custom);
    }
    this.custom.textContent = customDir;
    this.select.value = CUSTOM_VALUE;
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.select.disabled = loading;
    this.root.setAttribute('aria-busy', String(loading));
    this.render();
  }

  setError(message: string | null): void {
    this.error = message;
    this.render();
  }

  private render(): void {
    const text = this.loading ? '読み込み中…' : this.error ?? '';
    if (this.status.textContent !== text) this.status.textContent = text;
    this.status.classList.toggle('error', !this.loading && this.error !== null);
    this.status.hidden = text === '';
  }
}
