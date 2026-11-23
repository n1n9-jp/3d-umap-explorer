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

/** 視線の仰角の上限（±89°）。飛行モードの制限と同じで、真上・真下を向いた視点を避ける。 */
export const MAX_VIEW_PITCH = (89 * Math.PI) / 180;

export interface ViewAngles {
  /** +Y まわりの回転（正で左を向く）。 */
  yaw: number;
  /** 水平からの仰角（正で上を向く）。±MAX_VIEW_PITCH に収める。 */
  pitch: number;
}

/**
 * 位置と注視点から、視線の向きを yaw / pitch で求める。仰角は ±MAX_VIEW_PITCH に収める。
 * 位置と注視点が一致して向きが決まらないときは `fallback` を返す。真上・真下を向くときの yaw は `fallback.yaw`。
 */
export function viewAngles(view: ViewSpec, fallback: ViewAngles = { yaw: 0, pitch: 0 }): ViewAngles {
  const x = view.look[0] - view.pos[0];
  const y = view.look[1] - view.pos[1];
  const z = view.look[2] - view.pos[2];
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-12) || !Number.isFinite(len)) return { ...fallback };
  const yaw = Math.hypot(x, z) > 1e-9 * len ? Math.atan2(-x, -z) : fallback.yaw;
  const pitch = Math.min(MAX_VIEW_PITCH, Math.max(-MAX_VIEW_PITCH, Math.asin(Math.min(1, Math.max(-1, y / len)))));
  return { yaw, pitch };
}

/** yaw / pitch から視線方向（単位ベクトル）を求める。`viewAngles` の逆。 */
export function directionFromAngles({ yaw, pitch }: ViewAngles): Vec3 {
  const c = Math.cos(pitch);
  return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
}
