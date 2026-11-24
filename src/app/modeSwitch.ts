/**
 * 左上のカメラのモードの表示（2 択の切り替え）。要素は index.html にある（#mode-switch、#mode-live）。
 * 「俯瞰」と「飛行」を並べ、いまのモードを強調する。クリック・タップ・Enter・Space でそのモードへ切り替え、
 * 矢印キーで選択を移す（ラジオボタンの 2 択と同じ操作）。モードの持ち主は `CameraRig` で、この表示は
 * `set(mode)` で追従するだけ（O キー・クリック・点へ飛ぶ操作による自動の切り替えのすべてで、同じ経路を通る）。
 *
 * Tab の順には、選択中のボタンだけを入れる（tabindex="0"。もう一方は -1）。ラジオグループと同じく、Tab で止まるのは 1 回で、
 * 選択の移動は矢印キーで行う。
 *
 * 切り替えのボタンにフォーカスがある間は、移動キー（WASD・E・Q・矢印）をカメラの操作へ渡さない
 * （入力欄にフォーカスがある間に移動キーが働かないのと同じ扱い。`src/app/keyEvents.ts`）。
 */
import type { CameraMode } from './cameraRig';
import { MODE_LABEL } from './hud';

/** 表示の並び（左から）。 */
export const MODE_ORDER: readonly CameraMode[] = ['overview', 'fly'];

/** それぞれのモードが何をするものかの短い説明。 */
export const MODE_DESCRIPTION: Record<CameraMode, string> = {
  overview: '外から回して眺める',
  fly: '中へ入って飛ぶ',
};

export interface ModeOptionView {
  mode: CameraMode;
  label: string;
  description: string;
  /** いまのモードか（強調する・aria-checked） */
  checked: boolean;
  /**
   * ラジオグループの作法（roving tabindex）。選択中のボタンだけを Tab の順に入れ（0）、もう一方は外す（-1）。
   * 移動は矢印キーで行う。
   */
  tabIndex: 0 | -1;
}

export interface ModeSwitchView {
  mode: CameraMode;
  options: ModeOptionView[];
  /** 切り替わったときに読み上げる文 */
  announcement: string;
}

/** 読み上げの文（例: `カメラのモード: 飛行（中へ入って飛ぶ）`）。 */
export function modeAnnouncement(mode: CameraMode): string {
  return `カメラのモード: ${MODE_LABEL[mode]}（${MODE_DESCRIPTION[mode]}）`;
}

/** いまのモードから、表示の状態を決める。 */
export function modeSwitchView(mode: CameraMode): ModeSwitchView {
  return {
    mode,
    options: MODE_ORDER.map((m) => ({ mode: m, label: MODE_LABEL[m], description: MODE_DESCRIPTION[m], checked: m === mode, tabIndex: m === mode ? 0 : -1 })),
    announcement: modeAnnouncement(mode),
  };
}

/** カメラの移動キー（`FlyCameraControls` の移動キーと同じ）。切り替えのボタンの上では、カメラの操作へ渡さない。 */
const MOVE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export type ModeKeyAction =
  /** そのモードを選んで、そのボタンへフォーカスを移す（矢印・Home・End） */
  | { kind: 'select'; mode: CameraMode }
  /** 何もしないが、カメラの操作へは渡さない（WASD・E・Q） */
  | { kind: 'contain' }
  /** 何もしない（ほかのキーは、いつもどおりショートカットとして働く） */
  | null;

/**
 * 切り替えのボタン（`focused` のモードのボタン）で押されたキーの扱い。矢印キーは選択を移し（左・上で前へ、右・下で次へ。端では反対の端へ）、
 * WASD・E・Q はカメラを動かさない。修飾キーつきはブラウザに任せる。
 */
export function modeSwitchKey(e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>, focused: CameraMode): ModeKeyAction {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const i = MODE_ORDER.indexOf(focused);
  const n = MODE_ORDER.length;
  const at = (k: number): ModeKeyAction => ({ kind: 'select', mode: MODE_ORDER[((k % n) + n) % n]! });
  switch (e.key) {
    case 'ArrowLeft': case 'ArrowUp': return at(i - 1);
    case 'ArrowRight': case 'ArrowDown': return at(i + 1);
    case 'Home': return at(0);
    case 'End': return at(n - 1);
    default: break;
  }
  return MOVE_CODES.has(e.code) ? { kind: 'contain' } : null;
}

/** 検証用の状態（`window.__explorer.modeSwitch.getState()`）。 */
export interface ModeSwitchState {
  /** 表示が示しているモード（まだ表示していなければ null） */
  mode: CameraMode | null;
  /** aria-checked が true のボタンのモード */
  checked: CameraMode[];
  /** tabindex が 0（Tab の順に入っている）のボタンのモード */
  tabStops: CameraMode[];
  /** 読み上げの領域の文（切り替わるまでは空） */
  announcement: string;
}

export class ModeSwitch {
  private readonly root: HTMLElement;
  private readonly buttons: Map<CameraMode, HTMLButtonElement>;
  private readonly live: HTMLElement | null;
  private shown: CameraMode | null = null;

  /** `onSelect(mode)` は、利用者がモードを選んだときに呼ぶ（同じモードを選んでも呼ばない）。 */
  constructor(doc: Document, private readonly onSelect: (mode: CameraMode) => void) {
    const root = doc.getElementById('mode-switch');
    if (!root) throw new Error('#mode-switch がありません');
    this.root = root;
    this.live = doc.getElementById('mode-live');
    this.buttons = new Map();
    for (const m of MODE_ORDER) {
      const b = root.querySelector<HTMLButtonElement>(`button[data-mode="${m}"]`);
      if (!b) throw new Error(`#mode-switch に ${m} のボタンがありません`);
      this.buttons.set(m, b);
      b.addEventListener('click', (e) => {
        this.choose(m);
        // マウス・タップで選んだあとは、移動キーがすぐに効くようフォーカスを外す（キーボードで押したときはフォーカスを残す）
        if (e.detail > 0) b.blur();
      });
      b.addEventListener('keydown', (e) => this.onKeyDown(e, m));
    }
  }

  /** 表示をいまのモードへ合わせる。前に表示していたモードから変わったときは、読み上げにも知らせる。 */
  set(mode: CameraMode): void {
    if (mode === this.shown) return;
    const first = this.shown === null;
    this.shown = mode;
    const view = modeSwitchView(mode);
    for (const o of view.options) {
      const b = this.buttons.get(o.mode)!;
      b.setAttribute('aria-checked', String(o.checked));
      b.tabIndex = o.tabIndex;
    }
    this.root.dataset.mode = mode;
    if (!first && this.live) this.live.textContent = view.announcement;
  }

  getState(): ModeSwitchState {
    return {
      mode: this.shown,
      checked: MODE_ORDER.filter((m) => this.buttons.get(m)!.getAttribute('aria-checked') === 'true'),
      tabStops: MODE_ORDER.filter((m) => this.buttons.get(m)!.tabIndex === 0),
      announcement: this.live?.textContent ?? '',
    };
  }

  private choose(mode: CameraMode): void {
    if (mode !== this.shown) this.onSelect(mode);
  }

  private onKeyDown(e: KeyboardEvent, focused: CameraMode): void {
    const action = modeSwitchKey(e, focused);
    if (!action) return;
    e.stopPropagation(); // カメラの操作（window の keydown）へ渡さない
    if (action.kind === 'contain') return;
    e.preventDefault();
    this.buttons.get(action.mode)!.focus();
    this.choose(action.mode);
  }
}
