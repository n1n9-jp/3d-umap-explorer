/**
 * カメラの近くで文字として描く単語の選び方と、表示の切り替えの不透明度。DOM と WebGL に依存しない。
 *
 * 文字の大きさ: 透視投影のままの画面上の高さ（自然な大きさ。距離に反比例）を、`textSizePx` で、
 * 下限と上限のある緩やかな変化に写す（近い単語が大きくなりすぎず、少し離れた単語も読める。近いほど大きいのは保つ）。
 *
 * 1. 候補（空間索引でカメラの近くから取った点）を、カメラの前・視錐台の内側・近接フェードより外・
 *    自然な文字の高さが `minNaturalPx` 以上のものに絞る。
 * 2. 画面上の矩形（写したあとの大きさ）が、画面からはみ出すものと、障害物（UI の領域など）と重なるものを除く。
 * 3. 近い順に、すでに残した単語と画面上の矩形が重なるものを除き、`maxWords` 個まで残す。
 * 4. フレーム間で安定させる（前回表示していた単語を優先する）:
 *    - 優先の順位は「距離 ×（表示中なら 1 − stickiness）」。距離の順位が入れ替わっても、表示中の単語が残る。
 *    - 新しく出す単語は、ほかの単語と `gapPx` 以上離す。表示中どうしは `stayGapPx` 以上（接するまで）でよい。
 *    - 表示中の単語は、自然な文字の高さ `keepMinNaturalPx`、近接フェードの `keepNearFactor` 倍、視錐台の外へ `keepFrustumMargin`
 *      （基準点と、矩形のはみ出し）まで残す。
 */

/**
 * 画面上の文字の高さ（1 em、CSS ピクセル）の決め方。自然な大きさ n（透視投影のまま）から
 * `clamp(referencePx × (n / referencePx) ^ exponent, minPx, maxPx)`。exponent が 1 未満なら、距離による変化が緩やかになる。
 */
export interface TextSizeParams {
  /** 自然な大きさと写したあとの大きさが等しくなる高さ */
  referencePx: number;
  /** 変化の緩やかさ（1 なら透視投影のまま） */
  exponent: number;
  /** 下限と上限 */
  minPx: number;
  maxPx: number;
}

export const DEFAULT_TEXT_SIZE: TextSizeParams = { referencePx: 16, exponent: 0.5, minPx: 12, maxPx: 26 };

/** 透視投影のままの大きさを写さない設定（検証と比較用）。 */
export const NATURAL_TEXT_SIZE: TextSizeParams = { referencePx: 1, exponent: 1, minPx: 0, maxPx: Infinity };

/** 自然な文字の高さ（CSS ピクセル）から、画面に描く文字の高さを決める。シェーダ（shaders.ts）と同じ式。 */
export function textSizePx(naturalPx: number, p: TextSizeParams): number {
  if (!(naturalPx > 0)) return 0;
  const v = p.referencePx * Math.pow(naturalPx / p.referencePx, p.exponent);
  return Math.min(p.maxPx, Math.max(p.minPx, v));
}

/** 選び方の設定。ピクセルは CSS ピクセル。 */
export interface WordSelectParams {
  /** 表示する単語の数の上限 N */
  maxWords: number;
  /** 新しく出す単語の、自然な文字の高さ（透視投影のままの 1 em）の下限 */
  minNaturalPx: number;
  /** 表示中の単語を出し続ける、自然な文字の高さの下限（minNaturalPx より小さくして、切り替えに幅を持たせる） */
  keepMinNaturalPx: number;
  /** 画面に描く文字の高さの決め方 */
  size: TextSizeParams;
  /** 単語と障害物（UI の領域など）の間隔 */
  obstacleGapPx: number;
  /** 新しく出す単語と、ほかの単語の矩形の間隔 */
  gapPx: number;
  /** 表示中どうしの矩形の間隔（0 なら接するまで） */
  stayGapPx: number;
  /** 表示中の単語を、近さの比較で優遇する割合 */
  stickiness: number;
  /** 表示中の単語を、視錐台の外へどこまで残すか（NDC の余白） */
  keepFrustumMargin: number;
  /** 表示中の単語を、近接フェードの始まりの何倍の距離まで残すか（1 未満） */
  keepNearFactor: number;
}

