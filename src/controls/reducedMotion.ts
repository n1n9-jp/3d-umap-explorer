/**
 * OS・ブラウザの「視差効果を減らす」設定（`prefers-reduced-motion: reduce`）の問い合わせ。
 * `MediaQueryList` を 1 回だけ作り、`change` イベントで値を持ち直す（毎フレーム `matchMedia` を呼ばない）。
 * 設定を途中で切り替えると、`change` が届いた時点で値が変わるので、次のフレームから反映される。
 */

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** 「動きを減らす」設定が有効かを読む口。カメラの各部品は、これを通して設定を読む。 */
export interface ReducedMotionSource {
  readonly reduced: boolean;
}

type MediaQueryListLike = Pick<MediaQueryList, 'matches'> & Partial<Pick<MediaQueryList, 'addEventListener' | 'removeEventListener' | 'addListener' | 'removeListener'>>;

/** OS・ブラウザの「視差効果を減らす」（`prefers-reduced-motion: reduce`）が、いま有効か。判定できなければ false。1 回だけ読む。 */
export function prefersReducedMotion(win: Pick<Window, 'matchMedia'> | null | undefined): boolean {
  try {
    return typeof win?.matchMedia === 'function' && win.matchMedia(REDUCED_MOTION_QUERY).matches === true;
  } catch {
    return false;
  }
}

/**
 * `prefers-reduced-motion: reduce` を見張る。作るときに `matchMedia` を 1 回だけ呼び、`change` イベントで値を持ち直す。
 * `matchMedia` がない環境では、常に false。使い終わったら `dispose` でリスナーを外す。
 */
export class ReducedMotionQuery implements ReducedMotionSource {
  private _reduced = false;
  private mql: MediaQueryListLike | null = null;

  constructor(win: Pick<Window, 'matchMedia'> | null | undefined) {
    try {
      if (typeof win?.matchMedia !== 'function') return;
      const mql = win.matchMedia(REDUCED_MOTION_QUERY) as MediaQueryListLike | null | undefined;
      if (!mql) return;
      this._reduced = mql.matches === true;
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', this.onChange);
      else if (typeof mql.addListener === 'function') mql.addListener(this.onChange); // 古い Safari
      this.mql = mql;
    } catch {
      this._reduced = false;
      this.mql = null;
    }
  }

  /** 「動きを減らす」設定が有効か（直近の `change` イベントまでの値）。 */
  get reduced(): boolean {
    return this._reduced;
  }

  /** `change` のリスナーを外す。そのあとは値を持ち直さない。 */
  dispose(): void {
    const mql = this.mql;
    if (!mql) return;
    this.mql = null;
    try {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', this.onChange);
      else if (typeof mql.removeListener === 'function') mql.removeListener(this.onChange);
    } catch {
      // 外せなくても、mql を手放したので値は使われない
    }
  }

  private readonly onChange = (e: { matches: boolean }): void => {
    this._reduced = e.matches === true;
  };
}
