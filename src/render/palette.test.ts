import { describe, expect, it } from 'vitest';
import { BACKGROUND_COLOR, LABEL_COLORS, hexToRgb, labelColors } from './palette';
import { INTERIOR_FOG } from './fog';

// ---------- 色覚の模擬と色差の計算（テスト用の実装） ----------

type Rgb = [number, number, number];
type Lab = [number, number, number];
type Matrix = readonly [Rgb, Rgb, Rgb];
type Vision = 'normal' | 'protan' | 'deutan' | 'tritan';

/**
 * 色覚の模擬に使う 3x3 行列（線形 sRGB に左から掛ける）。重度（severity 1.0）。
 * 1型（protan）・2型（deutan）・3型（tritan）に対応する。
 *
 * 出典：Machado, G. M., Oliveira, M. M., Fernandes, L. A. F. (2009).
 * "A Physiologically-based Model for Simulation of Color Vision Deficiency".
 * IEEE Transactions on Visualization and Computer Graphics 15(6), 1291-1298. doi:10.1109/TVCG.2009.113
 * 事前計算された行列は著者のページ（https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html）で
 * 公開されている。ここでは、同じ値を収録している colour-science の
 * colour/blindness/datasets/machado2010.py（severity 1.0 の項目）の値を使った。
 */