export const DEFAULT_SELECT_PARAMS: WordSelectParams = {
  maxWords: 200,
  minNaturalPx: 5,
  keepMinNaturalPx: 4.5,
  size: DEFAULT_TEXT_SIZE,
  obstacleGapPx: 4,
  gapPx: 4,
  stayGapPx: 0,
  stickiness: 0.2,
  keepFrustumMargin: 0.05,
  keepNearFactor: 0.85,
};

/** 単語の矩形（em。基準点からの範囲。y は上向き）。縁取りを含める。 */
export interface WordBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 視点（three.js の行列の elements と同じ列優先の 16 要素）と画面の大きさ（CSS ピクセル）。 */
export interface SelectView {
  /** ワールド → ビュー（camera.matrixWorldInverse） */
  view: ArrayLike<number>;
  /** 投影（camera.projectionMatrix） */
  projection: ArrayLike<number>;
  width: number;
  height: number;
}

export interface SelectInput {
  /** 候補の点の番号と位置（ワールド座標。長さ 3 × 候補数） */
  candidates: ArrayLike<number>;
  positions: ArrayLike<number>;
  view: SelectView;
  /** 1 em のワールドでの大きさ */
  emWorld: number;
  /** これより近い単語は出さない（近接フェードの始まりの距離） */
  nearLimit: number;
  /** 単語の矩形。文字のない単語は null */
  box(index: number): WordBox | null;
  /** 前回表示していた単語 */
  shown: ReadonlySet<number>;
  /** 単語を重ねない画面上の領域（UI の要素・目印など。CSS ピクセル） */
  obstacles?: readonly ScreenRect[];
  params: WordSelectParams;
}

/** 画面上の矩形（CSS ピクセル。中心と大きさ）。 */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedWord {
  index: number;
  rect: ScreenRect;
  /** カメラからの距離 */
  distance: number;
  /** 画面に描く文字の高さ（1 em。textSizePx で写したあと） */
  textPx: number;
  /** 透視投影のままの文字の高さ（1 em） */
  naturalPx: number;
  /** 点の中心の画面上の位置 */
  anchorX: number;
  anchorY: number;
}

export interface SelectResult {
  /** 表示する単語（優先の順） */
  words: PlacedWord[];
  /** 条件（視錐台・距離・大きさ）を満たした候補の数 */
  eligible: number;
}

/** 2 つの矩形が、間隔 gap を含めて重なるか。接するだけなら重ならない。 */
export function rectsOverlap(a: ScreenRect, b: ScreenRect, gap = 0): boolean {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap;
}

/** 点をビュー空間と画面へ写す。カメラの後ろなら null。 */
export function projectPoint(v: SelectView, x: number, y: number, z: number):
  { vx: number; vy: number; vz: number; ndcX: number; ndcY: number } | null {
  const m = v.view, p = v.projection;
  const vx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const vy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const vz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  if (vz >= 0) return null;
  const cx = p[0]! * vx + p[4]! * vy + p[8]! * vz + p[12]!;
  const cy = p[1]! * vx + p[5]! * vy + p[9]! * vz + p[13]!;
  const cw = p[3]! * vx + p[7]! * vy + p[11]! * vz + p[15]!;
  if (!(cw > 0)) return null;
  return { vx, vy, vz, ndcX: cx / cw, ndcY: cy / cw };
}

