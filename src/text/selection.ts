/**
 * カメラの近くで文字として描く単語の選び方と、表示の切り替えの不透明度。DOM と WebGL に依存しない。
 *
 * 1. 候補（空間索引でカメラの近くから取った点）を、カメラの前・視錐台の内側・近接フェードより外・
 *    画面上の文字の高さが `minTextPx` 以上のものに絞る。
 * 2. 近い順に、すでに残した単語と画面上の矩形が重なるものを除き、`maxWords` 個まで残す。
 * 3. フレーム間で安定させる（前回表示していた単語を優先する）:
 *    - 優先の順位は「距離 ×（表示中なら 1 − stickiness）」。距離の順位が入れ替わっても、表示中の単語が残る。
 *    - 新しく出す単語は、ほかの単語と `gapPx` 以上離す。表示中どうしは `stayGapPx` 以上（接するまで）でよい。
 *    - 表示中の単語は、文字の高さ `keepMinTextPx`、近接フェードの `keepNearFactor` 倍、視錐台の外へ `keepFrustumMargin` まで残す。
 */

/** 選び方の設定。ピクセルは CSS ピクセル。 */
export interface WordSelectParams {
  /** 表示する単語の数の上限 N */
  maxWords: number;
  /** 新しく出す単語の、画面上の文字の高さ（1 em）の下限 */
  minTextPx: number;
  /** 表示中の単語を出し続ける、文字の高さの下限（minTextPx より小さくして、切り替えに幅を持たせる） */
  keepMinTextPx: number;
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
  minTextPx: 9,
  keepMinTextPx: 8,
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
  /** 画面上の文字の高さ（1 em） */
  textPx: number;
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
    const textPx = emWorld * pxPerUnit;
    if (textPx < (wasShown ? params.keepMinTextPx : params.minTextPx)) continue;
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
    items.push({ index: i, rect, distance, textPx, anchorX, anchorY, wasShown, rank: wasShown ? distance * (1 - params.stickiness) : distance });
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
    words: kept.map(({ index, rect, distance, textPx, anchorX, anchorY }) => ({ index, rect, distance, textPx, anchorX, anchorY })),
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
