/** カメラの位置と注視点。URL パラメータ ?pos=x,y,z&look=x,y,z で共有できる。 */

export type Vec3 = [number, number, number];

export interface ViewSpec {
  pos: Vec3;
  look: Vec3;
}

export const DEFAULT_VIEW: ViewSpec = { pos: [0, 0, 2.6], look: [0, 0, 0] };

export function parseVec3(text: string | null): Vec3 | null {
  if (text === null) return null;
  const parts = text.split(',').map((s) => s.trim());
  if (parts.length !== 3 || parts.some((s) => s === '')) return null;
  const v = parts.map(Number);
  if (!v.every(Number.isFinite)) return null;
  return v as Vec3;
}

/** クエリ文字列から視点を読む。look だけ・pos だけの指定も受け付ける。 */
export function parseView(search: string, fallback: ViewSpec = DEFAULT_VIEW): ViewSpec {
  const q = new URLSearchParams(search);
  const pos = parseVec3(q.get('pos')) ?? fallback.pos;
  let look = parseVec3(q.get('look')) ?? fallback.look;
  if (look[0] === pos[0] && look[1] === pos[1] && look[2] === pos[2]) {
    // 位置と注視点が同じだと向きが決まらないので、少し奥を見る
    look = [pos[0], pos[1], pos[2] - 1];
  }
  return { pos: [...pos], look: [...look] };
}

/** 小数点以下の桁を丸めて URL 用の文字列にする。 */
export function formatView(view: ViewSpec, digits = 4): string {
  const f = (v: Vec3) => v.map((x) => Number(x.toFixed(digits))).join(',');
  return `pos=${f(view.pos)}&look=${f(view.look)}`;
}

/** 正の数のクエリパラメータを読む（不正なら null）。 */
export function parsePositiveNumber(search: string, key: string): number | null {
  const raw = new URLSearchParams(search).get(key);
  if (raw === null) return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}
