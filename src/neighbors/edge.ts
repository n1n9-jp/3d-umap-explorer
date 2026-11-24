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

/** 印を重ねない画面上の矩形（CSS ピクセル。x・y は中心）。HUD・ミニマップ・情報パネルなど。 */
export interface EdgeObstacle { x: number; y: number; width: number; height: number }

/** 印の中心から、印の見た目（丸と矢印）の外縁までの距離（CSS ピクセル）。障害物の矩形は、この分だけ広げて避ける */
export const EDGE_MARKER_RADIUS = 18;

/**
 * 印の中心 (x, y) が、広げた障害物の矩形（`pad` だけ外へ）に入らないように、最も近い空いた位置へずらす。
 * 位置は、`bounds`（画面の端から余白の内側）の中で、障害物の矩形の外側の縁（広げたあと）の座標か、元の座標のどちらかを
 * 組み合わせたもの（端に沿ってずらすか、内側へ逃がす）。空いた位置がなければ元の位置を返す。
 */
export function avoidObstacles(
  x: number, y: number, obstacles: readonly EdgeObstacle[], bounds: { left: number; top: number; right: number; bottom: number }, pad: number,
): { x: number; y: number } {
  const eps = 0.5;
  const blocked = (px: number, py: number): boolean => {
    for (const r of obstacles) {
      if (Math.abs(px - r.x) < r.width / 2 + pad && Math.abs(py - r.y) < r.height / 2 + pad) return true;
    }
    return false;
  };
  if (!blocked(x, y)) return { x, y };
  const xs = [x], ys = [y];
  for (const r of obstacles) {
    xs.push(r.x - r.width / 2 - pad - eps, r.x + r.width / 2 + pad + eps);
    ys.push(r.y - r.height / 2 - pad - eps, r.y + r.height / 2 + pad + eps);
  }
  let best: { x: number; y: number } | null = null, bestD = Infinity;
  for (const cx of xs) {
    if (cx < bounds.left || cx > bounds.right) continue;
    for (const cy of ys) {
      if (cy < bounds.top || cy > bounds.bottom) continue;
      const d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
      if (d < bestD && !blocked(cx, cy)) { bestD = d; best = { x: cx, y: cy }; }
    }
  }
  return best ?? { x, y };
}

/**
 * クリップ座標（x, y, w）の点を、幅 `width`・高さ `height` の画面に置く。画面の外（またはカメラの後ろ）なら、
 * 画面の中心からその方向へ延ばした線と、端から `margin` だけ内側の矩形との交点を返す（中心から見た方向は保つ）。
 * カメラの後ろ（w ≤ 0）の点は、x, y の向きをそのまま方向にする（割ると左右・上下が逆になるため）。真後ろなら下を指す。
 * `obstacles` を渡すと、印の位置が障害物の矩形（印の大きさ `EDGE_MARKER_RADIUS` の分だけ広げたもの）に重なるとき、
 * その矩形の外側の縁へずらす（`avoidObstacles`）。矢印の向き（angle）は、ずらしても画面の中心から見た方向のまま。
 */
export function placeOnEdge(
  cx: number, cy: number, cw: number, width: number, height: number, margin: number | EdgeMargins, obstacles?: readonly EdgeObstacle[],
): EdgePlacement {
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
  let x = halfW + vx * t, y = halfH + vy * t;
  if (obstacles && obstacles.length > 0) {
    ({ x, y } = avoidObstacles(x, y, obstacles, { left: m.left, top: m.top, right: width - m.right, bottom: height - m.bottom }, EDGE_MARKER_RADIUS));
  }
  return { onScreen: false, behind, x, y, angle: Math.atan2(vy, vx) };
}