/** 表示する単語を選ぶ。 */
export function selectWords(input: SelectInput): SelectResult {
  const { candidates, positions, view, emWorld, nearLimit, shown, params } = input;
  const obstacles = input.obstacles ?? [];
  const items: (PlacedWord & { rank: number; wasShown: boolean })[] = [];
  const p5 = view.projection[5]!;
  for (let k = 0; k < candidates.length; k++) {
    const i = candidates[k]!;
    const wasShown = shown.has(i);
    const q = projectPoint(view, positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!);
    if (!q) continue;
    const distance = Math.hypot(q.vx, q.vy, q.vz);
    if (distance < nearLimit * (wasShown ? params.keepNearFactor : 1)) continue;
    const margin = wasShown ? params.keepFrustumMargin : 0;
    if (Math.abs(q.ndcX) > 1 + margin || Math.abs(q.ndcY) > 1 + margin) continue;
    const pxPerUnit = 0.5 * view.height * p5 / -q.vz;
    const naturalPx = emWorld * pxPerUnit;
    if (naturalPx < (wasShown ? params.keepMinNaturalPx : params.minNaturalPx)) continue;
    const textPx = textSizePx(naturalPx, params.size);
    const b = input.box(i);
    if (!b) continue;
    const anchorX = (q.ndcX + 1) / 2 * view.width;
    const anchorY = (1 - q.ndcY) / 2 * view.height;
    const rect = {
      x: anchorX + (b.left + b.right) / 2 * textPx,
      y: anchorY - (b.top + b.bottom) / 2 * textPx,
      width: (b.right - b.left) * textPx,
      height: (b.top - b.bottom) * textPx,
    };
    // 新しく出す単語は、画面の端で切れないものだけ。表示中の単語は、矩形のはみ出しが視錐台の余白（画面の半分 × keepFrustumMargin）までなら残す
    const mx = wasShown ? params.keepFrustumMargin * view.width / 2 : 0, my = wasShown ? params.keepFrustumMargin * view.height / 2 : 0;
    if (rect.x - rect.width / 2 < -mx || rect.x + rect.width / 2 > view.width + mx || rect.y - rect.height / 2 < -my || rect.y + rect.height / 2 > view.height + my) continue;
    const og = wasShown ? Math.min(params.stayGapPx, params.obstacleGapPx) : params.obstacleGapPx;
    if (obstacles.some((o) => rectsOverlap(rect, o, og))) continue;
    items.push({ index: i, rect, distance, textPx, naturalPx, anchorX, anchorY, wasShown, rank: wasShown ? distance * (1 - params.stickiness) : distance });
  }
  items.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const kept: typeof items = [];
  for (const it of items) {
    if (kept.length >= params.maxWords) break;
    let clear = true;
    for (const k of kept) {
      const gap = it.wasShown && k.wasShown ? params.stayGapPx : params.gapPx;
      if (rectsOverlap(it.rect, k.rect, gap)) { clear = false; break; }
    }
    if (clear) kept.push(it);
  }
  return {
    words: kept.map(({ index, rect, distance, textPx, naturalPx, anchorX, anchorY }) => ({ index, rect, distance, textPx, naturalPx, anchorX, anchorY })),
    eligible: items.length,
  };
}

/**
 * 不透明度を目標へ近づける（表示する単語は 1、外れた単語は 0 へ、`seconds` 秒で切り替わる速さ）。
 * 0 になった単語は取り除く。変化があれば true。
 */
export function stepOpacities(opacity: Map<number, number>, targets: ReadonlySet<number>, dt: number, seconds: number): boolean {
  const step = seconds > 0 ? dt / seconds : 1;
  let changed = false;
  for (const i of targets) if (!opacity.has(i)) { opacity.set(i, 0); changed = true; }
  for (const [i, a] of opacity) {
    const target = targets.has(i) ? 1 : 0;
    if (a === target) continue;
    const next = target > a ? Math.min(1, a + step) : Math.max(0, a - step);
    changed = true;
    if (next <= 0 && target === 0) opacity.delete(i);
    else opacity.set(i, next);
  }
  return changed;
}
