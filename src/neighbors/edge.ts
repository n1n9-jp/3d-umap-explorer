/**
 * 画面の外やカメラの後ろにある近傍の方向を、画面の端の印で示すための計算（DOM と WebGL に依存しない）。
 */

/** 画面の端の印の位置。 */
export interface EdgePlacement {
  /** 画面の中に見えているか（見えていれば印は出さない） */
  onScreen: boolean;
  /** カメラの後ろにあるか */
  behind: boolean;
  /** 印の位置（CSS ピクセル。画面の左上が原点）。onScreen のときは投影した位置 */
  x: number;
  y: number;
  /** 画面の中心から見た方向（ラジアン。右が 0、下が正） */
  angle: number;
}

/** 画面の端からの余白（CSS ピクセル）。 */
export interface EdgeMargins { top: number; right: number; bottom: number; left: number }

/**
 * クリップ座標（x, y, w）の点を、幅 `width`・高さ `height` の画面に置く。画面の外（またはカメラの後ろ）なら、
 * 画面の中心からその方向へ延ばした線と、端から `margin` だけ内側の矩形との交点を返す（中心から見た方向は保つ）。
 * カメラの後ろ（w ≤ 0）の点は、x, y の向きをそのまま方向にする（割ると左右・上下が逆になるため）。真後ろなら下を指す。
 */
export function placeOnEdge(cx: number, cy: number, cw: number, width: number, height: number, margin: number | EdgeMargins): EdgePlacement {
  const m = typeof margin === 'number' ? { top: margin, right: margin, bottom: margin, left: margin } : margin;
  const halfW = width / 2, halfH = height / 2;
  const behind = !(cw > 1e-9);
  let dx: number, dy: number;
  if (!behind) {
    dx = cx / cw;
    dy = cy / cw;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
      const x = halfW + dx * halfW, y = halfH - dy * halfH;
      return { onScreen: true, behind: false, x, y, angle: Math.atan2(y - halfH, x - halfW) };
    }
  } else {
    dx = cx;
    dy = cy;
  }
  // 画面の座標の向き（右・下が正）のベクトル
  let vx = dx * halfW, vy = -dy * halfH;
  if (Math.hypot(vx, vy) < 1e-9) { vx = 0; vy = 1; }
  // 向かう側の端までの距離（余白の分だけ内側）
  const hx = Math.max(0, halfW - (vx >= 0 ? m.right : m.left)), hy = Math.max(0, halfH - (vy >= 0 ? m.bottom : m.top));
  const t = Math.min(Math.abs(vx) > 1e-12 ? hx / Math.abs(vx) : Infinity, Math.abs(vy) > 1e-12 ? hy / Math.abs(vy) : Infinity);
  return { onScreen: false, behind, x: halfW + vx * t, y: halfH + vy * t, angle: Math.atan2(vy, vx) };
}
