import { bindShortcut } from './keyEvents';

/** T キーで速度の自動調整の有効・無効を切り替える。 */

export const AUTO_SPEED_KEY_CODE = 'KeyT';

interface Toggleable {
  toggleAutoSpeed(): void;
}

/** `win` の keydown で T を受けて `rig.toggleAutoSpeed()` を呼ぶ。返す関数でリスナーを外す。 */
export function bindAutoSpeedKey(win: Pick<Window, 'addEventListener' | 'removeEventListener'>, rig: Toggleable): () => void {
  return bindShortcut(win, AUTO_SPEED_KEY_CODE, () => rig.toggleAutoSpeed());
}