const MACHADO_2009_SEVERITY_1: Record<Vision, Matrix> = {
  normal: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
const VISIONS = Object.keys(MACHADO_2009_SEVERITY_1) as Vision[];

/** sRGB のガンマを外して線形にする（IEC 61966-2-1）。 */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** '#rrggbb' を線形 sRGB にする。 */
function hexToLinear(hex: string): Rgb {
  const [r, g, b] = hexToRgb(hex);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

/** 線形 sRGB（範囲外は 0..1 に切る）を CIELAB（D65）にする。 */
function linearToLab([r, g, b]: Rgb): Lab {
  const [lr, lg, lb] = [r, g, b].map((v) => Math.min(1, Math.max(0, v))) as Rgb;
  const x = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = 0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x / 0.95047);
  const fy = f(y);
  const fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** その色覚で見えるときの色を CIELAB で返す。 */
function simulate(hex: string, vision: Vision): Lab {
  const m = MACHADO_2009_SEVERITY_1[vision];
  const [r, g, b] = hexToLinear(hex);
  return linearToLab(m.map((row) => row[0] * r + row[1] * g + row[2] * b) as Rgb);
}

/** CIE76 の色差 ΔE*ab。 */
function deltaE76(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** WCAG 2 の相対輝度。 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 のコントラスト比（1..21）。 */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

interface Closest {
  delta: number;
  i: number;
  j: number;
}

/** colors のうち最も近い2色の組。 */
function closestPair(colors: readonly string[], measure: (a: string, b: string) => number): Closest {
  let best: Closest = { delta: Infinity, i: -1, j: -1 };
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const delta = measure(colors[i] as string, colors[j] as string);
      if (delta < best.delta) best = { delta, i, j };
    }
  }
  return best;
}

const pairDeltaE = (vision: Vision) => (a: string, b: string) => deltaE76(simulate(a, vision), simulate(b, vision));

/** 明るさ（L*）を無視した、a*b* 平面上の距離。明るさの違いだけに頼らない色の違いの目安。 */
function chromaDistance(a: string, b: string): number {
  const la = simulate(a, 'normal');
  const lb = simulate(b, 'normal');
  return Math.hypot(la[1] - lb[1], la[2] - lb[2]);
}

// ---------- 条件 ----------

const MIN_DELTA_E = 12;
const MIN_CONTRAST = 4.5;
/** 通常の色覚で、明るさを除いた色の違い（a*b* 平面での距離）の下限。白（無彩色）と淡い色の間もこれ以上離れている。 */
const MIN_CHROMA_DISTANCE = 15;

/** 変更前の配色。模擬の実装が、コードレビューで測った値と合うことの確認に使う。 */
const PREVIOUS_COLORS = [
  '#ff5a5a', '#ff9d2e', '#ffe45c', '#8fe04a', '#2fd9b5', '#4fa8ff', '#a98bff', '#ff6fd0', '#f0f0f0', '#c79a6b',
] as const;

describe('palette', () => {
  it('hexToRgb は 0..1 の値を返す', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(() => hexToRgb('red')).toThrow();
  });
  it('10色はすべて異なり、暗い背景で見えるだけの明るさがある', () => {
    expect(LABEL_COLORS).toHaveLength(10);
    expect(new Set(LABEL_COLORS).size).toBe(10);
    for (const c of LABEL_COLORS) {
      const [r, g, b] = hexToRgb(c);
      expect(0.299 * r + 0.587 * g + 0.114 * b).toBeGreaterThan(0.4);
    }
  });
  it('10色を超える分は繰り返す', () => {
    expect(labelColors(12)[10]).toEqual(labelColors(1)[0]);
  });

  describe.each(VISIONS)('色覚の多様性: %s', (vision) => {
    it(`どの2色も ΔE76 が ${MIN_DELTA_E} 以上`, () => {
      const { delta, i, j } = closestPair(LABEL_COLORS, pairDeltaE(vision));
      expect(delta, `${vision}: 色${i}(${LABEL_COLORS[i]}) と 色${j}(${LABEL_COLORS[j]})`).toBeGreaterThanOrEqual(MIN_DELTA_E);
    });
  });

  it(`背景色とのコントラスト比（WCAG）がすべて ${MIN_CONTRAST} 以上`, () => {
    LABEL_COLORS.forEach((c, i) => {
      expect(contrastRatio(c, BACKGROUND_COLOR), `色${i}(${c})`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  });

  it(`通常の色覚で、明るさを除いた色の違い（a*b*）が ${MIN_CHROMA_DISTANCE} 以上離れている`, () => {
    const { delta, i, j } = closestPair(LABEL_COLORS, chromaDistance);
    expect(delta, `色${i}(${LABEL_COLORS[i]}) と 色${j}(${LABEL_COLORS[j]})`).toBeGreaterThanOrEqual(MIN_CHROMA_DISTANCE);
  });
});

/**
 * 霧で背景色へ割合 f だけ溶かした色。シェーダと同じく sRGB の値（ガンマ補正後）のまま線形に混ぜる
 * （fragmentShader の mix(color, uBackground, vFog)。カラーマネジメントは無効で、値をそのまま出力する）。
 */
function fogged(hex: string, f: number): string {
  const c = hexToRgb(hex);
  const bg = hexToRgb(BACKGROUND_COLOR);
  const v = c.map((x, k) => Math.round(255 * (x + ((bg[k] as number) - x) * f)));
  return `#${v.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

describe('霧で溶けた色', () => {
  const fogMax = INTERIOR_FOG[2];
  it('霧の上限は 0 より大きく 1 未満', () => {
    expect(fogMax).toBeGreaterThan(0);
    expect(fogMax).toBeLessThan(1);
  });
  describe.each(VISIONS)('色覚の多様性: %s', (vision) => {
    it(`霧の上限（${fogMax}）まで溶けた色でも、どの2色も ΔE76 が ${MIN_DELTA_E} 以上`, () => {
      const colors = LABEL_COLORS.map((c) => fogged(c, fogMax));
      const { delta, i, j } = closestPair(colors, pairDeltaE(vision));
      expect(delta, `${vision}: 色${i}(${colors[i]}) と 色${j}(${colors[j]})`).toBeGreaterThanOrEqual(MIN_DELTA_E);
    });
  });
  it('変更前の霧の上限 0.75 では、コードレビューで測った 6〜8 まで下がる（模擬と混色の実装の確認）', () => {
    const colors = LABEL_COLORS.map((c) => fogged(c, 0.75));
    const mins = VISIONS.map((v) => closestPair(colors, pairDeltaE(v)).delta);
    expect(Math.min(...mins)).toBeGreaterThan(5.5);
    expect(Math.max(...mins)).toBeLessThan(8.5);
  });
});

describe('色覚の模擬と色差の計算', () => {
  it('通常の色覚では白は L*=100、黒は L*=0、白と黒の ΔE76 は 100', () => {
    const white = simulate('#ffffff', 'normal');
    const black = simulate('#000000', 'normal');
    expect(white[0]).toBeCloseTo(100, 1);
    expect(white[1]).toBeCloseTo(0, 1);
    expect(white[2]).toBeCloseTo(0, 1);
    expect(black[0]).toBeCloseTo(0, 5);
    expect(deltaE76(white, black)).toBeCloseTo(100, 1);
  });
  it('どの型でも無彩色は無彩色のまま（行列の各行の和が 1）', () => {
    for (const v of VISIONS) {
      const gray = simulate('#808080', v);
      expect(Math.hypot(gray[1], gray[2]), v).toBeLessThan(0.5);
    }
  });
  it('コントラスト比は白と黒で 21、同色で 1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });
  it('変更前の配色で、コードレビューで測った色差が再現される', () => {
    const delta = (vision: Vision, i: number, j: number) =>
      deltaE76(simulate(PREVIOUS_COLORS[i], vision), simulate(PREVIOUS_COLORS[j], vision));
    expect(delta('deutan', 5, 6)).toBeCloseTo(0.5, 1); // 青と紫
    expect(delta('deutan', 0, 9)).toBeCloseTo(9.0, 0); // 赤と茶
    expect(delta('protan', 2, 3)).toBeCloseTo(5.9, 1); // 黄と黄緑
    expect(closestPair(PREVIOUS_COLORS, pairDeltaE('deutan')).delta).toBeLessThan(MIN_DELTA_E);
  });
});
