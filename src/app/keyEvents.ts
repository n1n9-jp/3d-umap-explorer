/**
 * キーボードショートカットの共通の判定。入力欄でのタイピングをショートカットとして扱わないために、
 * どのキーも同じ方式（`composedPath()` の先頭＝実際の発生元）で入力欄かどうかを決める。
 * シャドウ DOM の中で発生したイベントは、外側のリスナーから見ると `target` がシャドウホストに付け替えられる。
 * 飛行カメラ操作（`src/controls/FlyCameraControls.ts`）の判定と同じ規則。
 */

/** イベントの発生元の要素。`composedPath` が無い・空のときは `target`。 */
export function eventOrigin(e: Event): EventTarget | null {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  return path[0] ?? e.target ?? null;
}

/** 文字入力を受ける要素（input / textarea / select / contenteditable）か。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  const ce = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
  return ce !== null && ce !== undefined && ce.toLowerCase() !== 'false';
}

/** イベントが入力欄の中で起きたか。 */
export function isFromEditable(e: Event): boolean {
  return isEditableTarget(eventOrigin(e));
}

/**
 * 修飾キーなし・押しっぱなしの繰り返しでない・入力欄の外で押された、`code` のキー。
 * 1 回の押下につき 1 度だけ動かすショートカット（O・T・H など）の判定に使う。
 */
export function isShortcutPress(e: KeyboardEvent, code: string): boolean {
  if (e.code !== code || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  return !isFromEditable(e);
}

/** AltGr（Alt Graph）が押されているか。Windows では Ctrl + Alt としても報告されるので、`getModifierState` で見分ける。 */
function isAltGraph(e: KeyboardEvent): boolean {
  return typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
}

/**
 * `key`（入力された文字）が `char` の押下か。配列によって文字を打つキーの位置が違う記号（`?` など）のショートカットに使う。
 * Shift は問わない（その配列で `char` を打つのに要るなら付いている）。AltGr は許す（配列によっては `char` を打つのに要る）。
 * Ctrl・Meta、AltGr ではない Alt、リピート、変換中（IME）、入力欄の中は受けない。
 */
export function isCharacterPress(e: KeyboardEvent, char: string): boolean {
  if (e.key !== char || e.repeat || e.isComposing || e.metaKey) return false;
  if (!isAltGraph(e) && (e.ctrlKey || e.altKey)) return false;
  return !isFromEditable(e);
}

type KeyTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/** `win` の keydown で `code` のショートカットを受けて `handler` を呼ぶ。返す関数でリスナーを外す。 */
export function bindShortcut(win: KeyTarget, code: string, handler: () => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (isShortcutPress(e, code)) handler();
  };
  win.addEventListener('keydown', onKeyDown);
  return () => win.removeEventListener('keydown', onKeyDown);
}
