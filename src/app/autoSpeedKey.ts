/** T キーで速度の自動調整の有効・無効を切り替える。 */

export const AUTO_SPEED_KEY_CODE = 'KeyT';

interface Toggleable {
  toggleAutoSpeed(): void;
}

function isEditable(target: EventTarget | null): boolean {
  const t = target as Partial<HTMLElement> | null;
  if (!t || typeof t.tagName !== 'string') return false;
  return t.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName.toUpperCase());
}

/** `win` の keydown で T を受けて `rig.toggleAutoSpeed()` を呼ぶ。返す関数でリスナーを外す。 */
export function bindAutoSpeedKey(win: Pick<Window, 'addEventListener' | 'removeEventListener'>, rig: Toggleable): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== AUTO_SPEED_KEY_CODE || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target)) return;
    rig.toggleAutoSpeed();
  };
  win.addEventListener('keydown', onKeyDown);
  return () => win.removeEventListener('keydown', onKeyDown);
}
